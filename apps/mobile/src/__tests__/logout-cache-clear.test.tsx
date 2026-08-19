import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import { LAST_PULLED_AT_KEY, SYNCED_USER_ID_KEY } from '@/sync/pull-bookmarks';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Mutable auth mock. Starts authenticated as a real account, then a logout
// flips it to `signed_out` with a null session (lazy anonymous creation — no
// new user minted on logout). ensureAnonymousSession() mints an anonymous user
// lazily ONLY when the store calls it (the first save after logout): it returns
// a session and counts the call.
const realSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};
const lazyAnonSession = {
  access_token: 'lazy-anon-token',
  refresh_token: 'lazy-anon-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'lazy-anon-user', is_anonymous: true },
};

jest.mock('@/supabase/auth-provider', () => {
  let ensureCalls = 0;
  let onEnsure: (() => void) | null = null;
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
    message: null,
    ensureAnonymousSession: async () => {
      ensureCalls += 1;
      onEnsure?.();
      return state.session;
    },
  };
  return {
    __setAuth: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
    __ensureCalls: () => ensureCalls,
    __onEnsure: (fn: () => void) => {
      onEnsure = fn;
    },
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

// The signed-in account's cloud rows the pull sees. Seed with the same id the
// local cache holds so the initial (same-user) pull doesn't treat it as a
// remote deletion before the test can act.
jest.mock('@/api/bookmarks', () => {
  let remote: Array<{ id: string }> = [];
  let createBookmarkHangs = false;
  const empty = async () => [];
  return {
    __setRemote: (rows: Array<{ id: string }>) => {
      remote = rows;
    },
    // Same "hang deliberately" pattern as updateBookmark below, for a
    // seeded image row whose test wants to observe it BEFORE the auto-sync
    // effect has a chance to actually confirm the create.
    __setCreateBookmarkHangs: (hangs: boolean) => {
      createBookmarkHangs = hangs;
    },
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: empty,
      listBookmarkIds: async () => remote.map((row) => row.id),
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      // Used by the queue uploader for a create after the lazy mint.
      createBookmark: async (payload: { url?: string | null }) => {
        if (createBookmarkHangs) {
          return new Promise<never>(() => {});
        }
        return { id: 'new-remote-id', url: payload.url ?? null };
      },
      // An update op for a previously-synced row. Hangs deliberately so a seeded
      // pending EDIT stays in-flight (its row stays `pending`) and isn't consumed
      // by the auto-sync before the test can log out and assert the drop.
      updateBookmark: () => new Promise<never>(() => {}),
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
  __ensureCalls: () => number;
  __onEnsure: (fn: () => void) => void;
};
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __setRemote: (rows: Array<{ id: string }>) => void;
  __setCreateBookmarkHangs: (hangs: boolean) => void;
};

const REMOTE_ID = '1a2b3c4d-0000-4000-8000-00000000abcd';

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  // A real account with one synced cloud bookmark already in the local cache,
  // plus the synced-user meta + watermark a prior pull would have written.
  fakeRepo.__reset([makeStoredBookmark({ id: REMOTE_ID })]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-06-12T10:00:00.000Z');
  apiMock.__setRemote([{ id: REMOTE_ID }]);
  apiMock.__setCreateBookmarkHangs(false);
  authMock.__setAuth({
    status: 'authenticated',
    session: realSession,
    userId: 'real-user',
  });
  authMock.__onEnsure(() => {});
});

test('logout clears the previous account’s synced local rows and resets sync meta', async () => {
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // The real account's synced bookmark is visible.
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));

  // Log out: lazy anonymous creation -> signed_out, no session, no new user.
  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });

  // The just-logged-out account's synced cloud row is dropped from the local
  // view (its data is safe in that account's cloud).
  await waitFor(() => expect(result.current.inbox).toHaveLength(0));
  expect(fakeRepo.__bookmarks().map((b) => b.id)).not.toContain(REMOTE_ID);

  // Synced-user meta + pull watermark were reset so the next session re-syncs
  // cleanly (empty strings read back as falsy at the call sites).
  expect(fakeRepo.__meta(SYNCED_USER_ID_KEY)).toBe('');
  expect(fakeRepo.__meta(LAST_PULLED_AT_KEY)).toBe('');
});

