/**
 * Pure configuration for the full PostHog SDK (session replay, heatmaps,
 * feature flags, surveys) — an additive layer that runs alongside the
 * existing hand-rolled analytics client in `analytics/`, not a replacement
 * for it. That client's allowlist/sanitizer/tests are untouched by this file.
 *
 * Dependency-free (no React Native or `posthog-react-native` imports) so it
 * can be unit-tested under the Node test runner, mirroring
 * `observability/sentry-config.ts`. The thin SDK shell in
 * `posthog-full-runtime.tsx` reads these and constructs the real client.
 *
 * Disabled unless BOTH `EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED` is set AND the
 * PostHog project vars are present — a build-time gate independent of the
 * runtime Settings opt-in (see `posthog-full-runtime.tsx`), so a build that
 * hasn't explicitly turned this trial on stays structurally inert.
 */

declare const process: { env: Record<string, string | undefined> };

const APPROVED_HOST = 'https://eu.i.posthog.com';

/** Dedicated preference-storage key for this layer's opt-in — never
 *  `ANALYTICS_STATE_KEY` from `analytics/posthog.ts`, so the two layers never
 *  share consent state or a distinct_id. */
export const POSTHOG_FULL_ENABLED_STORAGE_KEY = 'analytics.posthog_full.enabled.v1';

export interface PostHogFullConfig {
  readonly apiKey: string;
  readonly host: string;
}

export type PostHogFullConfigState =
  | { readonly status: 'enabled'; readonly config: PostHogFullConfig }
  | { readonly status: 'disabled'; readonly reason: string };

/** Same EU-only data-residency decision the hand-rolled transport already
 *  hard-pins (`approvedOrigin` in `analytics/posthog.ts`) — re-implemented as
 *  its own small check here rather than imported, to keep the two layers
 *  decoupled. */
export function isApprovedPostHogHost(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === APPROVED_HOST && url.href === `${url.origin}/`;
  } catch {
    return false;
  }
}

export function getPostHogFullConfigState(): PostHogFullConfigState {
  // Static `process.env.EXPO_PUBLIC_*` reads so Expo inlines them into the
  // release bundle (a computed `process.env[key]` is not inlined).
  const buildGateEnabled =
    (process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED ?? '').trim() === 'true';
  if (!buildGateEnabled) {
    return { status: 'disabled', reason: 'EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED is not set' };
  }

  const apiKey = (process.env.EXPO_PUBLIC_POSTHOG_API_KEY ?? '').trim();
  if (!apiKey) {
    return { status: 'disabled', reason: 'Missing EXPO_PUBLIC_POSTHOG_API_KEY' };
  }

  const host = (process.env.EXPO_PUBLIC_POSTHOG_HOST ?? '').trim();
  if (!isApprovedPostHogHost(host)) {
    return { status: 'disabled', reason: 'EXPO_PUBLIC_POSTHOG_HOST is not the approved EU host' };
  }

  return { status: 'enabled', config: { apiKey, host } };
}

export interface PostHogFullSessionReplayConfig {
  readonly maskAllTextInputs: boolean;
  readonly maskAllImages: boolean;
  readonly maskAllSandboxedViews: boolean;
  readonly captureNetworkTelemetry: boolean;
}

export interface PostHogFullInitOptions {
  readonly host: string;
  readonly disableGeoip: boolean;
  readonly defaultOptIn: boolean;
  readonly captureAppLifecycleEvents: boolean;
  readonly enableSessionReplay: boolean;
  readonly sessionReplayConfig: PostHogFullSessionReplayConfig;
}

/**
 * Options passed to `new PostHog(apiKey, options)`. Pure so the masking
 * config is asserted by a plain unit test independent of any RN rendering —
 * that proves the code *asks* for masking, not that masking holds at
 * runtime. Masking correctness needs the manual verification checklist in
 * `docs/development/setup.md` before this ever reaches a real user.
 */
export function buildPostHogFullInitOptions(config: PostHogFullConfig): PostHogFullInitOptions {
  return {
    host: config.host,
    // Matches the hand-rolled transport's $geoip_disable: true.
    disableGeoip: true,
    // Start opted out; posthog-full-runtime.tsx only calls optIn() once the
    // user has explicitly turned on the Settings toggle.
    defaultOptIn: false,
    // Defaults to true — the SDK would otherwise emit its own
    // install/update/opened/backgrounded events with SDK-defined automatic
    // properties, bypassing EVENT_CATALOG/sanitizeEvent the same way
    // captureScreens/captureTouches would. app_open is already covered,
    // through the allowlist, by the base analytics client.
    captureAppLifecycleEvents: false,
    enableSessionReplay: true,
    sessionReplayConfig: {
      // The SDK's own current defaults for these are already `true`, but
      // pinned explicitly rather than trusted against a future SDK version
      // bump — bookmark titles/URLs/tags/notes/images are exactly the
      // content class this must never expose.
      maskAllTextInputs: true,
      maskAllImages: true,
      maskAllSandboxedViews: true,
      // iOS-only, defaults to true. Its exact capture surface (whether
      // request URLs/query strings are included) isn't documented precisely
      // enough to trust, and Supabase REST URLs carry search/filter query
      // params — disable explicitly rather than risk it.
      captureNetworkTelemetry: false,
    },
  };
}

export interface PostHogFullAutocaptureOptions {
  readonly captureScreens: boolean;
  readonly captureTouches: boolean;
}

export const POSTHOG_FULL_AUTOCAPTURE_OPTIONS: PostHogFullAutocaptureOptions = {
  // The SDK's own automatic screen capture only works with a
  // @react-navigation NavigationContainer, which expo-router does not expose
  // — the SDK's own docs say to disable this and call `posthog.screen()`
  // manually for expo-router apps. Doing so also lets screen names be routed
  // through the same closed allowlist (`analyticsScreenForPath`) the base
  // analytics client uses, rather than the SDK autocapturing raw route
  // strings. See `PostHogFullScreenTracker` in posthog-full-runtime.tsx.
  captureScreens: false,
  // Explicit false: touch autocapture on a bookmark list/card UI would
  // signal which specific bookmark a user interacted with.
  captureTouches: false,
};

export function describePostHogFullConfig(
  state: PostHogFullConfigState = getPostHogFullConfigState(),
): string {
  return state.status === 'enabled' ? 'Enabled' : `Disabled — ${state.reason}`;
}
