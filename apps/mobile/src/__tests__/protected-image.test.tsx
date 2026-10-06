import { act, render, waitFor } from '@testing-library/react-native';
import { ProtectedImage } from '@/ui/ProtectedImage';

const mockRequest = jest.fn();
let mockUser = 'a';
let mockStatus = 'authenticated';
let mockAccessToken: string | null = null;
jest.mock('@/supabase/auth-provider', () => ({ useSupabaseAuth: () => ({
  status: mockStatus, session: { access_token: mockAccessToken ?? `token-${mockUser}`, user: { id: mockUser } },
}) }));
jest.mock('@/supabase/config', () => ({ getSupabaseConfigState: () => ({ status: 'configured', config: { url: 'https://project.test', anonKey: 'anon' } }) }));
jest.mock('@/supabase/client', () => ({ StashSupabaseClient: class { request = mockRequest; } }));

const reference = 'https://project.test/storage/v1/object/public/bookmark-images/a/b';
const signed = '/object/sign/bookmark-images/a/b?token=signed';
beforeEach(() => { mockUser = 'a'; mockStatus = 'authenticated'; mockAccessToken = null; mockRequest.mockReset(); });
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

test('protocol-relative and whitespace-prefixed internal URLs are hidden while public protocol-relative URLs remain visible', async () => {
  const screen = await render(<ProtectedImage uri="//192.168.1.1/admin" testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await screen.rerender(<ProtectedImage uri="\\\\192.168.1.1\\admin" testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await screen.rerender(<ProtectedImage uri="   http://192.168.1.1/admin   " testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await screen.rerender(<ProtectedImage uri="//example.com/image.png" testID="image" />);
  expect(screen.getByTestId('image').props.source.uri).toBe('//example.com/image.png');
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
  expect(screen.getByTestId('image')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockRequest).toHaveBeenCalledTimes(4);
  expect(screen.getByTestId('image')).toBeTruthy();
});

test('renewal failures preserve the displayed image past URL expiry until recovery', async () => {
  jest.useFakeTimers();
  const renewed = signed.replace('token=signed', 'token=renewed');
  mockRequest.mockResolvedValueOnce({ signedURL: signed })
    .mockRejectedValueOnce(new Error('offline during renewal'))
    .mockResolvedValueOnce({ signedURL: renewed });
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  const currentUri = screen.getByTestId('image').props.source.uri;
  await act(async () => { jest.advanceTimersByTime(270_000); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('image').props.source.uri).toBe(currentUri);
  await act(async () => { jest.advanceTimersByTime(31_000); });
  // A parent render after server URL expiry must not discard decoded pixels.
  await screen.rerender(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.getByTestId('image').props.source.uri).toBe(currentUri);
  await act(async () => { jest.advanceTimersByTime(29_000); });
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(screen.getByTestId('image').props.source.uri).toBe(`https://project.test/storage/v1${renewed}`);
});

test('credential change hides retained images and an in-flight old-session renewal cannot restore them', async () => {
  jest.useFakeTimers();
  let finishOldRenewal!: (value: { signedURL: string }) => void;
  mockRequest.mockResolvedValueOnce({ signedURL: signed })
    .mockImplementationOnce(() => new Promise((resolve) => { finishOldRenewal = resolve; }))
    .mockRejectedValue(new Error('new session temporarily offline'));
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.getByTestId('image')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(270_000); });
  mockAccessToken = 'new-session-token';
  await screen.rerender(<ProtectedImage uri={reference} testID="image" />);
  expect(screen.queryByTestId('image')).toBeNull();
  await act(async () => { finishOldRenewal({ signedURL: signed }); });
  expect(screen.queryByTestId('image')).toBeNull();
  expect(mockRequest).toHaveBeenCalledTimes(3);
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


test('consecutive signing failures keep bounded recovery attempts and stop after unmount', async () => {
  jest.useFakeTimers();
  mockRequest.mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockResolvedValue({ signedURL: signed });
  const screen = await render(<ProtectedImage uri={reference} testID="image" />);
  for (const [index, delay] of [60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
    expect(screen.queryByTestId('image')).toBeNull();
    await act(async () => { jest.advanceTimersByTime(delay - 1); });
    expect(mockRequest).toHaveBeenCalledTimes(index + 1);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(mockRequest).toHaveBeenCalledTimes(index + 2);
  }
  expect(screen.getByTestId('image')).toBeTruthy();
  await screen.unmount();
  await act(async () => { jest.advanceTimersByTime(600_000); });
  expect(mockRequest).toHaveBeenCalledTimes(6);
});


test('a successful image load restores recovery for a later decode failure', async () => {
  mockRequest.mockResolvedValue({ signedURL: signed });
  const onError = jest.fn();
  const onLoad = jest.fn();
  const screen = await render(<ProtectedImage uri={reference} testID="image" onError={onError} onLoad={onLoad} />);
  const failure = { nativeEvent: { error: 'transient decode failure' } };
  const loaded = { nativeEvent: { source: { uri: signed } } };
  await act(async () => { screen.getByTestId('image').props.onError(failure); });
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { screen.getByTestId('image').props.onLoad(loaded); });
  expect(onLoad).toHaveBeenCalledWith(loaded);
  await act(async () => { screen.getByTestId('image').props.onError(failure); });
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(onError).not.toHaveBeenCalled();
  await act(async () => { screen.getByTestId('image').props.onError(failure); });
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(onError).toHaveBeenCalledWith(failure);
});


test.each([400, 403, 404, 410])('permanent signer HTTP %s forwards an error once and stops retries', async (status) => {
  jest.useFakeTimers();
  mockRequest.mockRejectedValue({ status, message: 'sensitive response' });
  const onError = jest.fn();
  const screen = await render(<ProtectedImage uri={reference} onError={onError} />);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith({ nativeEvent: { error: 'Image unavailable' } });
  await screen.rerender(<ProtectedImage uri={reference} onError={() => onError()} />);
  await act(async () => { jest.advanceTimersByTime(900_000); });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  mockAccessToken = 'refreshed-token';
  await screen.rerender(<ProtectedImage uri={reference} onError={onError} />);
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

test.each([401, 408, 409, 425, 429, 500, 503])('recoverable signer HTTP %s retries without a permanent error', async (status) => {
  jest.useFakeTimers();
  mockRequest.mockRejectedValueOnce({ status }).mockResolvedValue({ signedURL: signed });
  const onError = jest.fn();
  const screen = await render(<ProtectedImage uri={reference} testID="image" onError={onError} />);
  expect(onError).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(screen.getByTestId('image')).toBeTruthy();
  expect(mockRequest).toHaveBeenCalledTimes(2);
});
