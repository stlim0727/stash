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
// Mutable so a test can simulate a cold start where storage loads before the
// auth session is restored (session null). `mock`-prefixed so jest's factory
// hoisting allows referencing it.
let mockAuthSession: typeof mockSession | null = mockSession;

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockAuthSession,
    userId: 'user-test',
    message: null,
    ensureAnonymousSession: async () => mockAuthSession,
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
  // Reconfigurable so a test can let the pull keep a seeded row in state
  // (the default empty list otherwise diffs it away as a remote deletion).
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  return {
    __spies: { requestEnrichment, addTags, listBookmarkIds },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
      listBookmarksUpdatedSince: empty,
      listBookmarkIds,
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
  __spies: { requestEnrichment: jest.Mock; addTags: jest.Mock; listBookmarkIds: jest.Mock };
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
  mockAuthSession = mockSession;
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
});

test('requestAiEnrichment fetches and surfaces the enrichment', async () => {
  const store = await renderReady();

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(error).toBeNull();
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(SYNCED_ID, undefined);
  expect(store.current!.getEnrichment(SYNCED_ID)?.summary).toBe('Generated summary');
});

test('requestAiEnrichment forwards the device\'s freshest metadata', async () => {
  // Keep the seeded row in state so requestAiEnrichment can read its metadata
  // (without this the inert pull would diff it away as a remote deletion).
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, title: 'Tender steak', site_name: 'YouTube' }),
  ]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  await waitFor(() => expect(store.current?.getBookmark(SYNCED_ID)).toBeDefined());

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  // The cloud row can still be a bare URL; the device sends what it has so the
  // model reasons about the real title/site instead of nothing.
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
    SYNCED_ID,
    expect.objectContaining({ title: 'Tender steak', site_name: 'YouTube', content_type: 'url' }),
  );
});

test('re-hydrates a persisted deferred AI trigger and fires it after a restart', async () => {
  // Simulates: a create synced, then the app was killed during the metadata
  // fetch window. The marker was persisted; metadata is settled on relaunch.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The deferred trigger fires on launch (no manual tap needed)...
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(SYNCED_ID, expect.anything()),
  );
  // ...and the durable marker is cleared once it succeeds, so it won't re-fire.
  await waitFor(() => expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]'));
});

test('does not consume a deferred AI trigger before the auth session is ready', async () => {
  // Cold start: storage (and the persisted marker) loads before auth restores.
  mockAuthSession = null;
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.getBookmark(SYNCED_ID)).toBeDefined());

  // With no session the effect must NOT fire or burn the marker — otherwise the
  // trigger would be lost when auth becomes ready.
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));
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
