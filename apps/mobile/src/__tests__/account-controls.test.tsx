import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockAuth = {
  status: 'anonymous' as 'anonymous' | 'authenticated' | 'not_configured',
  email: null as string | null,
  isSignedIn: true,
  userId: 'user-1' as string | null,
  message: '',
  signIn: jest.fn(async () => ({ ok: true })),
  signOut: jest.fn(async () => {}),
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => mockAuth,
}));

import { AccountControls } from '@/ui/AccountControls';

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.status = 'anonymous';
  mockAuth.email = null;
});

test('anonymous: offers provider sign-in and calls signIn on press', async () => {
  const onDone = jest.fn();
  const screen = await render(<AccountControls onDone={onDone} />);

  expect(screen.getByText('Sign in to sync across devices')).toBeTruthy();
  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Sign in with Google'));
  });

  expect(mockAuth.signIn).toHaveBeenCalledWith('google');
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test('authenticated: shows the email and signs out', async () => {
  mockAuth.status = 'authenticated';
  mockAuth.email = 'me@example.com';
  const onDone = jest.fn();
  const screen = await render(<AccountControls onDone={onDone} />);

  expect(screen.getByText('Signed in as me@example.com')).toBeTruthy();
  await act(async () => {
    await fireEvent.press(screen.getByText('Sign out'));
  });

  expect(mockAuth.signOut).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test('not configured: explains sign-in is unavailable', async () => {
  mockAuth.status = 'not_configured';
  const screen = await render(<AccountControls />);

  expect(screen.getByText(/Cloud sync isn’t configured/)).toBeTruthy();
  expect(screen.queryByLabelText('Sign in with Apple')).toBeNull();
});
