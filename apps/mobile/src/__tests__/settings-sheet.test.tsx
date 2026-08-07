import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    email: null,
    displayName: null,
    avatarUrl: null,
    isSignedIn: true,
    userId: 'user-1',
    message: '',
    signIn: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => {}),
    ensureAnonymousSession: jest.fn(async () => null),
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => false);
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    replace: mockReplace,
    back: mockBack,
    canGoBack: mockCanGoBack,
  }),
}));

// Drive the responsive sheet rule off a controllable viewport.
const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

test('wide viewport renders the side-sheet backdrop', async () => {
  mockWindowSize.width = 1280;
  const screen = await renderSettings();
  expect(screen.getByTestId('settings-sheet-backdrop')).toBeTruthy();
});

test('phone viewport renders full-screen with no backdrop', async () => {
  mockWindowSize.width = 390;
  const screen = await renderSettings();
  expect(screen.queryByTestId('settings-sheet-backdrop')).toBeNull();
});

test('close button replaces to root route when router.canGoBack is false', async () => {
  mockWindowSize.width = 1280;
  mockCanGoBack.mockReturnValue(false);
  const screen = await renderSettings();
  const closeButtons = screen.getAllByLabelText('Close');
  fireEvent.press(closeButtons[0]);
  expect(mockReplace).toHaveBeenCalledWith('/');
});

// Settings is a transparentModal with the Inbox mounted behind it. On web the
// modal container sizes to content, so a `flex: 1` root collapses and the Inbox
// bleeds through below Settings. Pinning the root to the viewport height keeps
// the opaque background covering the full screen.
test('phone viewport pins the full-screen root to the viewport height', async () => {
  mockWindowSize.width = 390;
  mockWindowSize.height = 844;
  const screen = await renderSettings();
  const root = screen.getByTestId('settings-fullscreen');
  const flat = Array.isArray(root.props.style)
    ? Object.assign({}, ...root.props.style.flat())
    : root.props.style;
  expect(flat.height).toBe(844);
});
