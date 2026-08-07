import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// Mirrors ai-enrichment-store.test.tsx's mocking harness — kept self-contained
// in this file since jest module factories can't be shared across test files.
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
    userId: mockSession.user.id,
    message: null,
    ensureAnonymousSession: async () => mockSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForForegroundState: () => () => {},
  registerForBackgroundClose: () => {},
}));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: `enrichment-${bookmarkId}`,
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
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
  const createCollection = jest.fn(async (name: string) => ({
    id: `coll-${name.toLowerCase()}`,
    user_id: 'user-test',
    name,
    description: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));
  const bulkAttachTagsAndCollections = jest.fn(
    async (
      items: Array<{ bookmark_id: string; tags: Array<{ name: string; source: string }> }>,
    ) =>
      items.map((item) => ({
        bookmark_id: item.bookmark_id,
        tags: item.tags.map((tag) => ({
          id: `tag-${tag.name}`,
          user_id: 'user-test',
          name: tag.name,
          slug: tag.name,
          source: tag.source,
          created_at: '2026-06-13T00:00:00.000Z',
        })),
        collection: null,
        collection_attached: false,
        bookmark_updated_at: null,
      })),
  );
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '7e64cf1e-0000-4000-8000-0000000000aa',
  }));
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  return {
    __spies: {
      requestEnrichment,
      addTags,
      createCollection,
      bulkAttachTagsAndCollections,
      listBookmarkIds,
      createBookmark,
      listEnrichmentsUpdatedSince,
    },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
      createCollection,
      bulkAttachTagsAndCollections,
      createBookmark,
      listBookmarksUpdatedSince: empty,
      listBookmarkIds,
      listEnrichmentsUpdatedSince,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: {
    requestEnrichment: jest.Mock;
    addTags: jest.Mock;
    createCollection: jest.Mock;
    listBookmarkIds: jest.Mock;
    createBookmark: jest.Mock;
    listEnrichmentsUpdatedSince: jest.Mock;
  };
};

const ID_A = '7e64cf1e-0000-4000-8000-000000000001';
const ID_B = '7e64cf1e-0000-4000-8000-000000000002';
const ID_C = '7e64cf1e-0000-4000-8000-000000000003';

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

beforeEach(() => {
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.createCollection.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
  apiMock.__spies.createBookmark.mockClear();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockReset();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValue([]);
});

// --- #573: the 3-tier mode itself ---

test('default mode is confirm, matching today\'s existing behavior with no settings change', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  expect(store.current!.aiSuggestionsMode).toBe('confirm');
});

test("'off' mode skips the automatic deferred trigger, but a manual request still works", async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  // Seed the mode as 'off' before mounting so the store hydrates it directly
  // (avoids racing the deferred-trigger effect's very first run).
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('off');

  // Give the deferred-trigger effect every chance to fire — it must not.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  // The durable "awaiting first attempt" marker is left untouched (not
  // consumed) so switching back to 'confirm'/'auto_accept' later still fires it.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([ID_A]));

  // A manual "Suggest with AI" tap must still work in 'off' mode.
  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(ID_A); // default source: 'manual'
  });
  expect(error).toBeNull();
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(ID_A, expect.anything(), 'en');
});

test("'off' mode also skips the backoff-scheduled retry check", async () => {
  const now = new Date().toISOString();
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({ [ID_A]: { firstAttemptAt: now, lastAttemptAt: now, attemptCount: 1 } }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    await Promise.resolve();
  });
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
});

// --- #573: auto_accept applies only high-confidence suggestions, and never
// relocates a bookmark the user (or an earlier accept) already filed ---

test('auto_accept applies a high-confidence tag, skips a low-confidence one, and never touches user-authored fields', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({
      id: ID_A,
      metadata_status: 'complete',
      collection_id: null, // unfiled
      notes: 'my own note',
      title: 'My own title',
    }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-auto-accept',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'A generated summary.',
    topics: [],
    suggested_tags: [
      { name: 'design', confidence: 0.8 }, // at/above SUGGESTION_MIN_CONFIDENCE (0.6)
      { name: 'noise', confidence: 0.3 }, // below threshold
    ],
    suggested_collection_id: null,
    suggested_collection_name: 'Reading', // no matching existing collection -> "create"
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('auto_accept');

  await act(async () => {
    await store.current!.requestAiEnrichment(ID_A, 'auto');
  });

  // High-confidence tag applied automatically, low-confidence one is not.
  const tagNames = store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name);
  expect(tagNames).toContain('design');
  expect(tagNames).not.toContain('noise');

  // The unfiled bookmark was filed into the newly created suggested folder.
  expect(apiMock.__spies.createCollection).toHaveBeenCalledWith('Reading');
  expect(store.current!.getBookmark(ID_A)?.collection_id).toBe('coll-reading');

  // User-authored fields are completely untouched.
  expect(store.current!.getBookmark(ID_A)?.notes).toBe('my own note');
  expect(store.current!.getBookmark(ID_A)?.title).toBe('My own title');

  // Auto-accept already handled it, so it should not ALSO raise the "new
  // suggestions" review banner for the same tags/folder.
  expect(store.current!.unseenSuggestionIds.has(ID_A)).toBe(false);
});

