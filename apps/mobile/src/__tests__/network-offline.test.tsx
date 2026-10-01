import { act, renderHook } from '@testing-library/react-native';
import { useNetworkOffline } from '@/ui/use-network-offline';
import type { NetworkState } from 'expo-network';

let mockListener: (state: NetworkState) => void;
const mockRemove = jest.fn();
const mockGet = jest.fn();
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: typeof mockListener) => { mockListener = listener; return { remove: mockRemove }; },
  getNetworkStateAsync: () => mockGet(),
}));
beforeEach(() => { mockGet.mockReset(); mockRemove.mockClear(); });

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
