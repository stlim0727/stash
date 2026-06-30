import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Bookmark, LocalPendingBookmark } from '@/domain/types';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const anonSession = {
  access_token: 'anon-token',
  refresh_token: 'anon-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'anon-user', is_anonymous: true },
};

jest.mock('@/supabase/auth-provider', () => {
  const session = {
    access_token: 'anon-token',
    refresh_token: 'anon-refresh',
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'anon-user', is_anonymous: true },
  };
  const state = {
    status: 'anonymous' as string,
    session: session as unknown,
    userId: 'anon-user' as string | null,
    message: null,
    ensureAnonymousSession: async () => session,
  };
  return {
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

// The pull returns the remote twin so the pull half of syncNow is consistent and
// idempotent — the duplicate is created by the leftover reconcile, not the pull.
jest.mock('@/api/bookmarks', () => {
  let remote: Bookmark[] = [];
  const empty = async () => [];
  return {
    __setRemote: (rows: Bookmark[]) => {
      remote = rows;
    },
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: async () => [...remote],
      listBookmarkIds: async () => remote.map((row) => row.id),
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __setRemote: (rows: Bookmark[]) => void;
};

const REMOTE_ID = '1a2b3c4d-0000-4000-8000-00000000abcd';
const LOCAL_ID = 'local-carbonara';

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

test('a synced create-leftover does not duplicate a bookmark whose remote twin was already pulled', async () => {
  // Reconstructs the reported state: a create uploaded (the queue entry is marked
  // 'synced' with the new remote id) but the app was killed before the local->remote
  // id swap, AND the remote twin has since been pulled down under its UUID. So both
  // a stranded local-* row and its UUID twin sit in storage with a synced leftover
  // queue entry still pointing local_id -> remote_id.
  const localTwin = makeStoredBookmark({
    id: LOCAL_ID,
    url: 'https://youtube.com/shorts/carbonara',
    url_hash: 'https://youtube.com/shorts/carbonara',
    title: 'carbonara',
    sync_status: 'pending',
  });
  const remoteTwin = makeStoredBookmark({
    id: REMOTE_ID,
    url: 'https://youtube.com/shorts/carbonara',
    url_hash: 'https://youtube.com/shorts/carbonara',
    title: 'carbonara',
    sync_status: 'synced',
  });
  fakeRepo.__reset([localTwin, remoteTwin]);
  apiMock.__setRemote([remoteTwin]);

  const leftover: LocalPendingBookmark = {
    local_id: LOCAL_ID,
    remote_id: REMOTE_ID,
    operation: 'create',
    payload: { url: 'https://youtube.com/shorts/carbonara' },
    sync_status: 'synced',
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  await fakeRepo.repository.enqueue(leftover);

  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  // Drive a sync: its first step reconciles the synced leftover (local-* -> UUID).
  await act(async () => {
    await result.current.syncNow();
  });

  // Exactly one carbonara row, under the remote id — not two entries sharing it.
  await waitFor(() =>
    expect(result.current.inbox.filter((b) => b.url === 'https://youtube.com/shorts/carbonara')),
  );
  const carbonara = result.current.inbox.filter(
    (b) => b.url === 'https://youtube.com/shorts/carbonara',
  );
  expect(carbonara).toHaveLength(1);
  expect(carbonara[0].id).toBe(REMOTE_ID);
  // The stranded local-* row is gone from the visible library.
  expect(result.current.inbox.some((b) => b.id === LOCAL_ID)).toBe(false);
});