test('auto_accept never relocates a bookmark that is already filed in a different collection', async () => {
  fakeRepo.__reset(
    [
      makeStoredBookmark({
        id: ID_B,
        metadata_status: 'complete',
        collection_id: 'coll-existing',
      }),
    ],
    {
      tags: [],
      bookmarkTags: [],
      collections: [
        {
          id: 'coll-existing',
          user_id: 'user-test',
          name: 'Existing',
          description: null,
          created_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
    },
  );
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_B]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-move-suggestion',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: 'Somewhere Else',
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    await store.current!.requestAiEnrichment(ID_B, 'auto');
  });

  // A folder suggestion that would MOVE an already-filed bookmark is never
  // auto-applied -- only a fill of a still-unfiled bookmark is.
  expect(apiMock.__spies.createCollection).not.toHaveBeenCalled();
  expect(store.current!.getBookmark(ID_B)?.collection_id).toBe('coll-existing');
});

test('a broken auto_accept application (e.g. a failed createCollection call) still keeps the fetched enrichment and does not arm a spurious retry', async () => {
  // Regression: auto-accept used to run BEFORE the enrichment write and
  // inside the same try as the network fetch, so a bug in applying its
  // suggestions (unrelated to whether the fetch itself succeeded) would land
  // in requestAiEnrichment's OWN catch -- discarding a successfully fetched
  // enrichment and arming a retry for a request that actually succeeded.
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete', collection_id: null }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');
  apiMock.__spies.createCollection.mockRejectedValueOnce(new Error('network blip'));

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-auto-accept-broken',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: 'Reading', // triggers the (failing) createCollection path
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(ID_A, 'auto');
  });

  // The fetch itself succeeded, so requestAiEnrichment must report success...
  expect(error).toBeNull();
  // ...the enrichment is durably recorded regardless of auto-accept's fate...
  expect(store.current!.getEnrichment(ID_A)?.id).toBe('enrichment-auto-accept-broken');
  // ...and no retry is armed for what was actually a successful request. (No
  // retry was ever previously armed here, so clearAiRetry is a no-op and the
  // meta key is simply never written — `null`, not `'{}'`; see clearAiRetry.)
  expect(store.current!.isAiSuggestionPostponed(ID_A)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
});

// --- STASH-4P: auto_accept must also apply to enrichments this device never
// itself requested -- the background overflow worker's output, delivered
// through the ordinary sync pull. Previously only the direct-dispatch path
// (requestAiEnrichment's own settle handler) ran auto-accept, so a worker-
// completed enrichment landed with real suggested_tags but never got applied
// to bookmark_tags. ---

test('a worker-driven enrichment arriving via sync pull is auto-accepted too (STASH-4P)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete', collection_id: null }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'auto_accept');

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiSuggestionsMode).toBe('auto_accept');

  // This device never called requestAiEnrichment for ID_A -- exactly how the
  // background overflow worker's result arrives, via the ordinary sync pull.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({
      id: 'enrichment-worker-auto-accept',
      bookmark_id: ID_A,
      suggested_tags: [{ name: 'design', confidence: 0.8 }],
    }),
  ]);

  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(ID_A)).toBeDefined());
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(store.current!.getTagsForBookmark(ID_A).map((tag) => tag.name)).toContain('design'),
  );
});

// --- #574 Phase 1: staggered burst dispatch + completion toast ---

// These two run against REAL timers (not jest fake timers): the drain loop's
// setInterval-driven state update doesn't reliably propagate to a rendered
// hook consumer under this project's jest-expo + fake-timer combination (the
// same friction the pre-existing periodic-retry-check tests sidestep by
// invoking the registered foreground handler directly rather than letting a
// real/fake interval fire it — see `fireForeground` above). The real
// AI_ENRICHMENT_DISPATCH_STAGGER_MS is only 400ms, so real-time waits here
// stay fast and are not flaky: the second/third dispatch genuinely cannot
// fire before their own stagger tick elapses, regardless of machine speed.
test('a burst of auto-triggered bookmarks dispatches staggered (not all at once), and the completion toast fires once it drains', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: ID_A, metadata_status: 'complete' }),
    makeStoredBookmark({ id: ID_B, metadata_status: 'complete' }),
    makeStoredBookmark({ id: ID_C, metadata_status: 'complete' }),
  ]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A, ID_B, ID_C]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A, ID_B, ID_C]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // Nothing dispatches synchronously on mount — only once the first stagger
  // tick elapses.
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  // Well past one stagger tick (400ms) but comfortably short of two (800ms):
  // proves the burst is staggered rather than firing all three at once.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1), {
    timeout: 700,
  });
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);

  // The rest drain over the following stagger ticks.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(3), {
    timeout: 3000,
  });

  // All three ran (staggered) and every one of them settled, so this counts
  // as a burst worth a completion toast.
  await waitFor(() => expect(store.current!.aiEnrichmentBurstToast?.count).toBe(3));
}, 10000);

test('a single, routine auto-trigger completion does not raise the burst toast', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: ID_A, metadata_status: 'complete' })]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ID_A]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ID_A]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // Wait for the single dispatch to fully settle, then assert no toast was
  // raised for it — a lone completion is not a "burst".
  await waitFor(() => expect(store.current!.getEnrichment(ID_A)).toBeDefined(), { timeout: 2000 });
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();
}, 10000);
