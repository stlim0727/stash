import type { AnalyticsEvent } from './events.ts';
import { sanitizeEvent } from './sanitize.ts';
import type { AnalyticsTransport } from './runtime.ts';
import { getPreference, setPreference } from '@/storage/preferences';

const APPROVED_POSTHOG_ORIGIN = 'https://eu.i.posthog.com';
export const ANALYTICS_STATE_KEY = 'analytics.posthog.state.v1';
export const AD_EXPERIMENT_FLAG_KEY = 'ads-master-enabled';
const MAX_QUEUE_SIZE = 100;

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST;

export interface AnalyticsStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface QueueEntry {
  event: AnalyticsEvent;
  occurredAt: string;
}

interface PersistedAnalyticsState {
  version: 1;
  enabled: boolean;
  installationId: string | null;
  queue: QueueEntry[];
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

interface TransportOptions {
  apiKey: string;
  host: string;
  storage: AnalyticsStorage;
  fetcher?: Fetcher;
  idFactory?: () => string;
  now?: () => string;
  freshOptIn?: boolean;
}

const disabledState: PersistedAnalyticsState = {
  version: 1,
  enabled: false,
  installationId: null,
  queue: [],
};

function approvedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === APPROVED_POSTHOG_ORIGIN && url.href === `${url.origin}/`
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function validInstallationId(value: unknown): value is string {
  return typeof value === 'string' && /^ka_[0-9a-f]{32}$/.test(value);
}

function parseQueue(value: unknown): QueueEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: QueueEntry[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const event = sanitizeEvent(record.event);
    const timestamp =
      typeof record.occurredAt === 'string' ? Date.parse(record.occurredAt) : Number.NaN;
    if (!event || !Number.isFinite(timestamp)) continue;
    entries.push({ event, occurredAt: new Date(timestamp).toISOString() });
  }
  return entries.slice(-MAX_QUEUE_SIZE);
}

function parseState(raw: string | null): PersistedAnalyticsState {
  if (!raw) return disabledState;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return disabledState;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.enabled !== true || !validInstallationId(record.installationId)) {
      return disabledState;
    }
    return {
      version: 1,
      enabled: true,
      installationId: record.installationId,
      queue: parseQueue(record.queue),
    };
  } catch {
    return disabledState;
  }
}

