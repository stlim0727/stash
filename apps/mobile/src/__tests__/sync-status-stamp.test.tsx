import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import type { ReactNode } from 'react';
import type { NetworkState } from 'expo-network';

// GH #687 follow-up: syncNow fires a fire-and-forget stamp into
// user_sync_status once a full sync pass (upload + pull) actually completes.
// These tests drive the real store (and the real trackSyncStatus) against a
// mocked auth session/API/PostgREST client, and assert the stamp fires
// exactly on a completed pass — never on an early return (no session) — and
// that a failing write never surfaces as a failed sync.
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
let mockNetworkListener: (state: NetworkState) => void;
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
  addNetworkStateListener: (listener: typeof mockNetworkListener) => {
    mockNetworkListener = listener;
    return { remove: jest.fn() };
  },
}));

const mockRealSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'authenticated' as string,
    session: null as unknown,
    userId: 'real-user' as string | null,
    message: null as string | null,
    credentialRecoveryVersion: 0,
    ensureAnonymousSession: jest.fn(async (): Promise<unknown> => state.session),
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
  const bulkAttachTagsAndCollections = jest.fn(
    async (
      items: Array<{ bookmark_id: string; tags: Array<{ name: string; source: string }> }>,
    ) =>
      items.map((item) => ({
        bookmark_id: item.bookmark_id,
        tags: item.tags.map((tag) => ({
          id: `tag-${tag.name}`,
          user_id: 'real-user',
          name: tag.name,
          slug: tag.name,
          source: tag.source,
          created_at: new Date().toISOString(),
        })),
        collection: null,
        collection_attached: false,
        bookmark_updated_at: null,
      })),
  );
  const resetLibrary = jest.fn(async () => ({ bookmarks: 0 }));
  const empty = async () => [];
  return {
    __resetLibraryMock: resetLibrary,
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
      addTags,
      removeTags,
      bulkAttachTagsAndCollections,
      resetLibrary,
    }),
  };
});

let mockHoldMetadata = false;
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => mockHoldMetadata ? new Promise(() => {}) : ({ patch: {}, metadata_status: 'complete' }),
}));

const mockUpsertSyncStatus = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/supabase/client', () => {
  const actual = jest.requireActual('@/supabase/client');
  return {
    ...actual,
    createSupabaseClient: () => ({
      upsertSyncStatus: (...args: unknown[]) => mockUpsertSyncStatus(...args),
    }),
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
  useSupabaseAuth: () => { ensureAnonymousSession: jest.Mock };
};
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __resetLibraryMock: jest.Mock;
  __createBookmarkMock: jest.Mock;
  __listBookmarksUpdatedSinceMock: jest.Mock;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  mockHoldMetadata = false;
  fakeRepo.__reset();
  apiMock.__createBookmarkMock.mockClear();
  apiMock.__listBookmarksUpdatedSinceMock.mockClear();
  mockUpsertSyncStatus.mockClear();
  mockUpsertSyncStatus.mockImplementation(async () => {});
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user', credentialRecoveryVersion: 0 });
});
afterEach(() => jest.useRealTimers());

test('a completed sync pass (upload + pull) stamps user_sync_status', async () => {
  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  // The automatic startup pull is itself a completed sync pass.
  await waitFor(() => expect(mockUpsertSyncStatus).toHaveBeenCalledTimes(1));

  const [accessToken, data] = mockUpsertSyncStatus.mock.calls[0] as [
    string,
    { user_id: string; last_synced_at: string },
  ];
  expect(accessToken).toBe('real-token');
  expect(data.user_id).toBe('real-user');
  expect(typeof data.last_synced_at).toBe('string');
});

