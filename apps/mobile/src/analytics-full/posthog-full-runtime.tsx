/**
 * Thin React Native shell over the official `posthog-react-native` SDK — the
 * one file in this layer that imports it. Session replay, heatmaps, richer
 * feature flags, and in-app surveys live here, entirely separate from the
 * hand-rolled, sanitized analytics client in `analytics/` (that client's
 * allowlist, transport, and tests are untouched by this file).
 *
 * Two independent gates must both be true before anything is ever sent:
 *  1. Build-time: `EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED` (see
 *     `posthog-full-config.ts`) — unset in production until the trial is
 *     deliberately turned on for a build/channel.
 *  2. Runtime: the user's own Settings toggle, stored under
 *     `POSTHOG_FULL_ENABLED_STORAGE_KEY` — a key distinct from the base
 *     analytics client's, so the two never share consent state or identity.
 *     Also requires the base analytics preference to still be enabled — see
 *     the startup-restore effect below.
 *
 * The PostHog client is constructed once (only when the build-time gate is
 * enabled) with `defaultOptIn: false`, so no data can leave the device before
 * the stored user preference is read and `optIn()` is explicitly called.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { PostHog, PostHogProvider, PostHogSurveyProvider, usePostHog } from 'posthog-react-native';

import {
  POSTHOG_FULL_AUTOCAPTURE_OPTIONS,
  POSTHOG_FULL_ENABLED_STORAGE_KEY,
  buildPostHogFullInitOptions,
  getPostHogFullConfigState,
} from './posthog-full-config.ts';
import { analyticsScreenForPath } from '@/analytics/route';
import { getPostHogAnalyticsEnabled } from '@/analytics/posthog';
import { getPreference, setPreference } from '@/storage/preferences';

interface PostHogFullContextValue {
  enabled: boolean;
  ready: boolean;
  /** Whether a client was constructed at all (build-time gate + config
   *  present). When false, `setEnabled` is permanently a no-op — callers
   *  should treat the toggle as unavailable, not just "off", to avoid an
   *  interactive control that silently does nothing. */
  configured: boolean;
  setEnabled(enabled: boolean): Promise<void>;
}

const disabledContext: PostHogFullContextValue = {
  enabled: false,
  ready: false,
  configured: false,
  setEnabled: async () => {},
};

const PostHogFullContext = createContext<PostHogFullContextValue>(disabledContext);

/** No generic `capture()` is exposed here on purpose — this layer is
 *  autocapture/replay/flags/surveys, not manual event capture from app code.
 *  Use `usePostHog()` from `posthog-react-native` directly where that's
 *  genuinely needed (e.g. reading a feature flag). */
export function usePostHogFull(): PostHogFullContextValue {
  return useContext(PostHogFullContext);
}

/**
 * Manual screen capture: the SDK's own autocapture (`captureScreens`) only
 * works with a @react-navigation `NavigationContainer`, which expo-router
 * doesn't expose (the SDK's own docs say to disable it and call
 * `posthog.screen()` manually for expo-router apps — see
 * `POSTHOG_FULL_AUTOCAPTURE_OPTIONS`). Reuses the same closed 9-screen
 * allowlist (`analyticsScreenForPath`) the base analytics client uses, so
 * only a known screen name is ever sent — never a raw path, param, or query
 * string. Must render inside `PostHogProvider` (needs `usePostHog()`).
 */
function PostHogFullScreenTracker() {
  const posthog = usePostHog();
  const pathname = usePathname();
  useEffect(() => {
    const screen = analyticsScreenForPath(pathname);
    if (screen) void posthog.screen(screen);
  }, [posthog, pathname]);
  return null;
}

export function PostHogFullProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<PostHog | null>(null);
  if (clientRef.current === null) {
    const configState = getPostHogFullConfigState();
    if (configState.status === 'enabled') {
      clientRef.current = new PostHog(
        configState.config.apiKey,
        buildPostHogFullInitOptions(configState.config),
      );
    }
  }
  const client = clientRef.current;

  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!client) return;
      if (next) {
        await client.optIn();
        try {
          await setPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY, 'true');
        } catch (error) {
          // The persisted preference is the source of truth on the next
          // launch — if it can't be written, don't leave the client
          // collecting while Settings reports it as off. Roll back so the
          // in-memory and durable state can never diverge.
          await client.optOut();
          client.reset();
          throw error;
        }
        setEnabledState(true);
      } else {
        await client.optOut();
        // Drop the local distinct_id/session so a later re-opt-in starts a
        // fresh identity, mirroring the hand-rolled transport's "fresh
        // opt-in never revives a pre-opt-out identity" guarantee.
        client.reset();
        await setPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY, 'false');
        setEnabledState(false);
      }
    },
    [client],
  );

  useEffect(() => {
    let active = true;
    if (!client) {
      setReady(true);
      return;
    }
    void Promise.all([
      getPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY),
      getPostHogAnalyticsEnabled(),
    ])
      .then(async ([stored, baseEnabled]) => {
        if (!active || stored !== 'true') return;
        if (!baseEnabled) {
          // The base analytics preference (ANALYTICS_STATE_KEY) was revoked
          // without this preference being reconciled — e.g. the app closed
          // before the Settings cascade finished persisting. Narrower
          // consent must not survive a revoked broader consent: self-heal
          // the stale preference and never opt in.
          await setPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY, 'false');
          return;
        }
        await client.optIn();
        if (!active) return;
        setEnabledState(true);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
    // `client` is created once per provider mount and never replaced, so this
    // effect is meant to run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const value = useMemo<PostHogFullContextValue>(
    () => ({ enabled, ready, configured: client !== null, setEnabled }),
    [client, enabled, ready, setEnabled],
  );
  const providerAutocapture = useMemo(() => ({ ...POSTHOG_FULL_AUTOCAPTURE_OPTIONS }), []);

  if (!client) {
    return (
      <PostHogFullContext.Provider value={value}>{children}</PostHogFullContext.Provider>
    );
  }

  return (
    <PostHogFullContext.Provider value={value}>
      <PostHogProvider client={client} autocapture={providerAutocapture}>
        <PostHogFullScreenTracker />
        <PostHogSurveyProvider client={client}>{children}</PostHogSurveyProvider>
      </PostHogProvider>
    </PostHogFullContext.Provider>
  );
}
