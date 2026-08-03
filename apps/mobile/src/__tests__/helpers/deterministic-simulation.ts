import assert from 'node:assert/strict';

export interface SimulationCheckpoint<State> {
  label: string;
  state: State;
  trace: string[];
}

export interface SimulationEvent<State> {
  label: string;
  run: (simulation: DeterministicSimulation<State>) => void | Promise<void>;
}

type Invariant<State> = (checkpoint: SimulationCheckpoint<State>) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface TaskRecord {
  promise: Promise<void>;
  failed: boolean;
  error: unknown;
}

interface TaskFailure {
  label: string;
  error: unknown;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function printable(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (typeof item === 'function') {
          return `[Function ${item.name || 'anonymous'}]`;
        }
        if (typeof item === 'bigint') {
          return `${item}n`;
        }
        if (typeof item === 'symbol') {
          return String(item);
        }
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) {
            return '[Circular]';
          }
          seen.add(item);
        }
        return item;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

function diagnosticClone<State>(value: State): State {
  try {
    return structuredClone(value);
  } catch (cloneError) {
    const preview = printable(value);
    try {
      return JSON.parse(preview) as State;
    } catch {
      return {
        snapshotUnavailable: true,
        cloneError: cloneError instanceof Error ? cloneError.message : String(cloneError),
        preview,
      } as State;
    }
  }
}

export class SimulationFailure<State> extends Error {
  readonly checkpoint: SimulationCheckpoint<State>;
  readonly seed: number | null;

  constructor(
    cause: unknown,
    checkpoint: SimulationCheckpoint<State>,
    seed: number | null,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const seedLine = seed === null ? '' : `\nseed: ${seed}`;
    super(
      `${reason}${seedLine}\ncheckpoint: ${checkpoint.label}\ntrace:\n${checkpoint.trace
        .map((entry, index) => `  ${index + 1}. ${entry}`)
        .join('\n')}\nstate:\n${printable(checkpoint.state)}`,
      { cause },
    );
    this.name = 'SimulationFailure';
    this.checkpoint = checkpoint;
    this.seed = seed;
  }
}

/**
 * A small deterministic scheduler for ordering-sensitive sync tests.
 *
 * Production work can pause at named barriers while the test advances other
 * events. No wall-clock sleeps are needed, and every state transition records
 * a trace plus an invariant-checked snapshot.
 */
export class DeterministicSimulation<State> {
  readonly checkpoints: SimulationCheckpoint<State>[] = [];
  readonly trace: string[] = [];

  private readonly barriers = new Map<
    string,
    { reached: Deferred<void>; released: Deferred<void>; didReach: boolean; didRelease: boolean }
  >();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly taskFailure = deferred<TaskFailure>();

  constructor(
    private readonly snapshot: () => State,
    private readonly invariant: Invariant<State> = () => {},
    readonly seed: number | null = null,
    private readonly timeoutMs = 1_000,
  ) {}

  async step(label: string, action: () => void | Promise<void>): Promise<void> {
    this.trace.push(`step:${label}:start`);
    try {
      await action();
      this.trace.push(`step:${label}:complete`);
      this.capture(label);
    } catch (error) {
      throw this.failure(error, label);
    }
  }

  spawn(label: string, action: () => void | Promise<void>): void {
    assert.equal(this.tasks.has(label), false, `simulation task already exists: ${label}`);
    const record: TaskRecord = { promise: Promise.resolve(), failed: false, error: undefined };
    this.trace.push(`task:${label}:start`);
    record.promise = Promise.resolve()
      .then(action)
      .then(() => {
        this.trace.push(`task:${label}:complete`);
        this.capture(`task:${label}`);
      })
      .catch((error: unknown) => {
        record.failed = true;
        record.error = error;
        this.trace.push(`task:${label}:failed`);
        this.taskFailure.resolve({ label, error });
      });
    this.tasks.set(label, record);
  }

  async join(label: string): Promise<void> {
    const record = this.tasks.get(label);
    assert.ok(record, `simulation task does not exist: ${label}`);
    await this.withTimeout(
      record.promise,
      `task:${label}`,
      `simulation task did not settle within ${this.timeoutMs}ms: ${label}${this.unreleasedBarrierSummary()}`,
    );
    this.tasks.delete(label);
    if (record.failed) {
      throw this.failure(record.error, `task:${label}`);
    }
  }

