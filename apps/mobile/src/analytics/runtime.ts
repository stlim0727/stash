import type { AnalyticsEvent } from './events.ts';
import { sanitizeEvent } from './sanitize.ts';

export interface AnalyticsTransport {
  capture(event: AnalyticsEvent): void;
  optOut(): Promise<void>;
  reloadBooleanFlag?(key: string): Promise<boolean>;
  flush?(): Promise<void>;
}

export type AnalyticsTransportFactory = (
  freshOptIn?: boolean,
) => Promise<AnalyticsTransport | null>;

/**
 * Synchronous privacy gate around an asynchronously-created transport.
 * Disabling drops the live reference before any cleanup work starts, so a
 * capture racing with opt-out cannot reach the network queue.
 *
 * It queues captures during 'loading' (initialization) state, and replays them
 * once the transport becomes ready (if enabled) or discards them (if disabled/opt-out).
 */
export class AnalyticsRuntime {
  private state: 'loading' | 'enabled' | 'disabled' = 'loading';
  private generation = 0;
  private transport: AnalyticsTransport | null = null;
  private initQueue: unknown[] = [];
  private pendingInit: Promise<unknown> = Promise.resolve();

  constructor(private readonly createTransport: AnalyticsTransportFactory) {}

  async enable(freshOptIn = false): Promise<boolean> {
    if (this.state === 'enabled' && this.transport) return true;

    this.state = 'loading';
    const generation = ++this.generation;

    let resolveInit: () => void = () => {};
    this.pendingInit = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    try {
      const transport = await this.createTransport(freshOptIn).catch(() => null);

      if ((this.state as string) === 'disabled' || generation !== this.generation) {
        if (transport) void transport.optOut().catch(() => {});
        this.initQueue = [];
        return false;
      }

      this.transport = transport;
      if (!transport) {
        this.state = 'disabled';
        this.initQueue = [];
      } else {
        this.state = 'enabled';
        const queued = this.initQueue;
        this.initQueue = [];
        for (const item of queued) {
          this.capture(item);
        }
      }
      return transport !== null;
    } finally {
      resolveInit();
    }
  }

  disable(): Promise<void> {
    this.state = 'disabled';
    this.generation += 1;
    this.initQueue = [];
    const transport = this.transport;
    this.transport = null;
    this.pendingInit = Promise.resolve();
    return transport ? transport.optOut() : Promise.resolve();
  }

  capture(input: unknown): void {
    if (this.state === 'disabled') return;
    if (this.state === 'loading') {
      this.initQueue.push(input);
      return;
    }
    if (!this.transport) return;

    const event = sanitizeEvent(input);
    if (!event) return;

    try {
      this.transport.capture(event);
    } catch {
      // Analytics is best-effort and must never block capture or navigation.
    }
  }

  async reloadBooleanFlag(key: string): Promise<boolean> {
    if (this.state !== 'enabled' || !this.transport?.reloadBooleanFlag) return false;
    try {
      return (await this.transport.reloadBooleanFlag(key)) === true;
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> {
    if (this.state === 'disabled') return;
    if (this.state === 'loading') {
      await this.pendingInit;
    }
    if (this.state !== 'enabled' || !this.transport?.flush) return;
    try {
      await this.transport.flush();
    } catch {
      // Ignore
    }
  }
}

