import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
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

test('authenticated: Sign out asks to confirm before signing out', async () => {
  mockAuth.status = 'authenticated';
  mockAuth.email = 'me@example.com';
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = await renderSettings();

  expect(screen.getByText('me@example.com')).toBeTruthy();
  expect(screen.queryByLabelText('Sign in with Google')).toBeNull();

  // Tapping Sign out shows the confirmation dialog but does NOT sign out yet.
  await act(async () => {
    fireEvent.press(screen.getByText('Sign out'));
  });
  expect(alertSpy).toHaveBeenCalledTimes(1);
  expect(mockAuth.signOut).not.toHaveBeenCalled();

  // The dialog reassures and offers Cancel + a destructive Sign out.
  const [title, body, buttons] = alertSpy.mock.calls[0];
  expect(title).toBe('Sign out of Keepory?');
  expect(body).toBe(
    'Your bookmarks are safely backed up to your account. Sign back in anytime to see them again.',
  );
  const cancel = buttons?.find((b) => b.style === 'cancel');
  const confirm = buttons?.find((b) => b.style === 'destructive');
  expect(cancel?.text).toBe('Cancel');
  expect(confirm?.text).toBe('Sign out');

  // Confirming runs the actual sign-out.
  await act(async () => {
    confirm?.onPress?.();
  });
  expect(mockAuth.signOut).toHaveBeenCalledTimes(1);

  alertSpy.mockRestore();
});

test('authenticated: cancelling the confirm does not sign out', async () => {
  mockAuth.status = 'authenticated';
  mockAuth.email = 'me@example.com';
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = await renderSettings();

  await act(async () => {
    fireEvent.press(screen.getByText('Sign out'));
  });
  const buttons = alertSpy.mock.calls[0][2];
  const cancel = buttons?.find((b) => b.style === 'cancel');
  await act(async () => {
    cancel?.onPress?.();
  });
  expect(mockAuth.signOut).not.toHaveBeenCalled();

  alertSpy.mockRestore();
});

test('not configured: sync is local-only and no sign-in buttons are shown', async () => {
  mockAuth.status = 'not_configured';
  mockAuth.isSignedIn = false;
  const screen = await renderSettings();

  await waitFor(() => expect(screen.getByText('Local only')).toBeTruthy());
  expect(screen.queryByLabelText('Sign in with Apple')).toBeNull();
  expect(screen.queryByText('Sign out')).toBeNull();
});
