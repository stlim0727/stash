import { act, render, waitFor } from '@testing-library/react-native';
import { ProtectedImage } from '@/ui/ProtectedImage';

const mockRequest = jest.fn();
let mockUser = 'a';
let mockStatus = 'authenticated';
jest.mock('@/supabase/auth-provider', () => ({ useSupabaseAuth: () => ({
  status: mockStatus, session: { access_token: `token-${mockUser}`, user: { id: mockUser } },
}) }));
jest.mock('@/supabase/config', () => ({ getSupabaseConfigState: () => ({ status: 'configured', config: { url: 'https://project.test', anonKey: 'anon' } }) }));
jest.mock('@/supabase/client', () => ({ StashSupabaseClient: class { request = mockRequest; } }));

const reference = 'https://project.test/storage/v1/object/public/bookmark-images/a/b';
const signed = '/object/sign/bookmark-images/a/b?token=signed';
beforeEach(() => { mockUser = 'a'; mockStatus = 'authenticated'; mockRequest.mockReset(); });
afterEach(() => { jest.useRealTimers(); });

test('external/local images do not make signing requests', async () => {
  const screen = await render(<ProtectedImage uri="https://external.test/image.png" testID="image" />);
  expect(screen.getByTestId('image').props.source.uri).toBe('https://external.test/image.png');
  expect(mockRequest).not.toHaveBeenCalled();
});

test('old public reference is never rendered directly and signatures renew before expiry', async () => {
  jest.useFakeTimers();
  mockRequest.mockResolvedValue({ signedURL: signed });
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  await waitFor(() => expect(screen.getByTestId('image').props.source.uri).toBe(`https://project.test/storage/v1${signed}`));
  expect(mockRequest).toHaveBeenCalledWith('/storage/v1/object/sign/bookmark-images/a/b', expect.objectContaining({ accessToken: 'token-a', body: { expiresIn: 300 } }));
  await act(async () => { jest.advanceTimersByTime(270_000); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

test('account switch/expired session immediately hide an old signed image', async () => {
  mockRequest.mockResolvedValue({ signedURL: signed });
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  await waitFor(() => expect(screen.getByTestId('image')).toBeTruthy());
  mockUser = 'other';
  await screen.rerender(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  mockUser = 'a'; mockStatus = 'session_expired';
  await screen.rerender(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
});

test('a failed signer never falls back to the public URL', async () => {
  mockRequest.mockRejectedValue(new Error('offline'));
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('image')).toBeNull();
});
