const mockUpload = jest.fn();
jest.mock('expo-file-system', () => ({
  File: class { upload = mockUpload; },
  Directory: class {},
  Paths: {},
  UploadType: { BINARY_CONTENT: 0 },
}));

import { uploadImageFile } from '@/storage/image-store.native';
import { SupabaseRequestError } from '@/supabase/client';
import { syncErrorKind } from '@/sync/sync-bookmarks';
import { canAutomaticallyRetry } from '@/sync/automatic-retry';

test.each([
  [401, 'auth', false], [403, 'permission', false],
  [408, 'retryable_http', true], [429, 'retryable_http', true],
  [503, 'retryable_http', true], [400, 'other', false],
] as const)('native image HTTP %s preserves retry and recovery provenance', async (status, kind, retryable) => {
  mockUpload.mockResolvedValue({ status, body: 'timed out' });
  let failure: unknown;
  try { await uploadImageFile('file:///image.jpg', 'https://example.com/upload', {}); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SupabaseRequestError);
  expect((failure as SupabaseRequestError).status).toBe(status);
  expect(syncErrorKind(failure)).toBe(kind);
  expect(canAutomaticallyRetry(syncErrorKind(failure), 3)).toBe(retryable);
});

test('native successful upload completes and network rejection retains its cause', async () => {
  mockUpload.mockResolvedValue({ status: 201, body: '' });
  await expect(uploadImageFile('file:///image.jpg', 'https://example.com/upload', {})).resolves.toBeUndefined();
  const failure = new Error('Network request failed');
  mockUpload.mockRejectedValue(failure);
  await expect(uploadImageFile('file:///image.jpg', 'https://example.com/upload', {})).rejects.toBe(failure);
  expect(syncErrorKind(failure)).toBe('transient_network');
});
