import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { CreateBookmarkInput } from '@/domain/types';
import type { Bookmark } from '@/domain/types';
import { CACHE_OWNER_KEY } from '@/sync/account-transition';
import { LAST_PULLED_AT_KEY, SYNCED_USER_ID_KEY, SYNCED_USER_ANON_KEY } from '@/sync/pull-bookmarks';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Mutable auth mock: starts as a fresh anonymous user (the state right after a
// reinstall), then flips to a real account to simulate signing in. The store
// re-reads useSupabaseAuth() on every render, so updating `state` + rerendering
// reflects the new session.
const anonSession = {
  access_token: 'anon-token',
  refresh_token: 'anon-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'anon-user', is_anonymous: true },
};
const realSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'anonymous' as string,
    session: {
      access_token: 'anon-token',
      refresh_token: 'anon-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'anon-user', is_anonymous: true },
    } as unknown,
    userId: 'anon-user' as string | null,
    message: null,
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

// The signed-in account's cloud bookmarks the pull should fetch.
jest.mock('@/api/bookmarks', () => {
  let remote: Bookmark[] = [];
  let failPull = false;
  const created = new Map<string, Bookmark[]>();
  // When set, the FIRST bookmark-list call (the startup anonymous pull) awaits
  // this gate and then returns empty, letting a test hold that sync in flight
  // and sign in mid-pull. Cleared after it fires, so later pulls run normally.
  let gate: Promise<void> | null = null;
  const empty = async () => [];
  return {
    __reset: () => { failPull = false; created.clear(); gate = null; },
    __failPull: (value: boolean) => { failPull = value; },
    __created: (userId: string) => created.get(userId) ?? [],
    __setRemote: (rows: Bookmark[]) => {
      remote = rows;
    },
    __setListGate: (promise: Promise<void>) => {
      gate = promise;
    },
    createBookmarkApi: (session: typeof anonSession) => ({
      userId: session.user.id,
      createBookmark: async (input: CreateBookmarkInput) => {
        const { makeStoredBookmark } = require('./helpers/fake-repository');
        const row = makeStoredBookmark({ ...input, id: input.id, user_id: session.user.id, sync_status: 'synced', ever_synced: true });
        created.set(session.user.id, [...(created.get(session.user.id) ?? []), row]);
        return { bookmark_id: input.id, status: 'created', metadata_status: 'complete' };
      },
      listBookmarksUpdatedSince: async (since: string | null) => {
        if (failPull) throw new Error('Pull unavailable');
        if (gate) {
          const pending = gate;
          gate = null;
          await pending;
          return [];
        }
        if (!since) {
          return [...remote, ...(created.get(session.user.id) ?? [])];
        }
        return [...remote, ...(created.get(session.user.id) ?? [])].filter((row) => row.updated_at > since);
      },
      listBookmarkIds: async () => [...remote, ...(created.get(session.user.id) ?? [])].map((row) => row.id),
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
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
};
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __reset: () => void;
  __failPull: (value: boolean) => void;
  __created: (userId: string) => Bookmark[];
  __setRemote: (rows: Bookmark[]) => void;
  __setListGate: (promise: Promise<void>) => void;
};

const REMOTE_ID = '1a2b3c4d-0000-4000-8000-00000000abcd';

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  // Fresh reinstall: no local bookmarks yet.
  fakeRepo.__reset([]);
  apiMock.__reset();
  apiMock.__setRemote([]);
  authMock.__setAuth({ status: 'anonymous', session: anonSession, userId: 'anon-user' });
});

test('signing in pulls the account’s cloud bookmarks without a cold start', async () => {
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // Initial anonymous pull settles with an empty library.
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());
  expect(result.current.inbox).toHaveLength(0);

  // The user signs in: their existing cloud data is now reachable.
  apiMock.__setRemote([makeStoredBookmark({ id: REMOTE_ID, url: 'https://example.com/restored' })]);
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  await act(async () => {
    rerender(undefined);
  });

  // The sign-in alone must trigger a pull that restores the bookmark — no
  // app restart required.
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));
});

test('signing in with an empty local cache ignores a stale watermark and restores cloud rows', async () => {
  // STASH-22: an upgrade/session-recovery path can leave sync metadata behind
  // while the local bookmark cache is empty. If the post-login pull trusts the
  // old watermark, old cloud rows are omitted from listBookmarksUpdatedSince()
  // and the Inbox stays empty even though the user is signed in.
  fakeRepo.__reset([]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-07-12T11:20:00.000Z');
  authMock.__setAuth({ status: 'session_expired', session: null, userId: null });
  apiMock.__setRemote([
    makeStoredBookmark({
      id: REMOTE_ID,
      url: 'https://example.com/restored',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }),
  ]);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.inbox).toHaveLength(0);

  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  await act(async () => {
    rerender(undefined);
  });

  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));
});

test('signing in with an empty local cache ignores a stale watermark even when synced user meta is missing', async () => {
  // Some upgrade/recovery paths can preserve last_pulled_at but lose the
  // synced-user marker. That still must full-refresh for a real signed-in user
  // whose local cache has no cloud rows.
  fakeRepo.__reset([]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, '');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-07-12T11:20:00.000Z');
  authMock.__setAuth({ status: 'session_expired', session: null, userId: null });
  apiMock.__setRemote([
    makeStoredBookmark({
      id: REMOTE_ID,
      url: 'https://example.com/restored',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    }),
  ]);

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.inbox).toHaveLength(0);

  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  await act(async () => {
    rerender(undefined);
  });

  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));
});