test('a save after logout lazily mints an anonymous session via the sync path', async () => {
  // No cloud rows to clear — isolate the lazy-mint behavior.
  fakeRepo.__reset([]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  apiMock.__setRemote([]);
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  // Log out: no anonymous user minted yet.
  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(0));

  const callsBeforeSave = authMock.__ensureCalls();

  // When the store calls ensureAnonymousSession during sync, simulate the auth
  // provider minting the anonymous user (status flips, session appears).
  authMock.__onEnsure(() => {
    authMock.__setAuth({
      status: 'anonymous',
      session: lazyAnonSession,
      userId: 'lazy-anon-user',
    });
  });

  // First save after logout: local-first, enqueues a pending entry that drives
  // the auto-sync effect from signed_out -> ensureAnonymousSession (lazy mint).
  await act(async () => {
    result.current.addBookmark({ url: 'https://example.com/after-logout' });
  });

  // The capture is in the local inbox immediately (capture is sacred)…
  await waitFor(() =>
    expect(result.current.inbox.some((b) => b.url === 'https://example.com/after-logout')).toBe(
      true,
    ),
  );
  // …and the sync path lazily minted an anonymous session.
  await waitFor(() => expect(authMock.__ensureCalls()).toBeGreaterThan(callsBeforeSave));
});

const REMOTE_EDITED_ID = '2b3c4d5e-0000-4000-8000-00000000ef01';
const LOCAL_CREATE_ID = 'local-create-keepme';

function updateEntry(localId: string): LocalPendingBookmark {
  const now = '2026-06-12T10:00:00.000Z';
  return {
    local_id: localId,
    remote_id: localId,
    operation: 'update',
    payload: { url: 'https://example.com/edited' } as LocalPendingBookmark['payload'],
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

function createEntry(localId: string): LocalPendingBookmark {
  const now = '2026-06-12T10:00:00.000Z';
  return {
    local_id: localId,
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://example.com/local-capture' } as LocalPendingBookmark['payload'],
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

test('logout drops a pending EDIT to a synced row AND its update queue entry, preserving a never-synced local create', async () => {
  // Cloud row that was synced then EDITED (now pending with a queued update keyed
  // to the real account's UUID) + a never-synced local capture.
  fakeRepo.__reset([
    makeStoredBookmark({
      id: REMOTE_EDITED_ID,
      sync_status: 'pending',
      ever_synced: true,
      title: 'edited locally',
    }),
    makeStoredBookmark({
      id: LOCAL_CREATE_ID,
      sync_status: 'pending',
      url: 'https://example.com/local-capture',
      url_hash: 'https://example.com/local-capture',
    }),
  ]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-06-12T10:00:00.000Z');
  // The update op (hangs in the api mock so it stays pending) + the local create.
  await fakeRepo.repository.enqueue(updateEntry(REMOTE_EDITED_ID));
  await fakeRepo.repository.enqueue(createEntry(LOCAL_CREATE_ID));
  // The pull sees both ids as still present remotely so the same-user pull is a
  // no-op before we log out.
  apiMock.__setRemote([{ id: REMOTE_EDITED_ID }]);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() =>
    expect(result.current.inbox.map((b) => b.id)).toEqual(
      expect.arrayContaining([REMOTE_EDITED_ID, LOCAL_CREATE_ID]),
    ),
  );

  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });

  // The cloud-identity edited row is dropped; the never-synced local create stays.
  await waitFor(() =>
    expect(result.current.inbox.map((b) => b.id)).toEqual([LOCAL_CREATE_ID]),
  );
  expect(fakeRepo.__bookmarks().map((b) => b.id)).not.toContain(REMOTE_EDITED_ID);

  // The stranded-edit hole is closed: the update entry is gone from the durable
  // queue (so it can't fire under the next anon identity), while the local
  // create's entry survives to upload under the next minted account.
  const queueIds = fakeRepo.__queue().map((e) => e.local_id);
  expect(queueIds).not.toContain(REMOTE_EDITED_ID);
  expect(queueIds).toContain(LOCAL_CREATE_ID);
});

const STALE_IMAGE_ID = 'stale-image-not-yet-confirmed';

test('logout rehomes an unconfirmed-but-uploaded image row AND re-keys its pending tag op onto the new id (P1, round 8)', async () => {
  // A local-only image row (its upload landed but createBookmark never
  // confirmed — content_type: image, preview_image_url set, ever_synced
  // unset) survives logout ("capture is sacred") and gets rehomed under a
  // fresh id (staleUploadedImageRows) so its retry doesn't collide with a
  // real cloud row that may already exist under the old id. Without wiring
  // tagState.rehome into the logout call site too, that rehome silently
  // skips re-keying — a pending tag op queued against this row would stay
  // pointed at the OLD (now-abandoned) id forever, never uploading.
  fakeRepo.__reset([
    makeStoredBookmark({
      id: STALE_IMAGE_ID,
      url: null,
      url_hash: null,
      content_type: 'image',
      preview_image_url: 'https://storage.example.com/bookmark-images/real-user/' + STALE_IMAGE_ID,
      local_image_uri: 'file:///stash-images/shared.jpg',
      sync_status: 'failed',
      ever_synced: undefined,
    }),
  ]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-06-12T10:00:00.000Z');
  fakeRepo.__setMeta(
    'pending_tag_ops',
    JSON.stringify([
      {
        id: 'tagop-1',
        bookmark_id: STALE_IMAGE_ID,
        tag_name: 'reference',
        op: 'add',
        source: 'user',
        confidence: null,
        created_at: '2026-06-12T10:00:00.000Z',
      },
    ]),
  );
  apiMock.__setRemote([]);
  // Without this, the store's orphan-reconciler self-heal notices this
  // sync_status: 'failed' row has no active queue entry, re-enqueues its
  // create, and the auto-sync effect actually CONFIRMS it (this mock's
  // createBookmark otherwise succeeds quickly) before logout ever runs —
  // defeating the whole premise (a row that's still genuinely unconfirmed).
  // Hanging it keeps the row in exactly the shape this test needs.
  apiMock.__setCreateBookmarkHangs(true);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(STALE_IMAGE_ID));

  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });

  // Rehomed under a fresh id — the row survives (still exactly one image
  // bookmark), but no longer under STALE_IMAGE_ID.
  await waitFor(() => {
    const ids = fakeRepo.__bookmarks().map((b) => b.id);
    expect(ids).not.toContain(STALE_IMAGE_ID);
    expect(ids).toHaveLength(1);
  });
  const newId = fakeRepo.__bookmarks()[0]!.id;
  expect(newId).not.toBe(STALE_IMAGE_ID);

  // The pending tag op must have followed it — re-keyed onto newId, not
  // stranded under STALE_IMAGE_ID and not silently dropped.
  const rekeyedOps = JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]') as Array<{
    bookmark_id: string;
  }>;
  expect(rekeyedOps).toHaveLength(1);
  expect(rekeyedOps[0]!.bookmark_id).toBe(newId);
});

