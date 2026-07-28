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
const mockOtherRealSession = {
  access_token: 'other-token',
  refresh_token: 'other-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'other-real-user', is_anonymous: false, email: 'other@example.com' },
};

// Mutable so tests can simulate a real account switch mid-test (the same
// pattern as sign-in-pull.test.tsx) — needed to verify account isolation is
// preserved even while sync is paused.
jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'authenticated' as string,
    session: {
      access_token: 'real-token',
      refresh_token: 'real-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
    } as unknown,
    userId: 'real-user' as string | null,
    message: null as string | null,
    ensureAnonymousSession: async () => state.session,
  };
  return {
    __setAuth: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

jest.mock('@/api/bookmarks', () => {
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '1a2b3c4d-0000-4000-8000-00000000abcd',
  }));
  const listBookmarksUpdatedSince = jest.fn(async () => []);
  const addTags = jest.fn(async (input: { tags: string[] }) =>
    input.tags.map((name) => ({ id: `tag-${name}`, name, slug: name })),
  );
  const removeTags = jest.fn(async () => {});
  const resetLibrary = jest.fn(async () => ({ bookmarks: 0 }));
  const empty = async () => [];
  // Ids the "server" knows about — so a seeded already-synced local bookmark
  // isn't treated as a remote deletion by the very first pull. Tests that
  // seed a cloud-identity bookmark must call __setRemoteIds with its id.
  let remoteIds: string[] = [];
  return {
    __createBookmarkMock: createBookmark,
    __listBookmarksUpdatedSinceMock: listBookmarksUpdatedSince,
    __addTagsMock: addTags,
    __removeTagsMock: removeTags,
    __setRemoteIds: (ids: string[]) => {
      remoteIds = ids;
    },
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince,
      listBookmarkIds: async () => [...remoteIds],
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createBookmark,
      addTags,
      removeTags,
      resetLibrary,
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
  __createBookmarkMock: jest.Mock;
  __listBookmarksUpdatedSinceMock: jest.Mock;
  __addTagsMock: jest.Mock;
  __removeTagsMock: jest.Mock;
  __setRemoteIds: (ids: string[]) => void;
};
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
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
  apiMock.__addTagsMock.mockClear();
  apiMock.__removeTagsMock.mockClear();
  apiMock.__setRemoteIds([]);
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user' });
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

test('a real account switch reconciles the local cache even while sync is paused', async () => {
  // Seed a cloud-synced bookmark that belongs to the first real account.
  const OWNED_BY_A = '7e64cf1e-0000-4000-8000-00000000a001';
  fakeRepo.__reset([
    makeStoredBookmark({ id: OWNED_BY_A, url: 'https://example.com/owned-by-a' }),
  ]);
  apiMock.__setRemoteIds([OWNED_BY_A]);

  const { result, rerender } = await renderReadyStore();
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(OWNED_BY_A));

  await act(async () => {
    result.current.setSyncPaused(true);
  });

  // A different real account signs in on this device while paused (Sentry
  // STASH-3K review) — the pause toggle must not leave account A's cached
  // bookmark on screen under account B's session. Re-render so the store
  // actually observes the new mocked session before we call syncNow —
  // otherwise the closure captured at the last render still holds account A.
  authMock.__setAuth({
    status: 'authenticated',
    session: mockOtherRealSession,
    userId: 'other-real-user',
  });
  await act(async () => {
    rerender(undefined);
  });
  await act(async () => {
    await result.current.syncNow();
  });

  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).not.toContain(OWNED_BY_A));
  // Still paused, and no network upload/pull happened to produce this —
  // it's a local-only reconciliation.
  expect(result.current.syncPaused).toBe(true);
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
});

test('adding a tag while paused does not upload until sync resumes', async () => {
  const OWNED = '7e64cf1e-0000-4000-8000-00000000b001';
  fakeRepo.__reset([makeStoredBookmark({ id: OWNED, url: 'https://example.com/tag-me' })]);
  apiMock.__setRemoteIds([OWNED]);

  const { result } = await renderReadyStore();
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(OWNED));

  await act(async () => {
    result.current.setSyncPaused(true);
  });

  await act(async () => {
    await result.current.addTagsToBookmark(OWNED, ['reading']);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(apiMock.__addTagsMock).not.toHaveBeenCalled();

  await act(async () => {
    result.current.setSyncPaused(false);
  });
  await waitFor(() => expect(apiMock.__addTagsMock).toHaveBeenCalledTimes(1));
});

test('resetLibrary succeeds even while a paused syncNow call is mid-check', async () => {
  // Reported after shipping the account-isolation fix: the paused branch used
  // to hold syncInFlight for its ENTIRE check (including the routine read),
  // and the auto-sync effect calls syncNow every time the queue changes and
  // stays non-empty — which a paused queue always does. On real devices that
  // read is a genuine SQLite call (hundreds of ms, per production
  // diagnostics), so the lock was held often enough that resetLibrary's own
  // busy-guard (the same syncInFlight flag) could never find it clear — "says
  // busy" never resolved. A fake in-memory repository has no such latency, so
  // this gates the meta read to force the race deterministically.
  const { result } = await renderReadyStore();
  await act(async () => {
    result.current.setSyncPaused(true);
  });

  const originalGetMeta = fakeRepo.repository.getMeta;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  fakeRepo.repository.getMeta = (key: string) =>
    key === 'synced_user_id' ? gate.then(() => originalGetMeta(key)) : originalGetMeta(key);

  // Adding a bookmark while paused triggers the auto-sync effect's syncNow()
  // call, which immediately blocks on the gated read above.
  let syncPromise: Promise<boolean> | undefined;
  await act(async () => {
    result.current.addBookmark({ url: 'https://example.com/still-pending' });
  });
  await act(async () => {
    syncPromise = result.current.syncNow();
    await Promise.resolve();
  });

  let outcome: Awaited<ReturnType<typeof result.current.resetLibrary>> | null = null;
  await act(async () => {
    outcome = await result.current.resetLibrary();
  });
  expect(outcome).toEqual({ ok: true });

  releaseGate();
  fakeRepo.repository.getMeta = originalGetMeta;
  await act(async () => {
    await syncPromise;
  });
});
