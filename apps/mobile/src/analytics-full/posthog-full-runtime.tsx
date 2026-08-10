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
 *
 * The PostHog client is constructed once (only when the build-time gate is
 * enabled) with `defaultOptIn: false`, so no data can leave the device before
 * the stored user preference is read and `optIn()` is explicitly called.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PostHog, PostHogProvider, PostHogSurveyProvider } from 'posthog-react-native';

import {
  POSTHOG_FULL_AUTOCAPTURE_OPTIONS,
  POSTHOG_FULL_ENABLED_STORAGE_KEY,
  buildPostHogFullInitOptions,
  getPostHogFullConfigState,
} from './posthog-full-config.ts';
import { getPreference, setPreference } from '@/storage/preferences';

interface PostHogFullContextValue {
  enabled: boolean;
  ready: boolean;
  setEnabled(enabled: boolean): Promise<void>;
}

const disabledContext: PostHogFullContextValue = {
  enabled: false,
  ready: false,
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
        await setPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY, 'true');
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
    void getPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY)
      .then(async (stored) => {
        if (!active || stored !== 'true') return;
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

  const value = useMemo(() => ({ enabled, ready, setEnabled }), [enabled, ready, setEnabled]);
  const providerAutocapture = useMemo(() => ({ ...POSTHOG_FULL_AUTOCAPTURE_OPTIONS }), []);

  if (!client) {
    return (
      <PostHogFullContext.Provider value={value}>{children}</PostHogFullContext.Provider>
    );
  }

  return (
    <PostHogFullContext.Provider value={value}>
      <PostHogProvider client={client} autocapture={providerAutocapture}>
        <PostHogSurveyProvider client={client}>{children}</PostHogSurveyProvider>
      </PostHogProvider>
    </PostHogFullContext.Provider>
  );
}
