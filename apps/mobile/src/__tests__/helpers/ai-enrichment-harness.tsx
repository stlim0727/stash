import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('@/storage/repository', () =>
  require('./fake-repository').createFakeRepositoryModule(),
);

export const mockSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};
// Spied (rather than inlined) so a test can simulate `ensureAnonymousSession`
// returning a freshER session than the reactive `mockHarness.authSession` — e.g. a
// token refresh that landed after `auth.session` was last read (STASH-49:
// the 429-overflow enqueue used to reuse the stale `auth.session` instead of
// this freshly-ensured one).

export const mockHarness: {
  authSession: typeof mockSession | null;
  foregroundHandlers: Array<{ onForeground?: () => void; onBackground?: () => void }>;
} = { authSession: mockSession, foregroundHandlers: [] };

export const mockEnsureAnonymousSession = jest.fn(async () => mockHarness.authSession);

jest.mock('@/supabase/auth-provider', () => ({
  // `userId` is derived from `mockHarness.authSession` (rather than hardcoded) so a
  // test can simulate an account switch (e.g. anonymous → real) by mutating
  // the session and re-rendering — the store's sign-in/account-switch pull
  // effect is keyed off `auth.userId` changing. Every other existing test's
  // default (`mockHarness.authSession = mockSession`, user id 'user-test') is
  // unaffected: this simply reads the same id off it instead of repeating it.
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockHarness.authSession,
    userId: mockHarness.authSession?.user.id ?? null,
    message: null,
    ensureAnonymousSession: mockEnsureAnonymousSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForForegroundState: (handler: { onForeground?: () => void; onBackground?: () => void }) => {
    mockHarness.foregroundHandlers.push(handler);
    return () => {
      mockHarness.foregroundHandlers = mockHarness.foregroundHandlers.filter((h) => h !== handler);
    };
  },
  registerForBackgroundClose: () => { },
}));

/** Simulate the app returning to the foreground: fires every registered
 *  `onForeground` callback (the loop-stall watchdog's and the AI-retry
 *  check's alike — both are inert/idempotent to call). */
export function fireForeground() {
  for (const handler of [...mockHarness.foregroundHandlers]) {
    handler.onForeground?.();
  }
}

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
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: 0.8,
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
  // Fake for the batch-attach RPC (issue #713) — syncTagOps now routes "add"
  // ops through this instead of addTags. Same fake-server shape as
  // mass-import-sync.test.tsx's bulkAttachMock.
  const bulkAttachTagsAndCollections = jest.fn(
    async (
      items: Array<{
        bookmark_id: string;
        tags: Array<{ name: string; source: string }>;
        collection_name: string | null;
      }>,
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
  // A create's follow-up reconcile update (e.g. once metadata settles); the
  // return value is unused by the caller.
  const updateBookmark = jest.fn(async () => undefined);
  // Reconfigurable so a test can let the pull keep a seeded row in state
  // (the default empty list otherwise diffs it away as a remote deletion).
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  // Sync upload: a create returns the remote id the local row adopts. Spied so
  // the auto-enrich-on-receive test can drive the full capture→sync→trigger path.
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '7e64cf1e-0000-4000-8000-0000000000aa',
  }));
  // Bulk create upload (2+ pending creates go through this path instead of
  // createBookmark). Defaults to echoing each input's own id back as a fresh
  // 'created' row, matching what a real create-under-its-own-id response
  // looks like.
  const createBookmarks = jest.fn(
    async (inputs: Array<{ id?: string }>) =>
      inputs.map((input) => ({
        bookmark_id: input.id ?? '00000000-0000-4000-8000-000000000000',
        status: 'created' as const,
        metadata_status: 'pending' as const,
      })),
  );
  // Pull's enrichment feed. Spied so a test can simulate another device
  // refreshing AI suggestions (a row arriving via pull rather than a local tap).
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  // STASH #578 Phase 2: enqueue-on-429 overflow path. Spied so a test can
  // assert it's called (or not) when requestAiEnrichment is rate limited.
  const enqueuePendingEnrichment = jest.fn(async () => { });
  // Codex review, PR #656: reconciles the confirmed-server-queued marker
  // against the queue's real remote status. Defaults to "still pending" (an
  // empty array would mean the row doesn't exist, which a test opts into
  // explicitly) — most tests never seed this at all.
  const fetchPendingEnrichmentStatuses = jest.fn(
    async (bookmarkIds: string[]) =>
      bookmarkIds.map((bookmark_id) => ({ bookmark_id, status: 'pending' })),
  );
  // Account-wide server-side AI queue snapshot (fetchAiServerQueueSnapshot in
  // store/bookmarks.tsx). Defaults to [] — the neutral "nothing extra beyond
  // what this device already knows about" value — so every pre-existing test
  // that never seeds this keeps seeing exactly its old local-only
  // processingStats.diagnostics.ai numbers.
  const fetchAiQueueSnapshot = jest.fn(async () => []);
  // Spied on its `session` arg (rather than ignoring it) so a test can assert
  // WHICH session object backed a given call — e.g. that the 429-overflow
  // enqueue used the same freshly-ensured session as the request itself,
  // not a stale one (STASH-49).
  const createBookmarkApi = jest.fn((_session: unknown) => ({
    requestEnrichment,
    addTags,
    bulkAttachTagsAndCollections,
    createBookmark,
    createBookmarks,
    updateBookmark,
    listBookmarksUpdatedSince: empty,
    listBookmarkIds,
    listEnrichmentsUpdatedSince,
    listTags: empty,
    listBookmarkTags: empty,
    listCollections: empty,
    enqueuePendingEnrichment,
    fetchPendingEnrichmentStatuses,
    fetchAiQueueSnapshot,
  }));
  return {
    __spies: {
      requestEnrichment,
      addTags,
      bulkAttachTagsAndCollections,
      listBookmarkIds,
      createBookmark,
      createBookmarks,
      updateBookmark,
      listEnrichmentsUpdatedSince,
      enqueuePendingEnrichment,
      fetchPendingEnrichmentStatuses,
      fetchAiQueueSnapshot,
      createBookmarkApi,
    },
    createBookmarkApi,
  };
});

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './fake-repository';
import { makeStoredBookmark } from './fake-repository';

