import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Mutable auth mock so each test can pick anonymous / authenticated / not_configured.
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
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.status = 'anonymous';
  mockAuth.email = null;
  mockAuth.displayName = null;
  mockAuth.isSignedIn = true;
});

test('anonymous: shows Sign In with provider buttons, and "all backed up" sync', async () => {
  const screen = await renderSettings();

  expect(screen.getByText('Sign In')).toBeTruthy();
  // Nothing queued + a cloud session (anonymous counts) → backed up, not "local only".
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Sign in with Google'));
  });
  expect(mockAuth.signIn).toHaveBeenCalledWith('google');
});

test('authenticated: shows the email and a Sign out button that signs out', async () => {
  mockAuth.status = 'authenticated';
  mockAuth.email = 'me@example.com';
  const screen = await renderSettings();

  expect(screen.getByText('me@example.com')).toBeTruthy();
  expect(screen.queryByLabelText('Sign in with Google')).toBeNull();

  await act(async () => {
    fireEvent.press(screen.getByText('Sign out'));
  });
  expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
});

test('not configured: sync is local-only and no sign-in buttons are shown', async () => {
  mockAuth.status = 'not_configured';
  mockAuth.isSignedIn = false;
  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());
  expect(screen.queryByLabelText('Sign in with Apple')).toBeNull();
  expect(screen.queryByText('Sign out')).toBeNull();
});
