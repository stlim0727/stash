import type { AnalyticsEvent } from './events.ts';
import { sanitizeEvent } from './sanitize.ts';

export interface AnalyticsTransport {
  capture(event: AnalyticsEvent): void;
  optOut(): Promise<void>;
  reloadBooleanFlag?(key: string): Promise<boolean>;
}

export type AnalyticsTransportFactory = (
  freshOptIn?: boolean,
) => Promise<AnalyticsTransport | null>;

/**
 * Synchronous privacy gate around an asynchronously-created transport.
 * Disabling drops the live reference before any cleanup work starts, so a
 * capture racing with opt-out cannot reach the network queue.
 */
export class AnalyticsRuntime {
  private enabled = false;
  private generation = 0;
  private transport: AnalyticsTransport | null = null;

  constructor(private readonly createTransport: AnalyticsTransportFactory) {}

  async enable(freshOptIn = false): Promise<boolean> {
    if (this.enabled && this.transport) return true;

    this.enabled = true;
    const generation = ++this.generation;
    const transport = await this.createTransport(freshOptIn).catch(() => null);

    if (!this.enabled || generation !== this.generation) {
      if (transport) void transport.optOut().catch(() => {});
      return false;
    }

    this.transport = transport;
    if (!transport) this.enabled = false;
    return transport !== null;
  }

  disable(): Promise<void> {
    this.enabled = false;
    this.generation += 1;
    const transport = this.transport;
    this.transport = null;
    return transport ? transport.optOut() : Promise.resolve();
  }

  capture(input: unknown): void {
    if (!this.enabled || !this.transport) return;
    const event = sanitizeEvent(input);
    if (!event) return;

    try {
      this.transport.capture(event);
    } catch {
      // Analytics is best-effort and must never block capture or navigation.
    }
  }

  async reloadBooleanFlag(key: string): Promise<boolean> {
    if (!this.enabled || !this.transport?.reloadBooleanFlag) return false;
    try {
      return (await this.transport.reloadBooleanFlag(key)) === true;
    } catch {
      return false;
    }
  }
}
