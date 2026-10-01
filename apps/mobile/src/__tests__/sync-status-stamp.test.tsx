import { act, renderHook, waitFor } from '@testing-library/react-native';
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

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
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
};
const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __createBookmarkMock: jest.Mock;
  __listBookmarksUpdatedSinceMock: jest.Mock;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  fakeRepo.__reset();
  apiMock.__createBookmarkMock.mockClear();
  apiMock.__listBookmarksUpdatedSinceMock.mockClear();
  mockUpsertSyncStatus.mockClear();
  mockUpsertSyncStatus.mockImplementation(async () => {});
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user' });
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
      await act(async () => { mockNetworkListener({ isConnected: true, isInternetReachable: true }); });
      await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe('idle'));
      expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(2);
    }
    await screen.unmount();
  },
);

test.each([[401, 'sign_in'], [403, 'permission']])('HTTP %s requests user action instead of auto-retrying', async (status, phase) => {
  jest.useFakeTimers();
  apiMock.__listBookmarksUpdatedSinceMock.mockRejectedValueOnce(new SupabaseRequestError('Denied', status as number));
  const screen = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(screen.result.current.librarySyncFlow.phase).toBe(phase));
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  expect(apiMock.__listBookmarksUpdatedSinceMock).toHaveBeenCalledTimes(1);
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
