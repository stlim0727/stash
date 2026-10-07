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
const mockSettingsParams: { focus?: string } = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => (mockSettingsParams),
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
  delete mockSettingsParams.focus;
  mockAuth.status = 'anonymous';
  mockAuth.email = null;
  mockAuth.displayName = null;
  mockAuth.isSignedIn = true;
});

test('anonymous: shows Sign In with provider buttons and complete processing', async () => {
  const screen = await renderSettings();

  expect(screen.getByText('Sign In')).toBeTruthy();
  expect(screen.queryByTestId('settings-account-sign-in-guide')).toBeNull();
  // Nothing queued + a cloud session (anonymous counts) → all work complete.
  await waitFor(() => expect(screen.getByText('All work complete')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Sign in with Google'));
  });
  expect(mockAuth.signIn).toHaveBeenCalledWith('google');
});

test('login shortcut highlights the account choices and calls the selected provider', async () => {
  mockSettingsParams.focus = 'account';
  const screen = await renderSettings();

  expect(screen.getByTestId('settings-account-sign-in-guide')).toHaveTextContent('Choose a sign-in method below.');
  expect(screen.getByTestId('settings-account-card')).toHaveStyle({ borderWidth: 2 });
  expect(screen.getByText('Sign in with Google')).toBeTruthy();
  expect(screen.getByText('Sign in with Apple')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Sign in with Google'));
  expect(mockAuth.signIn).toHaveBeenCalledWith('google');
});

test('cancelling sign-in leaves the targeted account choices available', async () => {
  mockSettingsParams.focus = 'account';
  mockAuth.signIn.mockResolvedValueOnce({ ok: false });
  const screen = await renderSettings();

  await fireEvent.press(screen.getByLabelText('Sign in with Apple'));
  expect(mockAuth.signIn).toHaveBeenCalledWith('apple');
  expect(screen.getByTestId('settings-account-sign-in-guide')).toBeTruthy();
  expect(screen.getByLabelText('Sign in with Google')).not.toBeDisabled();
});

test.each(['authenticated', 'not_configured'] as const)('targeted login guidance is hidden when auth is %s', async (status) => {
  mockSettingsParams.focus = 'account';
  mockAuth.status = status;
  const screen = await renderSettings();

  expect(screen.queryByTestId('settings-account-sign-in-guide')).toBeNull();
  expect(screen.getByTestId('settings-account-card')).not.toHaveStyle({ borderWidth: 2 });
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

test('not configured: cloud processing is local-only and no sign-in buttons are shown', async () => {
  mockAuth.status = 'not_configured';
  mockAuth.isSignedIn = false;
  const screen = await renderSettings();

  // The cloud stage row (with its "local only" detail) only renders once
  // Developer mode is on — the everyday screen shows just the one-line
  // Activity summary (STASH counter refactor).
  await waitFor(() => screen.getByLabelText('Developer mode'));
  fireEvent(screen.getByLabelText('Developer mode'), 'valueChange', true);
  await waitFor(() => screen.getByLabelText('Pending processing'));
  await fireEvent.press(screen.getByLabelText('Pending processing'));

  await waitFor(() =>
    expect(screen.getByText('0 bookmarks · local only')).toBeTruthy(),
  );
  expect(screen.queryByLabelText('Sign in with Apple')).toBeNull();
  expect(screen.queryByText('Sign out')).toBeNull();
});

test('renders Help & Guide section with tutorial row and opens tutorial modal', async () => {
  const screen = await renderSettings();

  expect(screen.getByText('Help & Guide')).toBeTruthy();
  expect(screen.getByText('Feature guide')).toBeTruthy();
  expect(screen.getByText('How Keepory works')).toBeTruthy();

  const tutorialRow = screen.getByTestId('settings-tutorial-row');
  await act(async () => {
    fireEvent.press(tutorialRow);
  });

  expect(screen.getByTestId('tutorial-modal')).toBeTruthy();
  expect(screen.getByTestId('tutorial-slide-0')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByTestId('tutorial-close-button'));
  });

  expect(screen.queryByTestId('tutorial-slide-0')).toBeNull();
});
