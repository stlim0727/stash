import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
// No Supabase session: tagging must still work locally (the local-first win).
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  return utils;
}

beforeEach(() => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
});

test('adding a tag offline shows it immediately and queues the op', async () => {
  const { result } = await renderStore();

  let error: string | null = 'unset';
  await act(async () => {
    error = await result.current.addTagsToBookmark(SYNCED_ID, ['korean']);
  });

  // Succeeds with no session — applied locally, not blocked on the cloud.
  expect(error).toBeNull();
  expect(result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).toContain('korean');

  // The op is durably queued for a later upload.
  await waitFor(() => expect(fakeRepo.__meta('pending_tag_ops') ?? '').toContain('korean'));
});

test('removing a just-added (unsynced) tag cancels the queued op', async () => {
  const { result } = await renderStore();

  await act(async () => {
    await result.current.addTagsToBookmark(SYNCED_ID, ['korean']);
  });
  await act(async () => {
    await result.current.removeTagFromBookmark(SYNCED_ID, 'korean');
  });

  expect(result.current.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).not.toContain('korean');
  // add + remove of an unsynced tag cancel out — nothing left to upload.
  await waitFor(() => {
    const ops = JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]');
    expect(ops).toHaveLength(0);
  });
});