test('an early-return sync pass (no session) does not attempt the stamp', async () => {
  authMock.__setAuth({ status: 'loading', session: null, userId: null });

  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  await act(async () => {
    await result.current.syncNow();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  expect(mockUpsertSyncStatus).not.toHaveBeenCalled();
});

test('a failing/throwing stamp write does not propagate and does not fail syncNow', async () => {
  mockUpsertSyncStatus.mockRejectedValueOnce(new Error('network down'));

  const { result } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // The startup pull's stamp attempt fails, but trackSyncStatus swallows it —
  // nothing here should throw or leave the store mid-sync.
  await waitFor(() => expect(mockUpsertSyncStatus).toHaveBeenCalledTimes(1));
  expect(result.current.isSyncing).toBe(false);

  // A second manual pass still resolves normally and retries the stamp.
  mockUpsertSyncStatus.mockImplementationOnce(async () => {});
  let outcome: boolean | undefined;
  await act(async () => {
    outcome = await result.current.syncNow();
  });
  expect(outcome).toBe(false);
  expect(result.current.isSyncing).toBe(false);
  await waitFor(() => expect(mockUpsertSyncStatus).toHaveBeenCalledTimes(2));
});

test('a restored failed upload retries at its backoff deadline without another save', async () => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({
    local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/retry' },
    sync_status: 'failed', retry_count: 1, last_error: 'Network request failed', last_error_kind: 'transient_network',
    created_at: at, updated_at: at, last_attempt_at: at,
  });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  expect(screen.result.current.librarySyncFlow.phase).toBe('retrying');
  await act(async () => { await jest.advanceTimersByTimeAsync(14999); });
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test('a failed pull prevents completion and quietly retries without pending bookmark uploads', async () => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  expect(screen.result.current.librarySyncFlow.remaining).toBe(0);
  await act(async () => { await jest.advanceTimersByTimeAsync(14999); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('idle'));
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

test.each([['paused', 'paused'], ['offline', 'offline'], ['session_expired', 'sign_in']])(
  '%s blocks a scheduled retry, and a reconnect resumes the normal sync path', async (blocker, phase) => {
    jest.useFakeTimers();
    apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
    const screen = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
    await act(async () => {
      if (blocker === 'paused') screen.result.current.setSyncPaused(true);
      else if (blocker === 'offline') mockNetworkListener({ isConnected: false });
      else authMock.__setAuth({ status: 'session_expired', session: null, userId: null });
    });
    await screen.rerender(undefined);
    expect(screen.result.current.librarySyncFlow.phase).toBe(phase);
    await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
    expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
    if (blocker === 'offline') {
      await act(async () => { await screen.result.current.syncNow(); });
      await act(async () => { mockNetworkListener({ isConnected: true, isInternetReachable: true }); });
      await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('idle'));
      await act(async () => { await jest.advanceTimersByTimeAsync(100); });
      expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
    }
    await screen.unmount();
  },
);

test('STASH-7E: returning online without a network event clears the banner and resumes a due pull', async () => {
  jest.useFakeTimers();
  const listeners = new Set<(state: AppStateStatus) => void>();
  const originalObserver = AppState.addEventListener;
  AppState.addEventListener = jest.fn((_event, listener) => {
    const changeListener = listener as (state: AppStateStatus) => void;
    listeners.add(changeListener);
    return { remove: () => { listeners.delete(changeListener); } };
  });
  try {
    apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
    const screen = await renderHook(() => useBookmarks(), { wrapper });
    await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
    await act(async () => { mockNetworkListener({ isConnected: false }); });
    expect(screen.result.current.librarySyncFlow.phase).toBe('offline');
    await act(async () => { listeners.forEach((listener) => listener('background')); });
    await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
    expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
    // The query says online, but no reconnect event was delivered while away.
    await act(async () => { listeners.forEach((listener) => listener('active')); });
    await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('idle'));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
    expect(screen.result.current.librarySyncFlow.remaining).toBe(0);
    await screen.unmount();
    expect(listeners.size).toBe(0);
  } finally {
    AppState.addEventListener = originalObserver;
  }
});

test.each([[401, 'sign_in'], [403, 'permission']])('HTTP %s requests user action instead of auto-retrying', async (status, phase) => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new SupabaseRequestError('Denied', status as number));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe(phase));
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  if (status === 401) {
    await act(async () => { await screen.result.current.syncNow({ force: true }); });
    expect(authMock.useSupabaseAuth().ensureAnonymousSession).toHaveBeenCalledWith(true);
    expect(screen.result.current.librarySyncFlow.phase).toBe('idle');
  }
  await screen.unmount();
});

test('HTTP 503 keeps recovering after repeated failures instead of asking the user to retry', async () => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValue(new SupabaseRequestError('Temporarily unavailable', 503));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  for (const delay of [5000, 15000, 30000]) {
    await act(async () => { await jest.advanceTimersByTimeAsync(delay); });
  }
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(4);
  expect(screen.result.current.librarySyncFlow.phase).toBe('retrying');
  apiMock.__listBookmarksUpdatedSinceMock.mockResolvedValue([]);
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('idle'));
  await screen.unmount();
});


