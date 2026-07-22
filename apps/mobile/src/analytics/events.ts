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

export type AnalyticsEvent = AppOpenEvent | ScreenViewedEvent | CaptureCompletedEvent;
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
