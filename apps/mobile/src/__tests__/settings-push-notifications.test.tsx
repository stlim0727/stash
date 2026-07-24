import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { ReactNode } from 'react';

// Mirrors settings-account.test.tsx's mocking harness.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Mutable auth mock so each test can pick anonymous / authenticated, with or
// without a session (push registration needs a real access token).
const mockAuth = {
  status: 'authenticated' as 'anonymous' | 'authenticated',
  email: 'ada@example.com',
  displayName: null as string | null,
  avatarUrl: null as string | null,
  isSignedIn: true,
  userId: 'user-1',
  message: '',
  session: {
    access_token: 'token-123',
    refresh_token: 'refresh-123',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 9999999999,
    user: { id: 'user-1', is_anonymous: false },
  },
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

const mockWindowSize = { width: 390, height: 844, scale: 2, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindowSize,
}));

// The native permission/token-minting flow (expo-notifications) and the
// Supabase-backed register/deregister calls are mocked at the module
// boundary — this suite is about the Settings screen's own decisions
// (gating, state, wiring), not expo-notifications or network behavior,
// which are covered by push-permission.test.ts /
// push-token-registration.test.ts.
const mockRequestPushPermissionAndToken = jest.fn();
jest.mock('@/notifications/push-permission', () => ({
  requestPushPermissionAndToken: (...args: unknown[]) =>
    mockRequestPushPermissionAndToken(...args),
}));
const mockRegisterPushToken = jest.fn();
const mockDeregisterPushToken = jest.fn();
jest.mock('@/notifications/push-token-registration', () => ({
  registerPushToken: (...args: unknown[]) => mockRegisterPushToken(...args),
  deregisterPushToken: (...args: unknown[]) => mockDeregisterPushToken(...args),
}));
// Deliberately NOT mocking `@/supabase/client` (the store's own sync path
// shares that module) — mocking `createDefaultPushTokenWriter` here keeps
// this test isolated to Settings' own decisions without a real client.
jest.mock('@/notifications/push-token-client', () => ({
  createDefaultPushTokenWriter: jest.fn(() => ({})),
}));

import SettingsScreen from '@/app/settings';
import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import {
  LAST_REGISTERED_PUSH_TOKEN_PREF_KEY,
  PUSH_NOTIFICATIONS_PREF_KEY,
} from '@/domain/push-notifications-pref';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
  mockAuth.status = 'authenticated';
});

test('authenticated, AI suggestions on: row starts Off and the switch is enabled', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());
  expect(screen.getByLabelText('Notify when AI catches up').props.disabled).not.toBe(true);
});

test('anonymous: row explains sign-in is required and never requests permission', async () => {
  mockAuth.status = 'anonymous';
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Sign in to enable')).toBeTruthy());

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', true);
  });

  expect(mockRequestPushPermissionAndToken).not.toHaveBeenCalled();
});

test('AI suggestions off: row explains that instead, even when signed in', async () => {
  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

  await fireEvent.press(screen.getByText('AI suggestions'));
  await waitFor(() => expect(screen.getByText('Off — never auto-suggest')).toBeTruthy());
  await fireEvent.press(screen.getByText('Off — never auto-suggest'));

  await waitFor(() => expect(screen.getByText('Turn on AI suggestions first')).toBeTruthy());
  await waitFor(() => expect(fakeRepo.__meta(AI_SUGGESTIONS_MODE_PREF_KEY)).toBe('off'));

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', true);
  });
  expect(mockRequestPushPermissionAndToken).not.toHaveBeenCalled();
});

test('turning on: permission granted + registration succeeds updates the row and persists the token', async () => {
  mockRequestPushPermissionAndToken.mockResolvedValue({
    outcome: 'granted',
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
  });
  mockRegisterPushToken.mockResolvedValue(true);

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', true);
  });

  await waitFor(() =>
    expect(screen.getByText('On — a push arrives once AI finishes a backlog')).toBeTruthy(),
  );
  expect(mockRegisterPushToken).toHaveBeenCalledTimes(1);
  expect(mockRegisterPushToken.mock.calls[0][0]).toMatchObject({
    session: mockAuth.session,
    token: 'ExponentPushToken[abc]',
    platform: 'ios',
  });
  await waitFor(() =>
    expect(fakeRepo.__meta(PUSH_NOTIFICATIONS_PREF_KEY)).toBe('true'),
  );
  await waitFor(() =>
    expect(fakeRepo.__meta(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY)).toBe('ExponentPushToken[abc]'),
  );
});

test('turning on: permission denied shows an alert and leaves the row Off', async () => {
  mockRequestPushPermissionAndToken.mockResolvedValue({ outcome: 'denied' });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', true);
  });

  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledWith(
    'Notifications are turned off',
    expect.any(String),
  );
  expect(screen.getByText('Off')).toBeTruthy();
});

test('turning on: no EAS projectId configured shows an alert instead of crashing', async () => {
  mockRequestPushPermissionAndToken.mockResolvedValue({ outcome: 'no_project_id' });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  const screen = await renderSettings();
  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', true);
  });

  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  expect(alertSpy).toHaveBeenCalledWith(
    'Can’t enable notifications right now',
    expect.any(String),
  );
});

test('turning off deregisters the last-registered token and clears both prefs', async () => {
  fakeRepo.__setMeta(PUSH_NOTIFICATIONS_PREF_KEY, 'true');
  fakeRepo.__setMeta(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY, 'ExponentPushToken[abc]');
  mockDeregisterPushToken.mockResolvedValue(true);

  const screen = await renderSettings();
  await waitFor(() =>
    expect(screen.getByText('On — a push arrives once AI finishes a backlog')).toBeTruthy(),
  );

  await act(async () => {
    fireEvent(screen.getByLabelText('Notify when AI catches up'), 'valueChange', false);
  });

  await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());
  expect(mockDeregisterPushToken).toHaveBeenCalledTimes(1);
  expect(mockDeregisterPushToken.mock.calls[0][0]).toMatchObject({
    session: mockAuth.session,
    token: 'ExponentPushToken[abc]',
  });
  await waitFor(() => expect(fakeRepo.__meta(PUSH_NOTIFICATIONS_PREF_KEY)).toBe('false'));
  await waitFor(() => expect(fakeRepo.__meta(LAST_REGISTERED_PUSH_TOKEN_PREF_KEY)).toBe(''));
});
