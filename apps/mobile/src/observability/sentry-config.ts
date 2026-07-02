/**
 * Pure configuration for crash & error monitoring (Sentry).
 *
 * This module is intentionally dependency-free (no React Native, Expo, or
 * Sentry imports) so it can be unit-tested under the Node test runner, exactly
 * like `supabase/config.ts`. The thin SDK shell in `sentry.ts` reads these and
 * calls the real `Sentry.init`.
 *
 * Monitoring is OFF unless `EXPO_PUBLIC_SENTRY_DSN` is set, so local and
 * preview environments never report by accident.
 */

declare const process: { env: Record<string, string | undefined> };

export interface SentryConfig {
  dsn: string;
  environment: string;
  /** 0..1 — fraction of transactions sampled for performance tracing. */
  tracesSampleRate: number;
  /** iOS app-hang threshold in seconds: the UI thread must be unresponsive at
   *  least this long to be reported as a hang. Android ANR detection is handled
   *  by the native SDK (no JS threshold knob), so this only tunes iOS. */
  appHangTimeoutSeconds: number;
}

export type SentryConfigState =
  | { status: 'enabled'; config: SentryConfig }
  | { status: 'disabled'; reason: string };

const DSN_ENV = 'EXPO_PUBLIC_SENTRY_DSN';

const DEFAULT_ENVIRONMENT = 'development';

// iOS app-hang default, aligned with the SDK's own 2s default. Deliberately not
// lower: sub-second thresholds turn ordinary cold-start jank into a flood of
// hang events. Overridable per-build via EXPO_PUBLIC_SENTRY_APP_HANG_TIMEOUT.
const DEFAULT_APP_HANG_TIMEOUT_SECONDS = 2;

/** Parse a 0..1 sample rate; anything missing or out of range disables tracing. */
export function parseSampleRate(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return 0;
  }
  return value;
}

/**
 * Parse the iOS app-hang threshold (seconds). Falls back to the SDK-aligned
 * default for anything missing, non-numeric, or implausibly small (< 1s would
 * report on ordinary jank), so a bad env value can never make hang reporting
 * noisy — it just reverts to the safe default.
 */
export function parseAppHangTimeout(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return DEFAULT_APP_HANG_TIMEOUT_SECONDS;
  }
  return value;
}

export function getSentryConfigState(): SentryConfigState {
  // Static `process.env.EXPO_PUBLIC_*` reads so Expo inlines them into the
  // release bundle (a computed `process.env[key]` is not inlined).
  const dsn = (process.env.EXPO_PUBLIC_SENTRY_DSN ?? '').trim();
  if (!dsn) {
    return { status: 'disabled', reason: `Missing ${DSN_ENV}` };
  }
  return {
    status: 'enabled',
    config: {
      dsn,
      environment: (process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ?? '').trim() || DEFAULT_ENVIRONMENT,
      tracesSampleRate: parseSampleRate(
        (process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '').trim(),
      ),
      appHangTimeoutSeconds: parseAppHangTimeout(
        (process.env.EXPO_PUBLIC_SENTRY_APP_HANG_TIMEOUT ?? '').trim(),
      ),
    },
  };
}

export interface SentryInitInput {
  /** App version, e.g. from `expo-constants` `expoConfig.version`. */
  release?: string | null;
  /** Build identifier (e.g. native build number), if available. */
  dist?: string | null;
}

export interface SentryInitOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
  release?: string;
  dist?: string;
  enableNativeCrashHandling: boolean;
  /** iOS: report when the UI thread stays unresponsive for at least
   *  `appHangTimeoutInterval` seconds, so a wedged screen self-reports with a JS
   *  stack instead of only arriving as a fuzzy in-app "screen frozen" report.
   *  Android ANRs are captured by the native Sentry Android SDK (wired via the
   *  `@sentry/react-native/expo` config plugin) and have no JS toggle here. */
  enableAppHangTracking: boolean;
  appHangTimeoutInterval: number;
  /** Privacy: never auto-attach IP/cookies/headers. We set only an opaque user
   *  id explicitly when we choose to. */
  sendDefaultPii: boolean;
}

/**
 * Build the options passed to `Sentry.init`, or `null` when monitoring is
 * disabled. Pure and side-effect free so the wiring is unit-testable.
 */
export function buildSentryInitOptions(
  state: SentryConfigState,
  input: SentryInitInput = {},
): SentryInitOptions | null {
  if (state.status !== 'enabled') {
    return null;
  }
  const options: SentryInitOptions = {
    dsn: state.config.dsn,
    environment: state.config.environment,
    tracesSampleRate: state.config.tracesSampleRate,
    enableNativeCrashHandling: true,
    // Opt in to hang detection so a frozen UI thread becomes a real, actionable
    // event (with a stack) instead of only a user-typed "screen stuck" report.
    // iOS is tuned here; Android ANR is native-default via the Expo plugin.
    enableAppHangTracking: true,
    appHangTimeoutInterval: state.config.appHangTimeoutSeconds,
    sendDefaultPii: false,
  };
  const release = input.release?.trim();
  if (release) {
    options.release = release;
  }
  const dist = input.dist?.trim();
  if (dist) {
    options.dist = dist;
  }
  return options;
}

export function describeSentryConfig(state = getSentryConfigState()): string {
  return state.status === 'enabled'
    ? `Enabled (${state.config.environment})`
    : `Disabled — ${state.reason}`;
}

export interface SentryDsnParts {
  publicKey: string;
  host: string;
  projectId: string;
  /** Legacy "store" endpoint that accepts a single JSON event. */
  storeUrl: string;
}

/**
 * Parse a DSN (`{protocol}://{publicKey}@{host}/{projectId}`) into the pieces
 * needed to send an event directly to Sentry's ingest API. Pure and
 * regex-based (no `URL` dependency) so it stays portable and unit-testable.
 * Returns null for anything that does not look like a DSN.
 */
export function parseSentryDsn(dsn: string): SentryDsnParts | null {
  const match = /^(https?):\/\/([^:@/]+)(?::[^@/]+)?@([^/]+)\/(.+)$/.exec(dsn.trim());
  if (!match) {
    return null;
  }
  const [, protocol, publicKey, host, projectId] = match;
  return {
    publicKey: publicKey!,
    host: host!,
    projectId: projectId!,
    storeUrl: `${protocol}://${host}/api/${projectId}/store/`,
  };
}