test('a rejected-token recovery never falls back to the rejected bearer when refresh fails', async () => {
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new SupabaseRequestError('Denied', 401));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('sign_in'));
  const ensure = authMock.useSupabaseAuth().ensureAnonymousSession as jest.Mock;
  ensure.mockResolvedValueOnce(null);
  await act(async () => { expect(await screen.result.current.syncNow({ force: true })).toBe(false); });
  expect(ensure).toHaveBeenCalledWith(true);
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test('an earlier bookmark retry and unrelated sync cannot bypass a failed pull deadline', async () => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({
    local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/retry' },
    sync_status: 'failed', retry_count: 1, last_error: 'Temporary failure', last_error_kind: 'other',
    created_at: at, updated_at: at, last_attempt_at: at,
  });
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  await act(async () => { await screen.result.current.syncNow(); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1);
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(10000); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
  expect(screen.result.current.librarySyncFlow.phase).toBe('idle');
  await screen.unmount();
});

test('a retained provider error turns an empty-outbox pull failure into actionable recovery', async () => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  await act(async () => { authMock.__setAuth({ status: 'error' }); });
  await screen.rerender(undefined);
  expect(screen.result.current.librarySyncFlow).toEqual({ phase: 'sign_in', remaining: 0 });
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});


test.each(['auth', 'permission', 'other'] as const)('%s bookmark failures remain blocked on ordinary passes after backoff, but recover on explicit manual sync', async (kind) => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date(Date.now() - 3600000).toISOString();
  await fakeRepo.repository.enqueue({
    local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/blocked' },
    sync_status: 'failed', retry_count: kind === 'other' ? 3 : 1, last_error: 'Requires recovery', last_error_kind: kind,
    created_at: at, updated_at: at, last_attempt_at: at,
  });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); await screen.result.current.syncNow(); });
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  expect(fakeRepo.__queue()).toHaveLength(1);
  await act(async () => { await screen.result.current.syncNow({ force: true }); });
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1);
  expect(fakeRepo.__queue()).toHaveLength(0);
  await screen.unmount();
});

test.each([['auth', 1], ['permission', 0], ['other', 0]] as const)('new credentials recover %s failures selectively without manual force', async (kind, attempts) => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/credential-recovery' },
    sync_status: 'failed', retry_count: kind === 'other' ? 3 : 1, last_error: 'Requires recovery', last_error_kind: kind,
    created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  await act(async () => { authMock.__setAuth({ session: { ...mockRealSession, access_token: 'fresh-credentials' } }); });
  await screen.rerender(undefined);
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(attempts);
  expect(fakeRepo.__queue()).toHaveLength(attempts ? 0 : 1);
  await screen.unmount();
});

test('sign-out and sign-in recovers a preserved never-synced auth-failed capture', async () => {
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/login-recovery' },
    sync_status: 'failed', retry_count: 1, last_error: 'Denied', last_error_kind: 'auth', created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  await act(async () => { authMock.__setAuth({ status: 'signed_out', session: null, userId: null }); });
  await screen.rerender(undefined);
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await act(async () => { authMock.__setAuth({ status: 'authenticated', session: { ...mockRealSession, access_token: 'signed-in-token' }, userId: 'real-user' }); });
  await screen.rerender(undefined);
  await waitFor(() => expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  await screen.unmount();
});

test('a fresh 401 after credential recovery is not retried again with the same credential', async () => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/still-denied' },
    sync_status: 'failed', retry_count: 1, last_error: 'Denied', last_error_kind: 'auth', created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  apiMock.__createBookmarkMock.mockRejectedValueOnce(new SupabaseRequestError('Still denied', 401));
  await act(async () => { authMock.__setAuth({ session: { ...mockRealSession, access_token: 'fresh-but-rejected' } }); });
  await screen.rerender(undefined);
  await waitFor(() => expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1));
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); await screen.result.current.syncNow(); });
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});

test('a freshly restored bearer ahead of reactive auth does not schedule repeated recovery pulls', async () => {
  jest.useFakeTimers();
  authMock.useSupabaseAuth().ensureAnonymousSession.mockResolvedValueOnce({ ...mockRealSession, access_token: 'ahead-of-render' });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});