test('signing in mid-flight still pulls once the in-flight anonymous sync settles', async () => {
  // Hold the startup anonymous pull open so the sign-in lands while it runs.
  let releaseAnonPull!: () => void;
  apiMock.__setListGate(
    new Promise<void>((resolve) => {
      releaseAnonPull = resolve;
    }),
  );

  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // The startup anonymous sync is now in flight, blocked on the gate.
  await waitFor(() => expect(result.current.isSyncing).toBe(true));

  // Sign in while that sync is still running. syncNow can't start a second run
  // yet (the in-flight guard), so the effect must retry once it settles.
  apiMock.__setRemote([makeStoredBookmark({ id: REMOTE_ID, url: 'https://example.com/restored' })]);
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  await act(async () => {
    rerender(undefined);
  });

  // Let the in-flight anonymous sync finish.
  await act(async () => {
    releaseAnonPull();
  });

  // The signed-in account's bookmark is still pulled — not stranded until a
  // manual sync or restart.
  await waitFor(() => expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));
});


test('a guest capture survives sign-in when uploads succeeded but every anonymous pull failed', async () => {
  apiMock.__failPull(true);
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.isSyncing).toBe(false));
  await act(async () => {
    const saved = result.current.addBookmark({ url: 'https://example.com/before-login', title: 'My saved link', notes: 'Keep my note' });
    if (saved.status !== 'created') throw new Error('Expected a new capture');
    await saved.persisted;
  });
  await waitFor(() => expect(result.current.inbox[0]?.metadata_status).toBe('complete'));
  await act(async () => { await result.current.syncNow({ force: true }); });
  await waitFor(() => expect(fakeRepo.__bookmarks()[0]?.sync_status).toBe('synced'));
  expect(fakeRepo.__meta(SYNCED_USER_ID_KEY)).toBeNull();
  expect(apiMock.__created('anon-user')).toHaveLength(1);

  apiMock.__failPull(false);
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  await rerender(undefined);
  await waitFor(() => expect(result.current.isSyncing).toBe(false));
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  expect(result.current.inbox[0]).toMatchObject({ url: 'https://example.com/before-login', title: 'My saved link', notes: 'Keep my note' });
  expect(fakeRepo.__bookmarks()).toHaveLength(1);
  expect(apiMock.__created('real-user')).toHaveLength(1);
  expect(result.current.accountTransferCount).toBe(1);
  expect(result.current.accountLibraryState).toBe('ready');
});


test('guest cache ownership survives restart after a failed pull, then carries into an existing account', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: REMOTE_ID, notes: 'From the guest library' })]);
  fakeRepo.__setMeta(CACHE_OWNER_KEY, JSON.stringify({ id: 'anon-user', isAnonymous: true }));
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  const cloudId = '1a2b3c4d-0000-4000-8000-00000000dcba';
  apiMock.__setRemote([makeStoredBookmark({ id: cloudId, url: 'https://example.com/account-library' })]);
  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.inbox).toHaveLength(2));
  expect(result.current.inbox.find((row) => row.notes === 'From the guest library')).toBeTruthy();
  expect(fakeRepo.__bookmarks()).toHaveLength(2);
  expect(apiMock.__created('real-user')).toHaveLength(1);
  expect(result.current.accountTransferCount).toBe(1);
});

test('legacy anonymous cache carries over while paused and stays visible before cloud upload', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: REMOTE_ID, sync_status: 'failed', ever_synced: true, notes: 'Unsynced latest edit' })]);
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'anon-user');
  fakeRepo.__setMeta(SYNCED_USER_ANON_KEY, 'true');
  fakeRepo.__setMeta('pref.sync.paused', 'true');
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  expect(result.current.inbox[0]).toMatchObject({ notes: 'Unsynced latest edit', sync_status: 'pending' });
  expect(fakeRepo.__queue()[0]).toMatchObject({ operation: 'create', payload: { notes: 'Unsynced latest edit' } });
  expect(apiMock.__created('real-user')).toEqual([]);
  expect(result.current.accountLibraryState).toBe('checking');
  expect(result.current.accountTransferCount).toBe(1);
  await act(async () => { result.current.setSyncPaused(false); });
  await waitFor(() => expect(apiMock.__created('real-user')).toHaveLength(1));
  await waitFor(() => expect(result.current.accountLibraryState).toBe('ready'));
});

test('failed account verification is actionable and retry restores the library without a restart', async () => {
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
  apiMock.__failPull(true);
  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.accountLibraryState).toBe('error'));
  apiMock.__failPull(false);
  apiMock.__setRemote([makeStoredBookmark({ id: REMOTE_ID })]);
  await act(async () => { await result.current.syncNow({ force: true }); });
  await waitFor(() => expect(result.current.accountLibraryState).toBe('ready'));
  expect(result.current.inbox).toHaveLength(1);
});

test('an ownership checkpoint failure prevents uploads and leaves guest captures on disk', async () => {
  apiMock.__failPull(true);
  const setMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const spy = jest.spyOn(fakeRepo.repository, 'setMeta').mockImplementation(async (key, value) => {
    if (key === CACHE_OWNER_KEY) throw new Error('Storage unavailable');
    await setMeta(key, value);
  });
  try {
    const { result } = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      const saved = result.current.addBookmark({ url: 'https://example.com/durable' });
      if (saved.status !== 'created') throw new Error('Expected capture');
      await saved.persisted;
    });
    await act(async () => { await result.current.syncNow({ force: true }); });
    expect(apiMock.__created('anon-user')).toEqual([]);
    expect(fakeRepo.__bookmarks()).toHaveLength(1);
  } finally { spy.mockRestore(); }
});
