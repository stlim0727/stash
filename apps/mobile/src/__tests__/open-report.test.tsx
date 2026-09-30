import { act, renderHook } from '@testing-library/react-native';

const mockPush = jest.fn();
const mockCapture = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/feedback/screenshot', () => ({ captureFeedbackScreenshot: (...args: unknown[]) => mockCapture(...args) }));
jest.mock('@/feedback/hero-diagnostics-session', () => ({
  getHeroDiagnosticsSnapshot: () => null,
  getHeroDomDiagnostics: () => null,
}));

import { useOpenReport } from '@/feedback/open-report';
import { clearPendingFeedbackScreenshot, getPendingFeedbackScreenshot, getPendingFeedbackSource } from '@/feedback/screenshot-session';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  clearPendingFeedbackScreenshot();
});
afterEach(() => jest.useRealTimers());

it('waits for menu dismissal, captures the source, and ignores double activation', async () => {
  const screenshot = { dataUrl: 'data:image/jpeg;base64,fixture', surface: 'inbox', capturedAt: '2026-09-30T00:00:00Z' };
  mockCapture.mockResolvedValue(screenshot);
  const { result } = await renderHook(() => useOpenReport('/'));
  let pending: Promise<void>;
  await act(() => {
    pending = result.current.openReport();
    void result.current.openReport();
  });
  expect(mockCapture).not.toHaveBeenCalled();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(350);
    await pending!;
  });
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(getPendingFeedbackScreenshot()).toEqual(screenshot);
  expect(getPendingFeedbackSource()).toEqual({ route: '/', surface: 'inbox' });
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/report');
});

it('opens within three seconds when capture hangs and ignores a late screenshot', async () => {
  let finish: (value: unknown) => void = () => {};
  mockCapture.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { result } = await renderHook(() => useOpenReport('/settings'));
  await act(() => { void result.current.openReport(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(mockPush).toHaveBeenCalledWith('/report');
  expect(getPendingFeedbackScreenshot()).toBeNull();
  await act(async () => { finish({ dataUrl: 'late' }); });
  expect(getPendingFeedbackScreenshot()).toBeNull();
});

it('still opens the form when screenshot capture rejects', async () => {
  mockCapture.mockRejectedValue(new Error('capture unavailable'));
  const { result } = await renderHook(() => useOpenReport('/settings'));
  await act(() => { void result.current.openReport(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(350); });
  expect(mockPush).toHaveBeenCalledWith('/report');
  expect(getPendingFeedbackScreenshot()).toBeNull();
});
