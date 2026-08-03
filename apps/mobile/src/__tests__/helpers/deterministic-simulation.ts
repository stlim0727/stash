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
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
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

  constructor(
    private readonly snapshot: () => State,
    private readonly invariant: Invariant<State> = () => {},
    readonly seed: number | null = null,
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
    const record: TaskRecord = { promise: Promise.resolve(), error: null };
    this.trace.push(`task:${label}:start`);
    record.promise = Promise.resolve()
      .then(action)
      .then(() => {
        this.trace.push(`task:${label}:complete`);
        this.capture(`task:${label}`);
      })
      .catch((error: unknown) => {
        record.error = error;
        this.trace.push(`task:${label}:failed`);
      });
    this.tasks.set(label, record);
  }

  async join(label: string): Promise<void> {
    const record = this.tasks.get(label);
    assert.ok(record, `simulation task does not exist: ${label}`);
    await record.promise;
    this.tasks.delete(label);
    if (record.error !== null) {
      throw this.failure(record.error, `task:${label}`);
    }
  }

  async finish(): Promise<void> {
    for (const label of [...this.tasks.keys()]) {
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
    barrier.reached.resolve(undefined);
    await barrier.released.promise;
    this.trace.push(`barrier:${barrierName}:passed`);
  }

  /** Called by the test to wait until a fake dependency is definitely paused. */
  async waitUntilReached(barrierName: string): Promise<void> {
    await this.getBarrier(barrierName).reached.promise;
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
    const checkpoint: SimulationCheckpoint<State> = {
      label,
      state: structuredClone(this.snapshot()),
      trace: [...this.trace],
    };
    try {
      this.invariant(checkpoint);
      this.checkpoints.push(checkpoint);
    } catch (error) {
      throw new SimulationFailure(error, checkpoint, this.seed);
    }
  }

  private failure(error: unknown, label: string): SimulationFailure<State> {
    if (error instanceof SimulationFailure) {
      return error;
    }
    return new SimulationFailure(
      error,
      { label, state: structuredClone(this.snapshot()), trace: [...this.trace] },
      this.seed,
    );
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
