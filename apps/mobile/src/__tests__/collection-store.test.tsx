import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Bookmark, Collection } from '@/domain/types';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

let mockAuthStatus = 'authenticated';
let mockAuthSession: unknown = {
  access_token: 'token',
  user: { id: 'user-1' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: mockAuthStatus,
    session: mockAuthSession,
    userId: 'user-1',
    message: null,
    ensureAnonymousSession: async () => mockAuthSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockUpdateCollection = jest.fn();
const mockDeleteCollection = jest.fn();
const mockDeleteCollections = jest.fn();

jest.mock('@/api/bookmarks', () => {
  const actual = jest.requireActual('@/api/bookmarks');
  return {
    ...actual,
    createBookmarkApi: () => ({
      updateCollection: (...args: unknown[]) => mockUpdateCollection(...args),
      deleteCollection: (...args: unknown[]) => mockDeleteCollection(...args),
      deleteCollections: (...args: unknown[]) => mockDeleteCollections(...args),
      listBookmarksUpdatedSince: async () => [],
      listBookmarkIds: async () => [],
      listEnrichmentsUpdatedSince: async () => [],
      listTags: async () => [],
      listBookmarkTags: async () => [],
      listCollections: async () => [],
    }),
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

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
  fakeRepo.__reset();
  mockAuthStatus = 'authenticated';
  mockAuthSession = { access_token: 'token', user: { id: 'user-1' } };
  mockUpdateCollection.mockReset();
  mockDeleteCollection.mockReset();
  mockDeleteCollections.mockReset();
});

test('renameCollection updates collection name locally and calls API', async () => {
  const col: Collection = {
    id: 'col-1',
    user_id: 'user-1',
    name: 'Old Name',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  fakeRepo.__reset([], {
    tags: [],
    bookmarkTags: [],
    collections: [col],
  });

  const updatedCol: Collection = {
    ...col,
    name: 'New Name',
    updated_at: '2026-10-02T00:00:00.000Z',
  };
  mockUpdateCollection.mockResolvedValue(updatedCol);

  const { result } = await renderStore();
  expect(result.current.collections).toHaveLength(1);
  expect(result.current.collections[0]?.name).toBe('Old Name');

  let outcome: { collection?: Collection; error?: string } = {};
  await act(async () => {
    outcome = await result.current.renameCollection('col-1', 'New Name');
  });

  expect(outcome.error).toBeUndefined();
  expect(outcome.collection?.name).toBe('New Name');
  expect(mockUpdateCollection).toHaveBeenCalledWith('col-1', { name: 'New Name' });
  expect(result.current.collections[0]?.name).toBe('New Name');
});

test('deleteCollection with uncategorize removes collection and sets bookmark collection_id to null', async () => {
  const col: Collection = {
    id: 'col-1',
    user_id: 'user-1',
    name: 'Work',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: 'b1', collection_id: 'col-1', title: 'Work 1' }),
      makeStoredBookmark({ id: 'b2', collection_id: null, title: 'Inbox 1' }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [col],
    },
  );
  mockDeleteCollections.mockResolvedValue(undefined);

  const { result } = await renderStore();
  expect(result.current.collections).toHaveLength(1);
  expect(result.current.inbox.find((b) => b.id === 'b1')?.collection_id).toBe('col-1');

  await act(async () => {
    const res = await result.current.deleteCollection('col-1', 'uncategorize');
    expect(res.error).toBeUndefined();
  });

  expect(result.current.collections).toHaveLength(0);
  expect(result.current.inbox.find((b) => b.id === 'b1')?.collection_id).toBeNull();
  expect(result.current.inbox.find((b) => b.id === 'b1')?.deleted_at).toBeNull();
  expect(mockDeleteCollections).toHaveBeenCalledWith(['col-1']);
});

test('deleteCollection with trash moves contained bookmarks to trash', async () => {
  const col: Collection = {
    id: 'col-1',
    user_id: 'user-1',
    name: 'Articles',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  fakeRepo.__reset(
    [makeStoredBookmark({ id: 'b1', collection_id: 'col-1', title: 'Article 1' })],
    {
      tags: [],
      bookmarkTags: [],
      collections: [col],
    },
  );
  mockDeleteCollections.mockResolvedValue(undefined);

  const { result } = await renderStore();

  await act(async () => {
    await result.current.deleteCollection('col-1', 'trash');
  });

  expect(result.current.collections).toHaveLength(0);
  expect(result.current.inbox.find((b) => b.id === 'b1')).toBeUndefined();
  expect(result.current.trash.find((b) => b.id === 'b1')).toBeDefined();
});

test('mergeCollections reassigns bookmarks and removes source collections', async () => {
  const colA: Collection = {
    id: 'col-a',
    user_id: 'user-1',
    name: 'Folder A',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  const colB: Collection = {
    id: 'col-b',
    user_id: 'user-1',
    name: 'Folder B',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: 'b1', collection_id: 'col-a', title: 'Doc A' }),
      makeStoredBookmark({ id: 'b2', collection_id: 'col-b', title: 'Doc B' }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [colA, colB],
    },
  );
  mockDeleteCollections.mockResolvedValue(undefined);

  const { result } = await renderStore();

  await act(async () => {
    const outcome = await result.current.mergeCollections(['col-a'], 'col-b');
    expect(outcome.error).toBeUndefined();
  });

  // Folder A was deleted, Folder B remains
  expect(result.current.collections).toHaveLength(1);
  expect(result.current.collections[0]?.id).toBe('col-b');

  // Both bookmarks are now in col-b
  expect(result.current.inbox.find((b) => b.id === 'b1')?.collection_id).toBe('col-b');
  expect(result.current.inbox.find((b) => b.id === 'b2')?.collection_id).toBe('col-b');
  expect(mockDeleteCollections).toHaveBeenCalledWith(['col-a']);
});

test('deleteCollections bulk deletes multiple collections', async () => {
  const colA: Collection = {
    id: 'col-a',
    user_id: 'user-1',
    name: 'Folder A',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  const colB: Collection = {
    id: 'col-b',
    user_id: 'user-1',
    name: 'Folder B',
    description: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  };
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: 'b1', collection_id: 'col-a', title: 'Doc A' }),
      makeStoredBookmark({ id: 'b2', collection_id: 'col-b', title: 'Doc B' }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [colA, colB],
    },
  );
  mockDeleteCollections.mockResolvedValue(undefined);

  const { result } = await renderStore();

  await act(async () => {
    const outcome = await result.current.deleteCollections(['col-a', 'col-b'], 'uncategorize');
    expect(outcome.error).toBeUndefined();
  });

  expect(result.current.collections).toHaveLength(0);
  expect(result.current.inbox.find((b) => b.id === 'b1')?.collection_id).toBeNull();
  expect(result.current.inbox.find((b) => b.id === 'b2')?.collection_id).toBeNull();
  expect(mockDeleteCollections).toHaveBeenCalledWith(['col-a', 'col-b']);
});
