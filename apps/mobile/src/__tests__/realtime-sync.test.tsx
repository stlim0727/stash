import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

const mockChannel = {
  on: jest.fn(function (this: unknown) {
    return this;
  }),
  subscribe: jest.fn(),
  send: jest.fn(),
  unsubscribe: jest.fn(),
};

const mockClient = {
  setAuth: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  channel: jest.fn(() => mockChannel),
};

jest.mock('@supabase/realtime-js', () => ({
  RealtimeClient: jest.fn(() => mockClient),
  RealtimeChannel: class {},
}));

jest.mock('@/supabase/config', () => ({
  getSupabaseConfigState: () => ({
    status: 'configured',
    config: { url: 'https://example.supabase.co', anonKey: 'anon-key' },
  }),
}));

jest.mock('@/storage/repository', () => ({
  repository: {
    // A synchronous thenable (not a real Promise) so the effect's
    // `.then(setDeviceId)` runs within the same render/commit instead of
    // racing a microtask tick — keeps the test deterministic without
    // reaching for fake timers.
    getMeta: jest.fn(() => ({ then: (resolve: (value: string) => void) => resolve('device-1') })),
    setMeta: jest.fn(async () => undefined),
  },
}));

import { useRealtimeSync } from '@/supabase/realtime';

const session = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  expires_in: 3600,
  user: { id: 'user-1' },
};

async function renderReadyHook() {
  const syncNow = jest.fn(async () => true);
  return renderHook(() =>
    useRealtimeSync({ session, status: 'authenticated', userId: 'user-1', syncNow }),
  );
}

beforeEach(() => {
  mockChannel.on.mockImplementation(function (this: unknown) {
    return this;
  });
  mockClient.channel.mockReturnValue(mockChannel);
  // connectSocket bails out unless the app is foregrounded; jest-expo's
  // AppState mock doesn't default this to 'active'.
  (AppState as unknown as { currentState: string }).currentState = 'active';
});

test('broadcastSyncNudge coalesces a burst of calls into a single send (Sentry STASH-5S)', async () => {
  // A backlog draining in small chunks can call broadcastSyncNudge many
  // times within a few seconds. Each call used to send immediately — and
  // when the realtime channel can't push over the websocket (a persistent
  // failure mode also seen in this session), every send() falls back to a
  // real REST POST, ~90 of which fired within 7 seconds on one report.
  const { result } = await renderReadyHook();

  await act(async () => {
    result.current.broadcastSyncNudge();
    result.current.broadcastSyncNudge();
    result.current.broadcastSyncNudge();
  });
  expect(mockChannel.send).not.toHaveBeenCalled();

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(mockChannel.send).toHaveBeenCalledTimes(1);
}, 10000);

test('broadcastSyncNudge sends again for a call after the debounce window elapses', async () => {
  const { result } = await renderReadyHook();

  await act(async () => {
    result.current.broadcastSyncNudge();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(mockChannel.send).toHaveBeenCalledTimes(1);

  await act(async () => {
    result.current.broadcastSyncNudge();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });
  expect(mockChannel.send).toHaveBeenCalledTimes(2);
}, 10000);

test('broadcastSyncNudge is a no-op before the channel/device id are ready', async () => {
  const syncNow = jest.fn(async () => true);
  const { result } = await renderHook(() =>
    useRealtimeSync({ session: null, status: 'anonymous', userId: null, syncNow }),
  );

  await act(async () => {
    result.current.broadcastSyncNudge();
  });
  expect(mockChannel.send).not.toHaveBeenCalled();
});

test('a new syncNow identity (session/status/userId unchanged) does not tear down and recreate the socket (Sentry STASH-K)', async () => {
  // `syncNow` is a useCallback keyed on the store's `auth`/`queue` state, so
  // it gets a brand-new identity on nearly every sync-driven re-render — a
  // busy sync pass can re-render dozens of times a second. If this hook
  // depended on `syncNow` directly, each of those would tear down the
  // websocket (disconnect) and build a whole new RealtimeClient + channel
  // (connect), which showed up as repeated "Subscribed to private channel"
  // log spam and contributed to the slow "react-cycle" segments behind
  // STASH-K's JS-thread stalls during active syncing.
  const { rerender } = await renderHook(
    ({ syncNow }: { syncNow: () => Promise<boolean> }) =>
      useRealtimeSync({ session, status: 'authenticated', userId: 'user-1', syncNow }),
    { initialProps: { syncNow: jest.fn(async () => true) } },
  );

  const connectCalls = mockClient.connect.mock.calls.length;
  const disconnectCalls = mockClient.disconnect.mock.calls.length;
  const channelCalls = mockClient.channel.mock.calls.length;

  await act(async () => {
    rerender({ syncNow: jest.fn(async () => true) });
  });
  await act(async () => {
    rerender({ syncNow: jest.fn(async () => true) });
  });

  expect(mockClient.connect.mock.calls.length).toBe(connectCalls);
  expect(mockClient.disconnect.mock.calls.length).toBe(disconnectCalls);
  expect(mockClient.channel.mock.calls.length).toBe(channelCalls);
});

test('a new session object with the same access token does not tear down and recreate the socket (Codex review on #764)', async () => {
  // `ensureAnonymousSession` calls `setSession(active)` unconditionally on
  // every sync pass (auth-provider.tsx) — a fresh object read from storage
  // even when the token itself hasn't changed. If this hook depended on the
  // `session` object directly (instead of its `access_token`), that alone
  // would reintroduce the STASH-K churn this file was already fixed for.
  const syncNow = jest.fn(async () => true);
  const { rerender } = await renderHook(
    ({ session: currentSession }: { session: typeof session }) =>
      useRealtimeSync({ session: currentSession, status: 'authenticated', userId: 'user-1', syncNow }),
    { initialProps: { session } },
  );

  const connectCalls = mockClient.connect.mock.calls.length;
  const disconnectCalls = mockClient.disconnect.mock.calls.length;
  const channelCalls = mockClient.channel.mock.calls.length;

  await act(async () => {
    // Same access_token/user, but a brand-new object — exactly what
    // restoreSession's "active" outcome hands back on a redundant call.
    rerender({ session: { ...session } });
  });

  expect(mockClient.connect.mock.calls.length).toBe(connectCalls);
  expect(mockClient.disconnect.mock.calls.length).toBe(disconnectCalls);
  expect(mockClient.channel.mock.calls.length).toBe(channelCalls);
});