test('the two signed_out effects (cache-clear + lazy-mint) do not fight: cache cleared, no premature mint', async () => {
  // A synced cloud row, no pending work yet. On logout the cache-clear effect and
  // the lazy-mint effect both observe `signed_out`. The cache must clear and —
  // since there is no queued user work — NO anonymous user should be minted.
  fakeRepo.__reset([makeStoredBookmark({ id: REMOTE_ID })]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  apiMock.__setRemote([{ id: REMOTE_ID }]);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));

  const callsBeforeLogout = authMock.__ensureCalls();

  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });

  // Cache cleared…
  await waitFor(() => expect(result.current.inbox).toHaveLength(0));
  expect(fakeRepo.__meta(SYNCED_USER_ID_KEY)).toBe('');
  // …and no mint happened (the queue is empty, so lazy-mint stays dormant). The
  // two effects don't fight: drop runs, mint doesn't.
  expect(authMock.__ensureCalls()).toBe(callsBeforeLogout);
});

test('lazy-mint retries after a failure without hot-looping: one rejection then a later save succeeds', async () => {
  fakeRepo.__reset([]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  apiMock.__setRemote([]);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(0));

  // First mint attempt REJECTS (Supabase down). The guard must reset so a later
  // save can retry — but the effect must NOT re-fire on its own (no hot loop).
  authMock.__onEnsure(() => {
    throw new Error('supabase down');
  });

  const callsBeforeFirstSave = authMock.__ensureCalls();
  await act(async () => {
    result.current.addBookmark({ url: 'https://example.com/first' });
  });
  await waitFor(() => expect(authMock.__ensureCalls()).toBe(callsBeforeFirstSave + 1));

  // Give any errant re-fire a chance to happen, then assert it did NOT: still
  // exactly one attempt for the first save (bounded, no hot loop).
  await act(async () => {
    await Promise.resolve();
  });
  expect(authMock.__ensureCalls()).toBe(callsBeforeFirstSave + 1);

  // A LATER save succeeds: the guard was reset on the rejection, so this retry
  // mints the anonymous session (status flips out of signed_out). After the flip
  // the normal background sync also calls ensure, so we only assert progress here
  // — the no-hot-loop guarantee was proven on the failure path above.
  authMock.__onEnsure(() => {
    authMock.__setAuth({ status: 'anonymous', session: lazyAnonSession, userId: 'lazy-anon-user' });
  });
  const callsBeforeSecondSave = authMock.__ensureCalls();
  await act(async () => {
    result.current.addBookmark({ url: 'https://example.com/second' });
  });
  await waitFor(() => expect(authMock.__ensureCalls()).toBeGreaterThan(callsBeforeSecondSave));
});
