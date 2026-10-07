import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
let mockCloudAvailable = true;
let mockAuthStatus = 'anonymous';
let mockOffline = false;
jest.mock('@/ui/use-network-offline', () => ({ useNetworkOffline: () => mockOffline }));
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: mockAuthStatus,
    email: null,
    displayName: null,
    avatarUrl: null,
    isSignedIn: mockCloudAvailable,
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
  useLocalSearchParams: () => ({}),
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

const mockRetrySync = jest.fn(async () => true);
let mockRecoveryPhase: string | null = null;
jest.mock('@/store/bookmarks', () => {
  const actual = jest.requireActual('@/store/bookmarks');
  return { ...actual, useBookmarks: () => {
    const store = actual.useBookmarks();
    return mockRecoveryPhase ? { ...store, queue: [], isSyncing: false,
      librarySyncFlow: { phase: mockRecoveryPhase, remaining: mockRecoveryPhase === "offline" ? 1 : 0 }, syncNow: mockRetrySync } : store;
  } };
});

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


test.each(['attention', 'sign_in', 'permission'])('empty-queue %s failures expose an actual manual sync action', async (phase) => {
  mockRecoveryPhase = phase;
  mockRetrySync.mockClear();
  try {
    const screen = await renderSettings();
    await fireEvent.press(screen.getByLabelText('Sync'));
    expect(mockRetrySync).toHaveBeenCalledWith({ force: true });
    await screen.unmount();
  } finally { mockRecoveryPhase = null; }
});


test('offline pending work shows connectivity feedback instead of a no-op manual sync action', async () => {
  mockRecoveryPhase = 'offline';
  mockRetrySync.mockClear();
  try {
    const screen = await renderSettings();
    expect(screen.queryByLabelText('Sync')).toBeNull();
    expect(screen.getByLabelText('Will sync automatically when connected')).toBeTruthy();
    expect(mockRetrySync).not.toHaveBeenCalled();
    await screen.unmount();
  } finally { mockRecoveryPhase = null; }
});


test.each([['retrying', 'Sync delayed · retrying automatically'], ['attention', 'Sync needs attention. Review the details in Settings.'], ['sign_in', 'Sync needs attention. Review the details in Settings.']])('empty-outbox %s does not claim all work complete', async (phase, copy) => {
  mockRecoveryPhase = phase;
  try {
    const screen = await renderSettings();
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByText('All work complete')).toBeNull();
    await screen.unmount();
  } finally { mockRecoveryPhase = null; }
});


test.each(['working', 'paused', 'offline'])('local-only %s does not advertise cloud progress', async (phase) => {
  mockCloudAvailable = false;
  mockAuthStatus = 'not_configured';
  mockRecoveryPhase = phase;
  try {
    const screen = await renderSettings();
    expect(screen.getByText('All work complete')).toBeTruthy();
    expect(screen.queryByLabelText('Sync')).toBeNull();
    expect(screen.queryByLabelText('Will sync automatically when connected')).toBeNull();
    await screen.unmount();
  } finally { mockCloudAvailable = true; mockAuthStatus = 'anonymous'; mockRecoveryPhase = null; }
});

test.each(['sign_in', 'permission', 'attention'])('offline %s has no enabled cloud retry', async (phase) => {
  mockOffline = true;
  mockRecoveryPhase = phase;
  mockRetrySync.mockClear();
  try {
    const screen = await renderSettings();
    expect(screen.queryByLabelText('Sync')).toBeNull();
    expect(screen.getByLabelText('Will sync automatically when connected')).toBeTruthy();
    expect(mockRetrySync).not.toHaveBeenCalled();
    await screen.unmount();
  } finally { mockOffline = false; mockRecoveryPhase = null; }
});


test('session recovery remains actionable without cloud availability', async () => {
  mockCloudAvailable = false;
  mockAuthStatus = 'error';
  mockRecoveryPhase = 'sign_in';
  try {
    const screen = await renderSettings();
    expect(screen.queryByText('All work complete')).toBeNull();
    expect(screen.getByLabelText('Sign in with Google')).toBeTruthy();
    await screen.unmount();
  } finally { mockCloudAvailable = true; mockAuthStatus = 'anonymous'; mockRecoveryPhase = null; }
});

test('settings renders floating report button toggle', async () => {
  const screen = await renderSettings();
  expect(screen.getByTestId('settings-floating-report-row')).toBeTruthy();
  expect(screen.getByLabelText('Floating report button')).toBeTruthy();
  await screen.unmount();
});
