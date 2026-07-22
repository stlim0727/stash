import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { AppState, Platform } from 'react-native';

import { createAppOpenEvent, createScreenViewedEvent } from './events.ts';
import type { AnalyticsAuthState, AnalyticsPlatform } from './events.ts';
import { FreshLaunchBooleanFlag } from './fresh-flag.ts';
import {
  AD_EXPERIMENT_FLAG_KEY,
  clearPostHogAnalyticsState,
  createPostHogTransport,
  getPostHogAnalyticsEnabled,
} from './posthog.ts';
import { analyticsScreenForPath } from './route.ts';
import { AnalyticsRuntime } from './runtime.ts';
import { useBookmarks } from '@/store/bookmarks';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import type { SupabaseAuthStatus } from '@/supabase/auth-provider';

interface AnalyticsContextValue {
  enabled: boolean;
  ready: boolean;
  adExperimentEnabled: boolean;
  setEnabled(enabled: boolean): Promise<void>;
  capture(event: unknown): void;
}

const disabledAnalyticsContext: AnalyticsContextValue = {
  enabled: false,
  ready: false,
  adExperimentEnabled: false,
  setEnabled: async () => {},
  capture: () => {},
};

const AnalyticsContext = createContext<AnalyticsContextValue>(disabledAnalyticsContext);

function analyticsAuthState(status: SupabaseAuthStatus): AnalyticsAuthState | null {
  if (
    status === 'anonymous' ||
    status === 'authenticated' ||
    status === 'signed_out' ||
    status === 'session_expired' ||
    status === 'not_configured'
  ) {
    return status;
  }
  return null;
}

function analyticsPlatform(): AnalyticsPlatform | null {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web'
    ? Platform.OS
    : null;
}

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const { isLoading } = useBookmarks();
  const auth = useSupabaseAuth();
  const pathname = usePathname();
  const runtimeRef = useRef<AnalyticsRuntime | null>(null);
  if (runtimeRef.current === null) {
    runtimeRef.current = new AnalyticsRuntime(createPostHogTransport);
  }
  const runtime = runtimeRef.current;
  const adFlagRef = useRef<FreshLaunchBooleanFlag | null>(null);
  if (adFlagRef.current === null) {
    adFlagRef.current = new FreshLaunchBooleanFlag();
    adFlagRef.current.startLaunch();
  }
  const adFlag = adFlagRef.current;

  const [enabled, setEnabledState] = useState(false);
  const [ready, setReady] = useState(false);
  const [adExperimentEnabled, setAdExperimentEnabled] = useState(false);
  const appOpenCaptured = useRef(false);

  const captureAppOpen = useCallback(() => {
    if (appOpenCaptured.current) return;
    const platform = analyticsPlatform();
    const authState = analyticsAuthState(auth.status);
    if (!platform || !authState) return;
    runtime.capture(createAppOpenEvent(platform, authState));
    appOpenCaptured.current = true;
  }, [auth.status, runtime]);

  useEffect(() => {
    if (isLoading || ready) return;

    let active = true;
    void getPostHogAnalyticsEnabled()
      .then(async (storedEnabled) => {
        if (!active || !storedEnabled) return;
        const connected = await runtime.enable();
        if (!active || !connected) {
          void runtime.disable();
          return;
        }
        setEnabledState(true);
        setAdExperimentEnabled(
          await adFlag.refresh(() => runtime.reloadBooleanFlag(AD_EXPERIMENT_FLAG_KEY)),
        );
      })
      .catch(() => {
        void runtime.disable();
      })
      .finally(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
    };
  }, [adFlag, isLoading, ready, runtime]);

  useEffect(() => {
    if (enabled) captureAppOpen();
  }, [captureAppOpen, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const screen = analyticsScreenForPath(pathname);
    if (screen) runtime.capture(createScreenViewedEvent(screen));
  }, [enabled, pathname, runtime]);

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      const resumed = next === 'active' && previous !== 'active';
      previous = next;
      if (!enabled || !resumed) return;

      appOpenCaptured.current = false;
      captureAppOpen();
      const screen = analyticsScreenForPath(pathname);
      if (screen) runtime.capture(createScreenViewedEvent(screen));
    });
    return () => subscription.remove();
  }, [captureAppOpen, enabled, pathname, runtime]);

  const setEnabled = useCallback(
    async (nextEnabled: boolean) => {
      if (!nextEnabled) {
        const cleanup = runtime.disable();
        adFlag.startLaunch();
        setAdExperimentEnabled(false);
        setEnabledState(false);
        appOpenCaptured.current = false;
        await Promise.all([
          cleanup,
          clearPostHogAnalyticsState(),
        ]);
        return;
      }

      // A fresh opt-in never revives a pre-opt-out queue or identifier. Startup
      // reuse is handled separately above when the stored consent is already on.
      await clearPostHogAnalyticsState();
      const connected = await runtime.enable(true);
      if (!connected) return;
      setEnabledState(true);
      setAdExperimentEnabled(
        await adFlag.refresh(() => runtime.reloadBooleanFlag(AD_EXPERIMENT_FLAG_KEY)),
      );
    },
    [adFlag, runtime],
  );

  const capture = useCallback(
    (event: unknown) => {
      runtime.capture(event);
    },
    [runtime],
  );

  const value = useMemo(
    () => ({ enabled, ready, adExperimentEnabled, setEnabled, capture }),
    [adExperimentEnabled, enabled, ready, setEnabled, capture],
  );

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function useAnalytics() {
  return useContext(AnalyticsContext);
}
