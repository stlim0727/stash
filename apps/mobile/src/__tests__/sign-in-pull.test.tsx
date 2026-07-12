import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { Bookmark } from '@/domain/types';
import { LAST_PULLED_AT_KEY, SYNCED_USER_ID_KEY } from '@/sync/pull-bookmarks';

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
  // When set, the FIRST bookmark-list call (the startup anonymous pull) awaits
  // this gate and then returns empty, letting a test hold that sync in flight
  // and sign in mid-pull. Cleared after it fires, so later pulls run normally.
  let gate: Promise<void> | null = null;
  const empty = async () => [];
  return {
    __setRemote: (rows: Bookmark[]) => {
      remote = rows;
    },
    __setListGate: (promise: Promise<void>) => {
      gate = promise;
    },
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: async (since: string | null) => {
        if (gate) {
          const pending = gate;
          gate = null;
          await pending;
          return [];
        }
        if (!since) {
          return [...remote];
        }
        return remote.filter((row) => row.updated_at > since);
      },
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
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
};
const apiMock = jest.requireMock('@/api/bookmarks') as {
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