async function writeVerifiedState(
  storage: AnalyticsStorage,
  state: PersistedAnalyticsState,
): Promise<void> {
  const serialized = JSON.stringify(state);
  let lastError: unknown = new Error('Analytics state could not be verified');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await storage.set(ANALYTICS_STATE_KEY, serialized);
      if ((await storage.get(ANALYTICS_STATE_KEY)) === serialized) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function clearPostHogAnalyticsState(
  storage: AnalyticsStorage = { get: getPreference, set: setPreference },
): Promise<void> {
  await writeVerifiedState(storage, disabledState);
}

export async function getPostHogAnalyticsEnabled(
  storage: AnalyticsStorage = { get: getPreference, set: setPreference },
): Promise<boolean> {
  return parseState(await storage.get(ANALYTICS_STATE_KEY)).enabled;
}

export class PostHogHttpTransport implements AnalyticsTransport {
  private active = true;
  private generation = 0;
  private persistence = Promise.resolve();
  private drain = Promise.resolve();
  private inFlight = new Set<AbortController>();

  constructor(
    private readonly origin: string,
    private readonly apiKey: string,
    private readonly installationId: string,
    private readonly storage: AnalyticsStorage,
    private readonly fetcher: Fetcher,
    private readonly now: () => string,
    private queue: QueueEntry[],
  ) {
    if (queue.length > 0) this.scheduleFlush();
  }

  capture(event: AnalyticsEvent): void {
    if (!this.active) return;
    this.queue.push({ event, occurredAt: this.now() });
    this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
    this.schedulePersist();
    this.scheduleFlush();
  }

  async optOut(): Promise<void> {
    this.active = false;
    this.generation += 1;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.queue = [];
    // A persistence write that already started may finish after the gate closes;
    // wait for that write, then make the disabled tombstone the final state.
    await this.persistence.catch(() => {});
    await clearPostHogAnalyticsState(this.storage);
  }

  async flush(): Promise<void> {
    await this.persistence;
    await this.drain;
  }

  async reloadBooleanFlag(key: string): Promise<boolean> {
    if (!this.active || key !== AD_EXPERIMENT_FLAG_KEY) return false;
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.fetcher(`${this.origin}/flags/?v=2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: this.apiKey,
          distinct_id: this.installationId,
          groups: {},
          person_properties: {},
          group_properties: {},
          geoip_disable: true,
          flag_keys_to_evaluate: [key],
        }),
        signal: controller.signal,
      });
      if (!response.ok || !this.active || generation !== this.generation) return false;
      const payload: unknown = await response.json();
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
      const flags = (payload as Record<string, unknown>).flags;
      if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return false;
      const detail = (flags as Record<string, unknown>)[key];
      return (
        typeof detail === 'object' &&
        detail !== null &&
        !Array.isArray(detail) &&
        (detail as Record<string, unknown>).enabled === true
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(controller);
    }
  }

  private currentState(): PersistedAnalyticsState {
    return {
      version: 1,
      enabled: true,
      installationId: this.installationId,
      queue: this.queue,
    };
  }

  private schedulePersist(): Promise<void> {
    const generation = this.generation;
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        if (!this.active || generation !== this.generation) return;
        await writeVerifiedState(this.storage, this.currentState());
      });
    return this.persistence;
  }

  private scheduleFlush(): void {
    const generation = this.generation;
    this.drain = this.drain
      .catch(() => {})
      .then(async () => {
        if (!this.active || generation !== this.generation || this.queue.length === 0) return;
        await this.persistence;
        if (!this.active || generation !== this.generation) return;

        const batch = [...this.queue];
        const controller = new AbortController();
        this.inFlight.add(controller);
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await this.fetcher(`${this.origin}/batch/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: this.apiKey,
              batch: batch.map(({ event, occurredAt }) => ({
                event: event.name,
                properties:
                  event.name === 'app_open'
                    ? {
                        distinct_id: this.installationId,
                        platform: event.properties.platform,
                        auth_state: event.properties.auth_state,
                        $geoip_disable: true,
                        $process_person_profile: false,
                      }
                    : {
                        distinct_id: this.installationId,
                        screen: event.properties.screen,
                        $geoip_disable: true,
                        $process_person_profile: false,
                      },
                timestamp: occurredAt,
              })),
            }),
            signal: controller.signal,
          });
          if (!response.ok || !this.active || generation !== this.generation) return;
          const sent = new Set(batch);
          this.queue = this.queue.filter((entry) => !sent.has(entry));
          await this.schedulePersist();
        } catch {
          // Offline/error: retain the bounded durable queue for the next launch.
        } finally {
          clearTimeout(timeout);
          this.inFlight.delete(controller);
        }
      });
  }
}

export async function createPostHogHttpTransport(
  options: TransportOptions,
): Promise<PostHogHttpTransport | null> {
  const origin = approvedOrigin(options.host);
  if (!origin || !options.apiKey.trim()) return null;

  const persisted = parseState(await options.storage.get(ANALYTICS_STATE_KEY));
  let installationId = persisted.installationId;
  if (!persisted.enabled || !installationId) {
    if (!options.freshOptIn) return null;
    installationId = options.idFactory
      ? options.idFactory()
      : `ka_${(await import('expo-crypto')).randomUUID().replaceAll('-', '')}`;
    if (!validInstallationId(installationId)) return null;
    await writeVerifiedState(options.storage, {
      version: 1,
      enabled: true,
      installationId,
      queue: [],
    });
  }

  return new PostHogHttpTransport(
    origin,
    options.apiKey,
    installationId,
    options.storage,
    options.fetcher ?? ((input, init) => fetch(input, init)),
    options.now ?? (() => new Date().toISOString()),
    persisted.enabled ? persisted.queue : [],
  );
}

export async function createPostHogTransport(
  freshOptIn = false,
): Promise<AnalyticsTransport | null> {
  if (!apiKey || !host) return null;
  return createPostHogHttpTransport({
    apiKey,
    host,
    storage: { get: getPreference, set: setPreference },
    freshOptIn,
  });
}
