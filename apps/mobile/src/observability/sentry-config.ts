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
}

export type SentryConfigState =
  | { status: 'enabled'; config: SentryConfig }
  | { status: 'disabled'; reason: string };

const DSN_ENV = 'EXPO_PUBLIC_SENTRY_DSN';

const DEFAULT_ENVIRONMENT = 'development';

/** Parse a 0..1 sample rate; anything missing or out of range disables tracing. */
export function parseSampleRate(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return 0;
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
