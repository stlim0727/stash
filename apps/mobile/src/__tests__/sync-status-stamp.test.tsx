import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// GH #687 follow-up: syncNow fires a fire-and-forget stamp into
// user_sync_status once a full sync pass (upload + pull) actually completes.
// These tests drive the real store (and the real trackSyncStatus) against a
// mocked auth session/API/PostgREST client, and assert the stamp fires
// exactly on a completed pass — never on an early return (no session) — and
// that a failing write never surfaces as a failed sync.
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

const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
};

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(() => {
  mockUpsertSyncStatus.mockClear();
  mockUpsertSyncStatus.mockImplementation(async () => {});
  authMock.__setAuth({ status: 'authenticated', session: mockRealSession, userId: 'real-user' });
});

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
