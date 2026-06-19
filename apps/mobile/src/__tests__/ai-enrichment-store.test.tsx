import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

const mockSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockSession,
    userId: 'user-test',
    message: null,
    ensureAnonymousSession: async () => mockSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Stub the network API: the enrichment "producer" and tag writes are spied,
// while the pull-sync list calls return nothing so mounting stays inert.
jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: 'enrichment-new',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'Generated summary',
    topics: ['design'],
    suggested_tags: [{ name: 'design', confidence: 0.8 }],
    suggested_collection_id: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: 0.8,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));
  const addTags = jest.fn(async ({ tags, source }: { tags: string[]; source: string }) =>
    tags.map((name) => ({
      id: `tag-${name}`,
      user_id: 'user-test',
      name,
      slug: name,
      source,
      created_at: '2026-06-13T00:00:00.000Z',
    })),
  );
  return {
    __spies: { requestEnrichment, addTags },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
      listBookmarksUpdatedSince: empty,
      listBookmarkIds: empty,
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: { requestEnrichment: jest.Mock; addTags: jest.Mock };
};

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

type Store = ReturnType<typeof useBookmarks>;

function renderStore() {
  const ref: { current: Store | null } = { current: null };
  function Probe() {
    ref.current = useBookmarks();
    return null;
  }
  render(
    <BookmarksProvider>
      <Probe />
    </BookmarksProvider>,
  );
  return ref;
}

async function renderReady() {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  // Let the initial pull settle so it can't overwrite state after our action.
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  return store;
}

beforeEach(() => {
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
});

test('requestAiEnrichment fetches and surfaces the enrichment', async () => {
  const store = await renderReady();

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(error).toBeNull();
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(SYNCED_ID);
  expect(store.current!.getEnrichment(SYNCED_ID)?.summary).toBe('Generated summary');
});

test('isEnriching reports true while a request is in flight, false once it settles', async () => {
  const store = await renderReady();

  // Hold the request open so we can observe the in-flight state.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => {
    await gate;
    return {
      id: 'enrichment-new',
      bookmark_id: bookmarkId,
      user_id: 'user-test',
      summary: 'Generated summary',
      topics: [],
      suggested_tags: [],
      suggested_collection_id: null,
      model: 'dummy-v0',
      status: 'complete',
      confidence: null,
      created_at: '2026-06-13T00:00:00.000Z',
      updated_at: '2026-06-13T00:00:00.000Z',
    };
  });

  expect(store.current!.isEnriching(SYNCED_ID)).toBe(false);

  let pending: Promise<string | null>;
  await act(async () => {
    pending = store.current!.requestAiEnrichment(SYNCED_ID);
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(true);

  await act(async () => {
    release();
    await pending;
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(false);
});

test('acceptSuggestedTags links the tag with source ai and its confidence', async () => {
  const store = await renderReady();

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.acceptSuggestedTags(SYNCED_ID, [
      { name: 'design', confidence: 0.8 },
    ]);
  });

  expect(error).toBeNull();
  expect(apiMock.__spies.addTags).toHaveBeenCalledWith(
    expect.objectContaining({ bookmark_id: SYNCED_ID, source: 'ai' }),
  );
  expect(store.current!.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).toContain('design');
});
