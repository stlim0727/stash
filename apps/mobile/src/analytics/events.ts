export type AnalyticsPlatform = 'ios' | 'android' | 'web';

export type AnalyticsAuthState =
  | 'anonymous'
  | 'authenticated'
  | 'signed_out'
  | 'session_expired'
  | 'not_configured';

export type AnalyticsScreen =
  | 'inbox'
  | 'add_bookmark'
  | 'settings'
  | 'review'
  | 'report'
  | 'trash'
  | 'browse_tags'
  | 'graph'
  | 'bookmark_detail';

export interface AppOpenProperties {
  readonly platform: AnalyticsPlatform;
  readonly auth_state: AnalyticsAuthState;
}

export interface AppOpenEvent {
  readonly name: 'app_open';
  readonly properties: AppOpenProperties;
}

export interface ScreenViewedProperties {
  readonly screen: AnalyticsScreen;
}

export interface ScreenViewedEvent {
  readonly name: 'screen_viewed';
  readonly properties: ScreenViewedProperties;
}

export interface CaptureCompletedProperties {
  readonly source: 'share';
  readonly result: 'created' | 'duplicate' | 'invalid';
  readonly durable: boolean;
  readonly persistence_ms: number;
  readonly platform: AnalyticsPlatform;
}

export interface CaptureCompletedEvent {
  readonly name: 'capture_completed';
  readonly properties: CaptureCompletedProperties;
}

export type SyncRecoveryDelayBand = 'under_10s' | '10_30s' | '30_60s' | '1_5m' | 'over_5m';
export type SyncRecoveryFailureKind = 'transient_dns' | 'transient_network' | 'other' | 'unknown';

export interface SyncRecoveredEvent {
  readonly name: 'sync_recovered';
  readonly properties: {
    readonly failed_runs: number;
    readonly delay_band: SyncRecoveryDelayBand;
    readonly failure_kind: SyncRecoveryFailureKind;
  };
}

export type AnalyticsEvent =
  | AppOpenEvent
  | ScreenViewedEvent
  | CaptureCompletedEvent
  | SyncRecoveredEvent;
export type AnalyticsEventName = AnalyticsEvent['name'];

export const ALLOWED_PLATFORMS: ReadonlySet<AnalyticsPlatform> = new Set([
  'ios',
  'android',
  'web',
]);

export const ALLOWED_AUTH_STATES: ReadonlySet<AnalyticsAuthState> = new Set([
  'anonymous',
  'authenticated',
  'signed_out',
  'session_expired',
  'not_configured',
]);

export const ALLOWED_SCREENS: ReadonlySet<AnalyticsScreen> = new Set([
  'inbox',
  'add_bookmark',
  'settings',
  'review',
  'report',
  'trash',
  'browse_tags',
  'graph',
  'bookmark_detail',
]);

export const ALLOWED_SOURCES: ReadonlySet<'share'> = new Set(['share'] as const);
export const ALLOWED_RESULTS: ReadonlySet<'created' | 'duplicate' | 'invalid'> = new Set([
  'created',
  'duplicate',
  'invalid',
] as const);
export const ALLOWED_SYNC_RECOVERY_DELAY_BANDS: ReadonlySet<SyncRecoveryDelayBand> = new Set([
  'under_10s',
  '10_30s',
  '30_60s',
  '1_5m',
  'over_5m',
]);
export const ALLOWED_SYNC_RECOVERY_FAILURE_KINDS: ReadonlySet<SyncRecoveryFailureKind> = new Set([
  'transient_dns',
  'transient_network',
  'other',
  'unknown',
]);

export const EVENT_CATALOG = {
  app_open: {
    platform: ALLOWED_PLATFORMS,
    auth_state: ALLOWED_AUTH_STATES,
  },
  screen_viewed: {
    screen: ALLOWED_SCREENS,
  },
  capture_completed: {
    source: ALLOWED_SOURCES,
    result: ALLOWED_RESULTS,
    durable: 'boolean',
    persistence_ms: 'number',
    platform: ALLOWED_PLATFORMS,
  },
  sync_recovered: {
    failed_runs: 'number',
    delay_band: ALLOWED_SYNC_RECOVERY_DELAY_BANDS,
    failure_kind: ALLOWED_SYNC_RECOVERY_FAILURE_KINDS,
  },
} as const;

export function createAppOpenEvent(
  platform: AnalyticsPlatform,
  authState: AnalyticsAuthState,
): AppOpenEvent {
  return {
    name: 'app_open',
    properties: {
      platform,
      auth_state: authState,
    },
  };
}

export function createScreenViewedEvent(screen: AnalyticsScreen): ScreenViewedEvent {
  return {
    name: 'screen_viewed',
    properties: {
      screen,
    },
  };
}

export function createCaptureCompletedEvent(
  source: 'share',
  result: 'created' | 'duplicate' | 'invalid',
  durable: boolean,
  persistenceMs: number,
  platform: AnalyticsPlatform,
): CaptureCompletedEvent {
  const normalizedMs = Math.max(0, Math.min(10000, Math.round(persistenceMs)));
  return {
    name: 'capture_completed',
    properties: {
      source,
      result,
      durable,
      persistence_ms: normalizedMs,
      platform,
    },
  };
}

export function createSyncRecoveredEvent(
  failedRuns: number,
  lastFailureAt: string | null | undefined,
  failureKind: SyncRecoveryFailureKind | null | undefined,
  now = Date.now(),
): SyncRecoveredEvent {
  const failedAt = lastFailureAt ? Date.parse(lastFailureAt) : Number.NaN;
  const elapsedMs = Number.isFinite(failedAt) ? Math.max(0, now - failedAt) : 0;
  const delayBand: SyncRecoveryDelayBand =
    elapsedMs < 10_000
      ? 'under_10s'
      : elapsedMs < 30_000
        ? '10_30s'
        : elapsedMs < 60_000
          ? '30_60s'
          : elapsedMs < 300_000
            ? '1_5m'
            : 'over_5m';
  return {
    name: 'sync_recovered',
    properties: {
      failed_runs: Math.max(1, Math.min(10_000, Math.round(failedRuns))),
      delay_band: delayBand,
      failure_kind: failureKind ?? 'unknown',
    },
  };
}
