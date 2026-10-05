import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useNetworkOffline } from '@/ui/use-network-offline';
import type { NetworkState } from 'expo-network';

let mockListener: (state: NetworkState) => void;
const mockRemove = jest.fn();
const mockGet = jest.fn();
let mockAppStateListener: (state: AppStateStatus) => void;
const mockAppStateRemove = jest.fn();
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: typeof mockListener) => { mockListener = listener; return { remove: mockRemove }; },
  getNetworkStateAsync: () => mockGet(),
}));
beforeEach(() => {
  mockGet.mockReset();
  mockRemove.mockClear();
  mockAppStateRemove.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    mockAppStateListener = listener;
    return { remove: mockAppStateRemove };
  });
});
afterEach(() => { jest.restoreAllMocks(); });

test('unknown and rejected observations are not treated as offline; listeners clean up', async () => {
  mockGet.mockRejectedValue(new Error('Observer unavailable'));
  const screen = await renderHook(() => useNetworkOffline());
  expect(screen.result.current).toBe(false);
  await act(async () => { mockListener({}); });
  expect(screen.result.current).toBe(false);
  await act(async () => { mockListener({ isConnected: false }); });
  expect(screen.result.current).toBe(true);
  await act(async () => { mockListener({ isConnected: true, isInternetReachable: true }); });
  expect(screen.result.current).toBe(false);
  await screen.unmount();
  expect(mockRemove).toHaveBeenCalledTimes(1);
});

test('a late initial observation cannot overwrite a more recent disconnect event', async () => {
  let settle!: (state: NetworkState) => void;
  mockGet.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  const screen = await renderHook(() => useNetworkOffline());
  await act(async () => { mockListener({ isInternetReachable: false }); });
  expect(screen.result.current).toBe(true);
  await act(async () => { settle({ isConnected: true, isInternetReachable: true }); });
  expect(screen.result.current).toBe(true);
});


test('unknown events neither supersede initial connectivity nor erase a known disconnect', async () => {
  let settle!: (state: NetworkState) => void;
  mockGet.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  const screen = await renderHook(() => useNetworkOffline());
  await act(async () => { mockListener({}); });
  await act(async () => { settle({ isConnected: false }); });
  expect(screen.result.current).toBe(true);
  await act(async () => { mockListener({}); });
  expect(screen.result.current).toBe(true);
  await screen.unmount();
});

test('STASH-7E: foreground refresh clears a disconnect whose reconnect event was missed', async () => {
  mockGet.mockResolvedValue({ isConnected: true, isInternetReachable: true });
  const screen = await renderHook(() => useNetworkOffline());
  await act(async () => { mockListener({ isConnected: false }); });
  expect(screen.result.current).toBe(true);
  await act(async () => { mockAppStateListener('background'); });
  await act(async () => { mockAppStateListener('active'); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(screen.result.current).toBe(false);
  await screen.unmount();
  expect(mockAppStateRemove).toHaveBeenCalledTimes(1);
});

test('a foreground query cannot overwrite a newer disconnect event', async () => {
  mockGet.mockResolvedValueOnce({ isConnected: true });
  const screen = await renderHook(() => useNetworkOffline());
  let settle!: (state: NetworkState) => void;
  mockGet.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  await act(async () => { mockAppStateListener('background'); mockAppStateListener('active'); });
  await act(async () => { mockListener({ isConnected: false }); });
  await act(async () => { settle({ isConnected: true }); });
  expect(screen.result.current).toBe(true);
});

test('queries from an earlier foreground session cannot overwrite the latest refresh', async () => {
  const settle: ((state: NetworkState) => void)[] = [];
  mockGet.mockImplementation(() => new Promise((resolve) => { settle.push(resolve); }));
  const screen = await renderHook(() => useNetworkOffline());
  await act(async () => { mockAppStateListener('background'); mockAppStateListener('active'); });
  await act(async () => { settle[1]!({ isConnected: true }); });
  await act(async () => { settle[0]!({ isConnected: false }); });
  expect(screen.result.current).toBe(false);
  await act(async () => { mockAppStateListener('background'); mockAppStateListener('active'); });
  await act(async () => { mockAppStateListener('background'); });
  await act(async () => { settle[2]!({ isConnected: false }); });
  expect(screen.result.current).toBe(false);
});

test('native UNKNOWN false flags are not an offline diagnosis or a newer observation', async () => {
  let settle!: (state: NetworkState) => void;
  mockGet.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  const screen = await renderHook(() => useNetworkOffline());
  const unknown = { type: 'UNKNOWN' as NetworkState['type'], isConnected: false, isInternetReachable: false };
  await act(async () => { mockListener(unknown); });
  expect(screen.result.current).toBe(false);
  await act(async () => { settle({ isConnected: false }); });
  expect(screen.result.current).toBe(true);
  mockGet.mockResolvedValue(unknown);
  await act(async () => { mockAppStateListener('background'); mockAppStateListener('active'); });
  expect(screen.result.current).toBe(true);
});
