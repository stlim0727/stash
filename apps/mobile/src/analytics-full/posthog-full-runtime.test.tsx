import { act, render, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

// A fake PostHog client shared between the mocked class constructor and the
// mocked `usePostHog()` hook, so `PostHogFullScreenTracker` (which calls
// `usePostHog()`) observes the same instance `PostHogFullProvider` created.
let lastClientInstance: { optIn: jest.Mock; optOut: jest.Mock; reset: jest.Mock; screen: jest.Mock } | null =
  null;
const mockOptIn = jest.fn(async () => {});
const mockOptOut = jest.fn(async () => {});
const mockReset = jest.fn();
const mockScreen = jest.fn(async () => {});

jest.mock('posthog-react-native', () => {
  class MockPostHog {
    optIn = mockOptIn;
    optOut = mockOptOut;
    reset = mockReset;
    screen = mockScreen;
    constructor(..._args: unknown[]) {
      mockSetLastClientInstance(this);
    }
  }
  return {
    PostHog: MockPostHog,
    PostHogProvider: ({ children }: { children: ReactNode }) => children,
    PostHogSurveyProvider: ({ children }: { children: ReactNode }) => children,
    usePostHog: () => mockGetLastClientInstance(),
  };
});

function mockSetLastClientInstance(instance: typeof lastClientInstance) {
  lastClientInstance = instance;
}
function mockGetLastClientInstance() {
  return lastClientInstance;
}

let mockPathname = '/';
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
}));

let mockStorage: Record<string, string> = {};
const mockSetPreference = jest.fn(async (key: string, value: string) => {
  mockStorage[key] = value;
});
jest.mock('@/storage/preferences', () => ({
  getPreference: async (key: string) => mockStorage[key] ?? null,
  setPreference: async (key: string, value: string) => mockSetPreference(key, value),
}));

let mockBaseAnalyticsEnabled = true;
jest.mock('@/analytics/posthog', () => ({
  getPostHogAnalyticsEnabled: async () => mockBaseAnalyticsEnabled,
}));

import { PostHogFullProvider, usePostHogFull } from './posthog-full-runtime.tsx';
import { POSTHOG_FULL_ENABLED_STORAGE_KEY } from './posthog-full-config.ts';

type ProbeState = ReturnType<typeof usePostHogFull>;

function StateProbe({ onState }: { onState: (state: ProbeState) => void }) {
  const state = usePostHogFull();
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  return null;
}

async function renderProvider() {
  const states: ProbeState[] = [];
  const screen = await render(
    <PostHogFullProvider>
      <StateProbe onState={(state) => states.push(state)} />
    </PostHogFullProvider>,
  );
  return { screen, states, latest: () => states[states.length - 1] };
}

const ENV_KEYS = [
  'EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED',
  'EXPO_PUBLIC_POSTHOG_API_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
];

function enableBuildGate() {
  process.env.EXPO_PUBLIC_POSTHOG_FULL_SDK_ENABLED = 'true';
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_test';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://eu.i.posthog.com';
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  lastClientInstance = null;
  mockStorage = {};
  mockBaseAnalyticsEnabled = true;
  mockPathname = '/';
});

test('with no build-time gate, ready flips true immediately and configured stays false', async () => {
  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().ready).toBe(true));
  expect(latest().configured).toBe(false);
  expect(latest().enabled).toBe(false);
  expect(lastClientInstance).toBeNull();
});

test('restores session replay on startup when both the own and base consent are on', async () => {
  enableBuildGate();
  mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY] = 'true';
  mockBaseAnalyticsEnabled = true;

  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().ready).toBe(true));

  expect(mockOptIn).toHaveBeenCalledTimes(1);
  expect(latest().enabled).toBe(true);
});

test('does not restore, and self-heals the stale preference, when base analytics consent is off', async () => {
  enableBuildGate();
  mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY] = 'true';
  mockBaseAnalyticsEnabled = false;

  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().ready).toBe(true));

  expect(mockOptIn).not.toHaveBeenCalled();
  expect(latest().enabled).toBe(false);
  expect(mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY]).toBe('false');
});

test('setEnabled(true) rolls back (opts back out) if persisting the preference fails', async () => {
  enableBuildGate();
  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().ready).toBe(true));

  mockSetPreference.mockRejectedValueOnce(new Error('storage unavailable'));

  await act(async () => {
    await expect(latest().setEnabled(true)).rejects.toThrow('storage unavailable');
  });

  expect(mockOptIn).toHaveBeenCalledTimes(1);
  // Rolled back: the client must not be left silently collecting while
  // Settings would report it as off.
  expect(mockOptOut).toHaveBeenCalledTimes(1);
  expect(mockReset).toHaveBeenCalledTimes(1);
  expect(latest().enabled).toBe(false);
});

test('setEnabled(false) opts out, resets identity, and persists', async () => {
  enableBuildGate();
  mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY] = 'true';
  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().enabled).toBe(true));

  await act(async () => {
    await latest().setEnabled(false);
  });

  expect(mockOptOut).toHaveBeenCalledTimes(1);
  expect(mockReset).toHaveBeenCalledTimes(1);
  expect(mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY]).toBe('false');
  expect(latest().enabled).toBe(false);
});

test('a rapid enable-then-disable (the Settings cascade race) always ends opted out', async () => {
  enableBuildGate();
  const { latest } = await renderProvider();
  await waitFor(() => expect(latest().ready).toBe(true));

  // Artificially delay optIn so, without serialization, the disable call's
  // optOut() could physically land on the client before this pending optIn
  // resolves — exactly what a user rapidly turning replay on then off (or
  // the Settings cascade turning off base analytics right after) can hit.
  let releaseOptIn: (() => void) | undefined;
  mockOptIn.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseOptIn = resolve;
      }),
  );

  const enablePromise = latest().setEnabled(true);
  const disablePromise = latest().setEnabled(false);

  // Let the queued enable task actually start (its `client.optIn()` call is
  // what assigns `releaseOptIn`) before releasing it — otherwise there is
  // nothing yet to release and both promises hang forever.
  await waitFor(() => expect(mockOptIn).toHaveBeenCalledTimes(1));
  // The disable call must not have started its own client work yet — it's
  // queued behind the still-in-flight enable call, not racing it.
  expect(mockOptOut).not.toHaveBeenCalled();

  releaseOptIn?.();
  await act(async () => {
    await Promise.all([enablePromise, disablePromise]);
  });

  expect(mockOptIn).toHaveBeenCalledTimes(1);
  expect(mockOptOut).toHaveBeenCalledTimes(1);
  expect(latest().enabled).toBe(false);
  expect(mockStorage[POSTHOG_FULL_ENABLED_STORAGE_KEY]).toBe('false');
});

test('captures screen views only for allowlisted routes, through posthog.screen()', async () => {
  enableBuildGate();
  mockPathname = '/bookmark/e7f2c1a0-0000-4000-8000-000000000001';
  await renderProvider();

  await waitFor(() => expect(mockScreen).toHaveBeenCalledWith('bookmark_detail'));
});

test('does not call posthog.screen() for a route outside the allowlist', async () => {
  enableBuildGate();
  mockPathname = '/auth/callback?code=secret';
  await renderProvider();

  await waitFor(() => expect(lastClientInstance).not.toBeNull());
  expect(mockScreen).not.toHaveBeenCalled();
});