test.each([[0, 0], [1, 1]])('cold-start recovery version %s retries persisted auth failures only after server refresh', async (version, attempts) => {
  jest.useFakeTimers();
  authMock.__setAuth({ status: 'loading', session: null, userId: null });
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/cold-start' },
    sync_status: 'failed', retry_count: 1, last_error: 'Denied', last_error_kind: 'auth', created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await act(async () => { authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user', credentialRecoveryVersion: version }); });
  await screen.rerender(undefined);
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(attempts);
  expect(fakeRepo.__queue()).toHaveLength(attempts ? 0 : 1);
  await screen.unmount();
});

test.each([true, false])('library reset clears retained terminal pull failures only on success (%s)', async (success) => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValue(new SupabaseRequestError('Protocol failure', 400));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  for (const ms of [5000, 15000]) await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  expect(screen.result.current.librarySyncFlow.phase).toBe('attention');
  if (!success) apiMock.__resetLibraryMock.mockRejectedValueOnce(new Error('Reset unavailable'));
  apiMock.__listBookmarksUpdatedSinceMock.mockResolvedValue([]);
  await act(async () => { expect((await screen.result.current.resetLibrary()).ok).toBe(success); });
  expect(screen.result.current.librarySyncFlow.phase).toBe(success ? 'idle' : 'attention');
  await screen.unmount();
});

test('reset cancels retry wakeups and prevents deferred duplicate pulls while it owns the sync lock', async () => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  let finish!: () => void;
  apiMock.__resetLibraryMock.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ bookmarks: 0 }); }));
  let reset!: ReturnType<typeof screen.result.current.resetLibrary>;
  await act(async () => { reset = screen.result.current.resetLibrary(); });
  await waitFor(() => expect(screen.result.current.isResettingLibrary).toBe(true));
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); expect(await screen.result.current.syncNow()).toBe(false); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await reset; });
  await act(async () => { await screen.result.current.syncNow(); await jest.advanceTimersByTimeAsync(100); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

test('local bookmark updates do not postpone an approaching pull retry deadline', async () => {
  jest.useFakeTimers();
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, ever_synced: true })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new Error('Network request failed'));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('retrying'));
  await act(async () => { await jest.advanceTimersByTimeAsync(10000); });
  for (let n = 0; n < 5; n++) {
    await act(async () => { screen.result.current.markBookmarkAccessed(id); });
    await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  }
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
  await screen.unmount();
});


test('overdue metadata-blocked creates do not spin full pulls', async () => {
  jest.useFakeTimers();
  mockHoldMetadata = true;
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, metadata_status: 'pending', sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date(Date.now() - 60000).toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/metadata-wait' },
    sync_status: 'failed', retry_count: 1, last_error_kind: 'retryable_http', last_error: 'HTTP 503', created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  const pulls = apiMock.__listBookmarksUpdatedSinceMock.mock.calls.length;
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
  expect(apiMock.__createBookmarkMock).not.toHaveBeenCalled();
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(pulls);
  await screen.unmount();
});

test('cold-start credential recovery survives a transient early session restoration failure', async () => {
  jest.useFakeTimers();
  authMock.__setAuth({ status: 'loading', session: null, userId: null });
  const id = '1a2b3c4d-0000-4000-8000-00000000abcd';
  fakeRepo.__reset([makeStoredBookmark({ id, sync_status: 'failed', ever_synced: false })]);
  fakeRepo.__setMeta('synced_user_id', 'real-user');
  const at = new Date().toISOString();
  await fakeRepo.repository.enqueue({ local_id: id, remote_id: null, operation: 'create', payload: { url: 'https://example.com/early-recovery' },
    sync_status: 'failed', retry_count: 1, last_error_kind: 'auth', last_error: 'HTTP 401', created_at: at, updated_at: at, last_attempt_at: at });
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.isLoading).toBe(false));
  authMock.useSupabaseAuth().ensureAnonymousSession.mockRejectedValueOnce(new Error('Network request failed'));
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user', credentialRecoveryVersion: 1 });
  await screen.rerender(undefined);
  await waitFor(() => expect(screen.result.current.isSyncing).toBe(false));
  await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  expect(apiMock.__createBookmarkMock).toHaveBeenCalledTimes(1);
  await screen.unmount();
});