export const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
export const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: {
    requestEnrichment: jest.Mock;
    addTags: jest.Mock;
    bulkAttachTagsAndCollections: jest.Mock;
    listBookmarkIds: jest.Mock;
    createBookmark: jest.Mock;
    createBookmarks: jest.Mock;
    updateBookmark: jest.Mock;
    listEnrichmentsUpdatedSince: jest.Mock;
    enqueuePendingEnrichment: jest.Mock;
    fetchPendingEnrichmentStatuses: jest.Mock;
    fetchAiQueueSnapshot: jest.Mock;
    createBookmarkApi: jest.Mock;
  };
};

export const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
// The remote id a synced create adopts (must match the mock's createBookmark).
export const REMOTE_ID = '7e64cf1e-0000-4000-8000-0000000000aa';

export type Store = ReturnType<typeof useBookmarks>;

export function renderStore() {
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

export async function renderReady() {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  // Let the initial pull settle so it can't overwrite state after our action.
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  return store;
}

// Mount fires the auto-sync effect and the sign-in-pull effect (keyed off
// `lastSyncedUserId.current` starting null) in the same commit whenever the
// queue is non-empty — one of them always defers via syncPendingRef and
// re-fires syncNow() ~50ms later, regardless of any fix's correctness. A
// fixed-length wait for that alone races real wall-clock time (flaky when
// the whole test:components suite loads the machine, since the real
// scheduled timer can fire later than its nominal delay) — this instead
// polls until `isSyncing` is false AND the given call count hasn't changed
// for a stability window, so it adapts to however long that actually takes.
export async function waitUntilSyncQuiescent(
  store: { current: Store | null },
  getCallCount: () => number,
  { stableForMs = 300, pollMs = 30, timeoutMs = 5000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = getCallCount();
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const count = getCallCount();
    if (count !== lastCount || store.current?.isSyncing) {
      lastCount = count;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt >= stableForMs) {
      return;
    }
  }
}

// --- AI-suggestion retry bookkeeping (postponed state + backoff) ---

/** A minimal, valid AIEnrichment success response for retry tests. */
export function makeSuccessEnrichment(bookmarkId: string) {
  return {
    id: 'enrichment-retry-success',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'Generated summary',
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
  };
}

// STASH #578 Phase 2: the background overflow worker delivers its results
// through the ordinary sync pull (no new polling/realtime), so a pull that
// brings down 2+ enrichments this device never itself requested should feed
// the same "N bookmarks checked for AI suggestions" burst-completion toast
// that a burst of direct auto-dispatches already triggers (STASH #574 Phase 1).
export const SECOND_SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000002';
export function resetEnrichmentHarness() {
  mockHarness.authSession = mockSession;
  mockEnsureAnonymousSession.mockReset();
  mockEnsureAnonymousSession.mockImplementation(async () => mockHarness.authSession);
  mockHarness.foregroundHandlers = [];
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.bulkAttachTagsAndCollections.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
  apiMock.__spies.createBookmark.mockClear();
  // Reset (not just clear) — a test that overrides this with a persistent
  // (non-Once) mock implementation would otherwise leak it forward into
  // every later test in this file.
  apiMock.__spies.createBookmarks.mockReset();
  apiMock.__spies.createBookmarks.mockImplementation(async (inputs: Array<{ id?: string }>) =>
    inputs.map((input) => ({
      bookmark_id: input.id ?? '00000000-0000-4000-8000-000000000000',
      status: 'created' as const,
      metadata_status: 'pending' as const,
    })),
  );
  apiMock.__spies.listEnrichmentsUpdatedSince.mockReset();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValue([]);
  apiMock.__spies.enqueuePendingEnrichment.mockClear();
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockReset();
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockImplementation(
    async (bookmarkIds: string[]) =>
      bookmarkIds.map((bookmark_id) => ({ bookmark_id, status: 'pending' })),
  );
  apiMock.__spies.fetchAiQueueSnapshot.mockReset();
  apiMock.__spies.fetchAiQueueSnapshot.mockResolvedValue([]);
  apiMock.__spies.createBookmarkApi.mockClear();
}
