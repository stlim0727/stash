import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

// The Inbox first-run empty state and the anonymous-account nudge banner.
// - Native teaches the share-sheet capture (a 2-step walkthrough); web has no
//   share intent (expo-share-intent is a no-op there), so it gets a distinct
//   paste-a-link variant instead of promising a flow that doesn't exist.
// - The nudge banner offers an anonymous user a one-tap route to sign in, but
//   only once their local library is real (2+ bookmarks), and never again
//   once dismissed.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Mutable auth mock so each test can pick anonymous / authenticated / signed out.
const mockAuth = {
  status: 'anonymous' as 'anonymous' | 'authenticated' | 'not_configured',
  email: null as string | null,
  displayName: null as string | null,
  avatarUrl: null as string | null,
  isSignedIn: true,
  userId: 'user-1' as string | null,
  message: '',
  signIn: jest.fn(async () => ({ ok: true })),
  signOut: jest.fn(async () => {}),
  ensureAnonymousSession: jest.fn(async () => null),
};
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => ({ push: mockPush, navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    usePathname: () => '/',
    useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, []),
  };
});

import InboxScreen from '@/app/index';
import { BookmarksProvider } from '@/store/bookmarks';
import { CaptureToastProvider } from '@/ui/capture-toast';
import { ANONYMOUS_NUDGE_DISMISSED_PREF_KEY } from '@/ui/AnonymousNudgeBanner';
import { makeStoredBookmark } from './helpers/fake-repository';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const defaultPlatformOS = Platform.OS;
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderInbox() {
  return render(
    <BookmarksProvider>
      <CaptureToastProvider>
        <InboxScreen />
      </CaptureToastProvider>
    </BookmarksProvider>,
  );
}

function twoBookmarks() {
  return [
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000a1', title: 'First save' }),
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000a2', title: 'Second save' }),
  ];
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => defaultPlatformOS });
  mockPush.mockClear();
  mockAuth.status = 'anonymous';
  mockAuth.isSignedIn = true;
  fakeRepo.__reset([]);
});

test('native empty state teaches the share-capture flow as a numbered 2-step walkthrough', async () => {
  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(screen.getByText('Open any app, tap Share')).toBeTruthy();
  expect(screen.getByText('Choose Keepory — saved instantly')).toBeTruthy();
  // The secondary fallback line for the manual paste path.
  expect(screen.getByText('Prefer to paste a link? Tap the + below.')).toBeTruthy();
  // Never promises the (native-only) share flow's web-broken copy or the web variant.
  expect(screen.queryByText('Tap + to paste a link and save.')).toBeNull();
  expect(
    screen.queryByText('Sharing from other apps works in the Keepory Android app, not on the web yet.'),
  ).toBeNull();
});

test('web empty state points at paste-a-link instead of the (unavailable) share flow', async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('inbox-empty-onboarding')).toBeTruthy());
  expect(screen.getByText('Tap + to paste a link and save.')).toBeTruthy();
  expect(
    screen.getByText('Sharing from other apps works in the Keepory Android app, not on the web yet.'),
  ).toBeTruthy();
  expect(screen.getByText('Get the Android app')).toBeTruthy();
  // The native-only teach never renders on web.
  expect(screen.queryByText('Open any app, tap Share')).toBeNull();
  expect(screen.queryByText('Choose Keepory — saved instantly')).toBeNull();
});

test('the anonymous nudge does not show for a signed-in (authenticated) user, even with 2+ bookmarks', async () => {
  mockAuth.status = 'authenticated';
  fakeRepo.__reset(twoBookmarks());

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('First save')).toBeTruthy());
  expect(screen.queryByTestId('anonymous-nudge-banner')).toBeNull();
});

test('the anonymous nudge does not show until the 2nd save (1 bookmark stays quiet)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: '7e64cf1e-0000-4000-8000-0000000000b1', title: 'Only one' }),
  ]);

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByText('Only one')).toBeTruthy());
  expect(screen.queryByTestId('anonymous-nudge-banner')).toBeNull();
});

test('the anonymous nudge shows once an anonymous user has 2+ bookmarks, with a Sign in action', async () => {
  fakeRepo.__reset(twoBookmarks());

  const screen = await renderInbox();

  await waitFor(() => expect(screen.getByTestId('anonymous-nudge-banner')).toBeTruthy());
  expect(
    screen.getByText(
      'Your bookmarks are saved on this device. Sign in to back them up and access them elsewhere.',
    ),
  ).toBeTruthy();

  await fireEvent.press(screen.getByText('Sign In'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

test('dismissing the nudge hides it immediately and durably — it never reappears', async () => {
  fakeRepo.__reset(twoBookmarks());

  const screen = await renderInbox();
  await waitFor(() => expect(screen.getByTestId('anonymous-nudge-banner')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByTestId('anonymous-nudge-dismiss'));
  });
  expect(screen.queryByTestId('anonymous-nudge-banner')).toBeNull();

  // The dismissal is a durable local flag (repository meta store), not synced.
  await waitFor(() =>
    expect(fakeRepo.__meta(ANONYMOUS_NUDGE_DISMISSED_PREF_KEY)).toBe('1'),
  );

  // A fresh mount (simulating an app restart) must stay quiet too.
  const restarted = await renderInbox();
  await waitFor(() => expect(restarted.getByText('First save')).toBeTruthy());
  expect(restarted.queryByTestId('anonymous-nudge-banner')).toBeNull();
});
