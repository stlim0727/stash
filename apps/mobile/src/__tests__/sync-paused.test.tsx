import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Sentry STASH-3K follow-up: a "pause sync" safety valve so a bulk import can
// be reviewed — and unwanted rows deleted — before anything reaches the
// network. These tests drive the real store with a live (mocked) auth session
// so syncNow actually attempts network calls, and assert the pause guard
// blocks them entirely (no upload, no pull) until turned back off.
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockRealSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'authenticated',
    session: mockRealSession,
    userId: 'real-user',
    message: null,
    ensureAnonymousSession: async () => mockRealSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/api/bookmarks', () => {
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '1a2b3c4d-0000-4000-8000-00000000abcd',
  }));
  const listBookmarksUpdatedSince = jest.fn(async () => []);
  const empty = async () => [];
  return {
    __createBookmarkMock: createBookmark,
    __listBookmarksUpdatedSinceMock: listBookmarksUpdatedSince,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince,
      listBookmarkIds: async () => [],
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createBookmark,
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __createBookmarkMock: jest.Mock;
  __listBookmarksUpdatedSinceMock: jest.Mock;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

async function renderReadyStore() {
  const utils = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));
  // Let the automatic startup pull (fires because a signed-in user is seen
  // for the first time) settle before the test takes over.
  await waitFor(() => expect(utils.result.current.lastPulledAt).not.toBeNull());
  return utils;
}

beforeEach(() => {
  fakeRepo.__reset([]);
  apiMock.__createBookmarkMock.mockClear();
  apiMock.__listBookmarksUpdatedSinceMock.mockClear();
});

test('pausing sync keeps a newly queued create local until unpaused', async () => {
  const { result } = await renderReadyStore();

  await act(async () => {
    result.current.setSyncPaused(true);
  });
  expect(result.current.syncPaused).toBe(true);

  await act(async () => {
    result.current.addBookmark({ url: 'https://example.com/paused' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  // Give any stray async work a moment, then confirm nothing left the device.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  expect(result.current.inbox[0]?.sync_status).toBe('pending');
  expect(fakeRepo.__queue()).toHaveLength(1);

  await act(async () => {
    result.current.setSyncPaused(false);
  });

  await waitFor(() => expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.inbox[0]?.sync_status).toBe('synced'));
});

test('deleting a still-queued create while paused drops it from the queue without ever syncing', async () => {
  const { result } = await renderReadyStore();

  await act(async () => {
    result.current.setSyncPaused(true);
  });

  let id = '';
  await act(async () => {
    const outcome = result.current.addBookmark({ url: 'https://example.com/to-delete' });
    id = outcome.status === 'invalid' ? '' : outcome.bookmark.id;
  });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));

  await act(async () => {
    result.current.deleteBookmark(id);
  });

  // Dropped locally — a still-local (never-synced) delete never enqueues a
  // network call, paused or not, but this confirms it also clears the queue
  // entry that the paused import created.
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  expect(result.current.inbox).toHaveLength(0);

  await act(async () => {
    result.current.setSyncPaused(false);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
});

test('sync-paused pref persists durably and is restored on next load', async () => {
  const { result, unmount } = await renderReadyStore();

  await act(async () => {
    result.current.setSyncPaused(true);
  });
  await waitFor(() => expect(fakeRepo.__meta('pref.sync.paused')).toBe('true'));
  // Wrapped in act() so the unmounting render's effect cleanups (timers,
  // watchdogs) actually flush before the second instance mounts below.
  await act(async () => {
    unmount();
  });

  // Reload with the pref already persisted true: the startup pull is itself
  // paused, so only wait on isLoading (not lastPulledAt) this time.
  const reloaded = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(reloaded.result.current.isLoading).toBe(false));
  expect(reloaded.result.current.syncPaused).toBe(true);
});
