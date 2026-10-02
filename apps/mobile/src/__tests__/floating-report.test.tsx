import { act, fireEvent, render, renderHook } from '@testing-library/react-native';
import { Text, View } from 'react-native';

const mockPush = jest.fn();
const mockCapture = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/',
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/feedback/screenshot', () => ({
  captureFeedbackScreenshot: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock('@/feedback/hero-diagnostics-session', () => ({
  getHeroDiagnosticsSnapshot: () => null,
  getHeroDomDiagnostics: () => null,
}));

let mockPreferences: Record<string, string> = {};
jest.mock('@/storage/preferences', () => ({
  getPreference: jest.fn(async (key: string) => mockPreferences[key] ?? null),
  setPreference: jest.fn(async (key: string, val: string) => {
    mockPreferences[key] = val;
  }),
}));

let mockIsLoading = false;
jest.mock('@/store/bookmarks', () => ({
  useBookmarks: () => ({ isLoading: mockIsLoading }),
}));
jest.mock('@/ui/capture-toast', () => ({
  useCaptureToast: () => ({ isVisible: false }),
}));

import {
  FLOATING_REPORT_PREF_KEY,
  setFloatingReportPreference,
  useFloatingReportPreference,
} from '@/feedback/floating-report-preference';
import { FloatingReportButton } from '@/feedback/FloatingReportButton';
import { clearPendingFeedbackScreenshot, getPendingFeedbackScreenshot } from '@/feedback/screenshot-session';

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockPreferences = {};
  mockIsLoading = false;
  clearPendingFeedbackScreenshot();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('useFloatingReportPreference', () => {
  it('defaults to false when preference is empty', async () => {
    const { result } = await renderHook(() => useFloatingReportPreference());
    expect(result.current[0]).toBe(false);
  });

  it('reads true when preference is saved as true', async () => {
    mockPreferences[FLOATING_REPORT_PREF_KEY] = 'true';
    const { result } = await renderHook(() => useFloatingReportPreference());
    expect(result.current[0]).toBe(true);
  });

  it('updates preference and notifies listeners reactively', async () => {
    const hook1 = await renderHook(() => useFloatingReportPreference());
    const hook2 = await renderHook(() => useFloatingReportPreference());

    expect(hook1.result.current[0]).toBe(false);
    expect(hook2.result.current[0]).toBe(false);

    await act(async () => {
      hook1.result.current[1](true);
    });

    expect(hook1.result.current[0]).toBe(true);
    expect(hook2.result.current[0]).toBe(true);
    expect(mockPreferences[FLOATING_REPORT_PREF_KEY]).toBe('true');
  });
});

describe('FloatingReportButton', () => {
  it('renders children and hides button when enabled is false', async () => {
    const screen = await render(
      <FloatingReportButton enabled={false}>
        <Text>Content Screen</Text>
      </FloatingReportButton>,
    );

    expect(screen.getByText('Content Screen')).toBeTruthy();
    expect(screen.queryByLabelText('Report a problem')).toBeNull();
  });

  it('renders button when enabled is true and triggers report on press', async () => {
    const screenshot = {
      dataUrl: 'data:image/jpeg;base64,sample',
      surface: 'inbox',
      capturedAt: '2026-10-02T00:00:00Z',
    };
    mockCapture.mockResolvedValue(screenshot);

    const screen = await render(
      <FloatingReportButton enabled={true}>
        <Text>Content Screen</Text>
      </FloatingReportButton>,
    );

    expect(screen.getByText('Content Screen')).toBeTruthy();
    const button = screen.getByLabelText('Report a problem');
    expect(button).toBeTruthy();

    await act(async () => {
      fireEvent.press(button);
      await jest.advanceTimersByTimeAsync(100);
    });

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(getPendingFeedbackScreenshot()).toEqual(screenshot);
    expect(mockPush).toHaveBeenCalledWith('/report');
  });
});
