// Unit coverage for the platform guards in `@/share/return-to-app`. The native
// `Activity.moveTaskToBack` itself can only be exercised in a real Android build
// (no emulator here), so we stub `react-native` (Platform/ToastAndroid) and the
// optional native module and assert the branching: Android confirms with a
// floating OS toast and returns to the previous app; everywhere else it no-ops
// so the caller falls back to the in-app toast and stays put.

let mockPlatformOS = 'android';
const mockToastShow = jest.fn();
let mockNative: { moveTaskToBack: jest.Mock } | null = null;

jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
    select: (specifics: Record<string, unknown>) =>
      specifics[mockPlatformOS] ?? specifics.default,
  },
  ToastAndroid: {
    show: (...args: unknown[]) => mockToastShow(...args),
    SHORT: 0,
  },
}));

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => mockNative,
}));

import { returnToPreviousApp, showSystemToast } from '@/share/return-to-app';

beforeEach(() => {
  mockPlatformOS = 'android';
  mockNative = { moveTaskToBack: jest.fn(() => true) };
  mockToastShow.mockClear();
});

describe('showSystemToast', () => {
  it('shows a floating OS toast on Android', () => {
    expect(showSystemToast('Saved to Stash')).toBe(true);
    expect(mockToastShow).toHaveBeenCalledWith('Saved to Stash', 0);
  });

  it('is a no-op off Android (caller uses the in-app toast instead)', () => {
    mockPlatformOS = 'ios';
    expect(showSystemToast('Saved to Stash')).toBe(false);
    expect(mockToastShow).not.toHaveBeenCalled();
  });
});

describe('returnToPreviousApp', () => {
  it('moves the Android task to the background', () => {
    expect(returnToPreviousApp()).toBe(true);
    expect(mockNative?.moveTaskToBack).toHaveBeenCalledTimes(1);
  });

  it('stays put off Android', () => {
    mockPlatformOS = 'ios';
    const native = mockNative;
    expect(returnToPreviousApp()).toBe(false);
    expect(native?.moveTaskToBack).not.toHaveBeenCalled();
  });

  it('stays put when the native module is not linked (Expo Go / tests)', () => {
    mockNative = null;
    expect(returnToPreviousApp()).toBe(false);
  });

  it('stays put if the native call throws', () => {
    mockNative = {
      moveTaskToBack: jest.fn(() => {
        throw new Error('no activity');
      }),
    };
    expect(returnToPreviousApp()).toBe(false);
  });
});
