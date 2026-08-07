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
