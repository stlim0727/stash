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

/** Write the preference, verifying the read-back and retrying a few times —
 *  mirrors `writeVerifiedState` in `analytics/posthog.ts`. This matters most
 *  for the "false" tombstone: an unverified failed write leaves the durable
 *  preference stale at "true", which would silently re-opt the user back in
 *  on the next launch despite their just having turned it off. */
async function writeVerifiedPreference(value: 'true' | 'false'): Promise<void> {
  let lastError: unknown = new Error('Session replay preference could not be verified');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await setPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY, value);
      if ((await getPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY)) === value) return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

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
  // Re-fires when `enabled` flips true (not just when `pathname` changes) so
  // the screen the user is already on when they opt in gets recorded — the
  // pathname-only version would silently skip it until the next navigation.
  const { enabled } = usePostHogFull();
  useEffect(() => {
    if (!enabled) return;
    const screen = analyticsScreenForPath(pathname);
    if (screen) void posthog.screen(screen);
  }, [posthog, pathname, enabled]);
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

  // Every operation that changes the client's opt-in/opt-out state (the
  // startup restore below, and every `setEnabled` call) is serialized through
  // this queue — strictly in invocation order, never in whichever order their
  // internal `await`s happen to resolve. Without this, a fast "turn replay on
  // then immediately turn base analytics off" sequence could race: the
  // pending `optIn()` from the first call could land on the client AFTER the
  // second call's `optOut()`, silently leaving collection active even though
  // the user's last action was to turn it off. Mirrors the persistence-queue
  // pattern already used in the hand-rolled transport (`analytics/posthog.ts`).
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    const run = queueRef.current.catch(() => undefined).then(task);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const setEnabled = useCallback(
    (next: boolean): Promise<void> => {
      if (!client) return Promise.resolve();
      return enqueue(async () => {
        if (next) {
          await client.optIn();
          try {
            await writeVerifiedPreference('true');
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
          // Reflect the actual (now opted-out) SDK state immediately, before
          // attempting the durable write — so the UI can never claim
          // "enabled" once the client itself has already opted out, even if
          // the persistence attempt below fails.
          setEnabledState(false);
          // Retried and read-back-verified: an unverified failed write here
          // would leave the durable preference stale at "true", and the
          // startup-restore effect would silently opt the user back in on
          // the next launch despite their just having turned this off.
          await writeVerifiedPreference('false');
        }
      });
    },
    [client, enqueue],
  );

  useEffect(() => {
    let active = true;
    if (!client) {
      setReady(true);
      return;
    }
    void enqueue(async () => {
      // Force the client to a known, opted-out state BEFORE evaluating our
      // own consent gates — the native SDK persists its own opt-in flag
      // independently of this preference (`defaultOptIn: false` only
      // supplies a default when no prior SDK-side state exists at all), so
      // a session that called optIn() but was killed before this
      // preference finished writing would otherwise load this new client
      // instance already opted in. Doing this first, rather than only in a
      // "should not restore" branch below, also means a failure in the
      // reads that follow can never skip it.
      await client.optOut();
      const [stored, baseEnabled] = await Promise.all([
        getPreference(POSTHOG_FULL_ENABLED_STORAGE_KEY),
        getPostHogAnalyticsEnabled(),
      ]);
      if (stored !== 'true' || !baseEnabled) {
        if (stored === 'true' && !baseEnabled) {
          // Narrower consent (this preference) survived a revoked broader
          // one (base analytics) — e.g. the app closed before the Settings
          // cascade finished persisting. Self-heal the stale preference AND
          // drop the identity, matching the normal disable path — otherwise
          // a later re-opt-in would revive the pre-revocation distinct_id
          // instead of starting fresh.
          client.reset();
          await writeVerifiedPreference('false').catch(() => {});
        }
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
  }, [client, enqueue]);

  const value = useMemo<PostHogFullContextValue>(
    () => ({ enabled, ready, configured: client !== null, setEnabled }),
    [client, enabled, ready, setEnabled],
  );
  const providerAutocapture = useMemo(() => ({ ...POSTHOG_FULL_AUTOCAPTURE_OPTIONS }), []);

  // Children render immediately either way (capture/UI must never block on
  // this) — but PostHogProvider/PostHogSurveyProvider (which expose the
  // client to the SDK's own React tree and can trigger its own
  // replay/survey/flag activity) only mount once the startup-restore effect
  // has actually run and forced the client to a known state. Gating on just
  // `client !== null` would mount them on the very first render, before that
  // effect (which only runs after commit) has had a chance to force a stale
  // SDK-persisted opt-in back out.
  if (!client || !ready) {
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
