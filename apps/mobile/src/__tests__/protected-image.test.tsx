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
  const screen = await render(<ProtectedImage uri="https://example.com/image.png" testID="image" />);
  expect(screen.getByTestId('image').props.source.uri).toBe('https://example.com/image.png');
  expect(mockRequest).not.toHaveBeenCalled();
});

test('private-network remote images are hidden while durable local images remain visible', async () => {
  const screen = await render(<ProtectedImage uri="http://192.168.1.1/admin" testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await screen.rerender(<ProtectedImage uri="file:///documents/stash-images/capture.png" testID="image" />);
  expect(screen.getByTestId('image').props.source.uri).toBe('file:///documents/stash-images/capture.png');
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


test('a successful signing retry restores retry allowance for later renewal failures', async () => {
  jest.useFakeTimers();
  mockRequest.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ signedURL: signed })
    .mockRejectedValueOnce(new Error('offline again'))
    .mockResolvedValueOnce({ signedURL: signed });
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('image')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(270_000); });
  expect(screen.queryByTestId('image')).toBeNull();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockRequest).toHaveBeenCalledTimes(4);
  expect(screen.getByTestId('image')).toBeTruthy();
});

test('successful signing does not create endless retries for an unreadable image', async () => {
  mockRequest.mockResolvedValue({ signedURL: signed });
  const onError = jest.fn();
  const screen = await render(<ProtectedImage uri={reference} testID="image" onError={onError} />);
  const event = { nativeEvent: { error: 'decode failed' } };
  await act(async () => { screen.getByTestId('image').props.onError(event); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { screen.getByTestId('image').props.onError(event); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenCalledWith(event);
});