  async finish(): Promise<void> {
    while (this.tasks.size > 0) {
      const label = this.tasks.keys().next().value;
      assert.ok(label, 'simulation task map contained an invalid label');
      await this.join(label);
    }
    this.capture('finish');
  }

  /** Called by a fake dependency when it reaches an ordering boundary. */
  async waitAt(barrierName: string): Promise<void> {
    const barrier = this.getBarrier(barrierName);
    assert.equal(barrier.didReach, false, `barrier reached more than once: ${barrierName}`);
    barrier.didReach = true;
    this.trace.push(`barrier:${barrierName}:reached`);
    this.capture(`barrier:${barrierName}`);
    barrier.reached.resolve(undefined);
    await this.withTimeout(
      barrier.released.promise,
      `barrier:${barrierName}`,
      `simulation barrier was not released within ${this.timeoutMs}ms: ${barrierName}`,
    );
    this.trace.push(`barrier:${barrierName}:passed`);
  }

  /** Called by the test to wait until a fake dependency is definitely paused. */
  async waitUntilReached(barrierName: string): Promise<void> {
    const result = await this.withTimeout(
      Promise.race([
        this.getBarrier(barrierName).reached.promise.then(() => null),
        this.taskFailure.promise,
      ]),
      `barrier:${barrierName}`,
      `simulation barrier was not reached within ${this.timeoutMs}ms: ${barrierName}`,
    );
    if (result !== null) {
      throw this.failure(result.error, `task:${result.label}`);
    }
  }

  release(barrierName: string): void {
    const barrier = this.getBarrier(barrierName);
    assert.equal(barrier.didReach, true, `barrier released before it was reached: ${barrierName}`);
    assert.equal(barrier.didRelease, false, `barrier released more than once: ${barrierName}`);
    barrier.didRelease = true;
    this.trace.push(`barrier:${barrierName}:released`);
    barrier.released.resolve(undefined);
  }

  private getBarrier(name: string) {
    let barrier = this.barriers.get(name);
    if (!barrier) {
      barrier = {
        reached: deferred<void>(),
        released: deferred<void>(),
        didReach: false,
        didRelease: false,
      };
      this.barriers.set(name, barrier);
    }
    return barrier;
  }

  private capture(label: string): void {
    const liveCheckpoint: SimulationCheckpoint<State> = {
      label,
      state: this.snapshot(),
      trace: [...this.trace],
    };
    try {
      this.invariant(liveCheckpoint);
    } catch (error) {
      throw new SimulationFailure(
        error,
        { ...liveCheckpoint, state: diagnosticClone(liveCheckpoint.state) },
        this.seed,
      );
    }

    try {
      const checkpoint = {
        ...liveCheckpoint,
        state: structuredClone(liveCheckpoint.state),
      };
      this.checkpoints.push(checkpoint);
    } catch (error) {
      throw new SimulationFailure(
        error,
        { ...liveCheckpoint, state: diagnosticClone(liveCheckpoint.state) },
        this.seed,
      );
    }
  }

  private failure(error: unknown, label: string): SimulationFailure<State> {
    if (error instanceof SimulationFailure) {
      return error;
    }
    return new SimulationFailure(
      error,
      { label, state: diagnosticClone(this.snapshot()), trace: [...this.trace] },
      this.seed,
    );
  }

  private async withTimeout<T>(promise: Promise<T>, label: string, message: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(this.failure(new Error(message), label)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private unreleasedBarrierSummary(): string {
    const names = [...this.barriers.entries()]
      .filter(([, barrier]) => barrier.didReach && !barrier.didRelease)
      .map(([name]) => name);
    return names.length === 0 ? '' : `; unreleased barriers: ${names.join(', ')}`;
  }
}

/** Mulberry32: compact, deterministic, and sufficient for event-order generation. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededEventOrder<State>(
  events: readonly SimulationEvent<State>[],
  seed: number,
): SimulationEvent<State>[] {
  const random = seededRandom(seed);
  const ordered = [...events];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [ordered[index], ordered[swapIndex]] = [ordered[swapIndex]!, ordered[index]!];
  }
  return ordered;
}

export async function runSeededEvents<State>(
  simulation: DeterministicSimulation<State>,
  events: readonly SimulationEvent<State>[],
): Promise<void> {
  assert.notEqual(simulation.seed, null, 'runSeededEvents requires a simulation seed');
  for (const event of seededEventOrder(events, simulation.seed!)) {
    await simulation.step(event.label, () => event.run(simulation));
  }
  await simulation.finish();
}
