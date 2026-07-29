import { act, render, renderHook, waitFor } from '@testing-library/react-native';
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
  // `userId` is derived from `mockAuthSession` (rather than hardcoded) so a
  // test can simulate an account switch (e.g. anonymous → real) by mutating
  // the session and re-rendering — the store's sign-in/account-switch pull
  // effect is keyed off `auth.userId` changing. Every other existing test's
  // default (`mockAuthSession = mockSession`, user id 'user-test') is
  // unaffected: this simply reads the same id off it instead of repeating it.
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockAuthSession,
    userId: mockAuthSession?.user.id ?? null,
    message: null,
    ensureAnonymousSession: async () => mockAuthSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Fake foreground-state registration so tests can simulate an app
// background→foreground transition without depending on react-native's
// AppState mock (which the real `.native.ts` implementation subscribes to only
// once, module-wide — awkward to drive from a test). Mirrors the real
// module's shape; `mockForegroundHandlers` must keep the `mock` prefix so
// Jest's module-factory hoisting allows referencing it here.
let mockForegroundHandlers: Array<{
  onForeground?: () => void;
  onBackground?: () => void;
}> = [];
jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForForegroundState: (handler: { onForeground?: () => void; onBackground?: () => void }) => {
    mockForegroundHandlers.push(handler);
    return () => {
      mockForegroundHandlers = mockForegroundHandlers.filter((h) => h !== handler);
    };
  },
  registerForBackgroundClose: () => {},
}));

/** Simulate the app returning to the foreground: fires every registered
 *  `onForeground` callback (the loop-stall watchdog's and the AI-retry
 *  check's alike — both are inert/idempotent to call). */
function fireForeground() {
  for (const handler of [...mockForegroundHandlers]) {
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
  const enqueuePendingEnrichment = jest.fn(async () => {});
  return {
    __spies: {
      requestEnrichment,
      addTags,
      listBookmarkIds,
      createBookmark,
      createBookmarks,
      updateBookmark,
      listEnrichmentsUpdatedSince,
      enqueuePendingEnrichment,
    },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
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
    }),
  };
});

import { AI_RATE_LIMITED, BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { BULK_CREATE_SYNC_CHUNK_SIZE } from '@/sync/sync-bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: {
    requestEnrichment: jest.Mock;
    addTags: jest.Mock;
    listBookmarkIds: jest.Mock;
    createBookmark: jest.Mock;
    createBookmarks: jest.Mock;
    updateBookmark: jest.Mock;
    listEnrichmentsUpdatedSince: jest.Mock;
    enqueuePendingEnrichment: jest.Mock;
  };
};

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
// The remote id a synced create adopts (must match the mock's createBookmark).
const REMOTE_ID = '7e64cf1e-0000-4000-8000-0000000000aa';

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
  mockForegroundHandlers = [];
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
  apiMock.__spies.createBookmark.mockClear();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockReset();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValue([]);
  apiMock.__spies.enqueuePendingEnrichment.mockClear();
});

test('requestAiEnrichment fetches and surfaces the enrichment', async () => {
  const store = await renderReady();

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(error).toBeNull();
  // The anonymous initial pull no longer diffs the seeded synced row away as a
  // phantom "deleted on another device" (that was the data-loss bug), so the row
  // survives and requestAiEnrichment sends its on-device metadata. The active
  // locale (English in tests, no provider) rides along so the model answers in
  // the user's language (M12).
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
    SYNCED_ID,
    expect.objectContaining({ title: 'Stored bookmark', content_type: 'url' }),
    'en',
  );
  expect(store.current!.getEnrichment(SYNCED_ID)?.summary).toBe('Generated summary');
});

test('requestAiEnrichment surfaces a calm message when rate limited (429)', async () => {
  // The backend ai-enrich function caps per-user calls and returns 429 when the
  // window is exhausted (e.g. a bulk import auto-firing many enrichments). The
  // store should surface the localizable rate-limit sentinel rather than a raw
  // error, and must NOT write a (non-existent) enrichment.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(error).toBe(AI_RATE_LIMITED);
  expect(store.current!.getEnrichment(SYNCED_ID)).toBeUndefined();
});

test('a 429 enqueues the bookmark for the background overflow worker (STASH #578)', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(() => expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledTimes(1));
  expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledWith(SYNCED_ID, 'en');
});

test('a 429 still surfaces the rate-limited sentinel even if the enqueue call itself fails', async () => {
  // Fire-and-forget: an enqueue failure must never change what the caller
  // sees for the original 429, nor throw out of requestAiEnrichment.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  apiMock.__spies.enqueuePendingEnrichment.mockRejectedValueOnce(new Error('network down'));

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(error).toBe(AI_RATE_LIMITED);
});

test('a non-429 failure does not enqueue for the overflow worker', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('ai-enrich returned 500');
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(apiMock.__spies.enqueuePendingEnrichment).not.toHaveBeenCalled();
});

test('a 429 with a CONFIRMED (resolved) enqueue marks the bookmark as server-queued (STASH #578 follow-up)', async () => {
  // Distinct from the generic local-retry marker (armAiRetry, always armed
  // for this same 429): this one is only set once the enqueue POST itself
  // durably lands server-side.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(() => expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true));
});

test('the server-queued flag survives exhausting the local retry cap, unlike isAiSuggestionPostponed (STASH #578 follow-up)', async () => {
  // The core bug this feature fixes: AI_RETRY_MAX_ATTEMPTS gives up on the
  // generic local marker and clears it entirely, reverting the bookmark to
  // looking never-asked. The confirmed server-queued marker must NOT revert
  // with it — the server queue entry is still alive and will still deliver.
  const store = await renderReady();
  // mockImplementationOnce (not the persistent mockImplementation the other
  // retry-cap test below uses) so this doesn't leave every LATER test in this
  // file's default (successful) requestEnrichment permanently replaced —
  // this test runs earlier in file order than that one.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
      throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
    });
    await act(async () => {
      await store.current!.requestAiEnrichment(SYNCED_ID, attempt === 1 ? 'auto' : 'manual');
    });
  }
  await waitFor(() => expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true));

  // The generic marker has exhausted and cleared...
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
  // ...but the server-queued marker is untouched by that cap.
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);
});

test('a 429 whose enqueue call REJECTS does not mark the bookmark as server-queued', async () => {
  // No false promise: falls back to the generic armAiRetry treatment alone.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  apiMock.__spies.enqueuePendingEnrichment.mockRejectedValueOnce(new Error('network down'));

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID);
  });
  expect(error).toBe(AI_RATE_LIMITED);

  // Let the rejected enqueue promise's .catch() settle before asserting the
  // negative — otherwise a bug that set the flag late would go unnoticed.
  await waitFor(() => expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
  });

  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false);
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
});

test('a slow enqueue confirmation does not strand the server-queued flag on an already-enriched bookmark (STASH #578 follow-up)', async () => {
  // The set-after-clear race this guard exists for: the aiEnriching dedup
  // guard for the FIRST (429'd) call releases as soon as its catch block
  // returns AI_RATE_LIMITED — well before the un-awaited enqueue POST below
  // settles. That leaves a window where a SECOND call for the same bookmark
  // (e.g. an impatient manual "Suggest with AI" retap, which deliberately
  // ignores backoff and fires immediately) can start, succeed, and land a
  // real enrichment BEFORE the first call's enqueue confirmation arrives. If
  // that confirmation then unconditionally marked the bookmark queued, it
  // would strand "will arrive automatically" on a bookmark that's already
  // done — nothing would ever clear it again (the sync-pull clear only fires
  // for a strictly newer arrival).
  const store = await renderReady();

  let releaseEnqueue!: () => void;
  const enqueueGate = new Promise<void>((resolve) => {
    releaseEnqueue = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  apiMock.__spies.enqueuePendingEnrichment.mockImplementationOnce(async () => {
    await enqueueGate; // held open — simulates a slow confirmation round trip
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });
  await waitFor(() => expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledTimes(1));
  // Nothing set yet — the enqueue confirmation is still held open.
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false);

  // A faster, second attempt for the SAME bookmark succeeds directly — e.g.
  // the user retapping "Suggest with AI" (which ignores backoff), or a
  // worker delivery arriving via sync. Either way, this bookmark is now
  // genuinely done before the first call's enqueue ever confirms.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) =>
    makeSuccessEnrichment(bookmarkId),
  );
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });
  expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined();
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false);

  // Now let the FIRST call's stale enqueue confirmation land, late.
  await act(async () => {
    releaseEnqueue();
    await Promise.resolve();
    await Promise.resolve();
  });

  // It must NOT re-arm the marker on a bookmark that's already resolved.
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false);
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
    'en',
  );
});

test('a freshly captured bookmark gets AI suggestions automatically once it syncs (no manual tap)', async () => {
  // The core "auto-suggest on receive" promise: capture a bookmark, and once it
  // syncs and its metadata settles, suggestions should appear on their own —
  // the user should NOT have to tap "Suggest with AI". This drives the full real
  // path (addBookmark → create upload → deferred trigger), all under the
  // bookmark's own stable id (no rename on sync — see makeBookmarkId).
  fakeRepo.__reset([]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  let bookmarkId = '';
  await act(async () => {
    const result = store.current!.addBookmark({ url: 'example.com/auto-suggest' });
    if (result.status !== 'invalid') {
      bookmarkId = result.bookmark.id;
    }
  });
  // The synced row must survive the pull's deletion diff (which would otherwise
  // treat an id it can't see remotely as a remote deletion).
  apiMock.__spies.listBookmarkIds.mockResolvedValue([bookmarkId]);

  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  // ...and the AI enrichment fires for it WITHOUT any manual requestAiEnrichment.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      bookmarkId,
      expect.anything(),
      'en',
    ),
  );
  await waitFor(() => expect(store.current!.getEnrichment(bookmarkId)).toBeDefined());
});

test('a bulk create sync (2+ pending creates) actually clears the queue and marks bookmarks synced (Sentry STASH-3V/3X)', async () => {
  // Reproduces the reported "sync stuck re-uploading the same 561/59 items
  // forever" bug: applyBulkCreateChunkResults gated clearing the queue on
  // result.removeEntry, but syncCreateQueueEntryBatch NEVER sets that field —
  // every one of its results represents a completed create (a batch failure
  // throws instead of returning a per-entry retry state). With the gate in
  // place, a successful bulk upload silently did nothing: the queue entries
  // stayed 'pending', the bookmarks never flipped to 'synced', and the
  // background auto-sync effect (which re-fires whenever the queue still has
  // pending work) immediately re-ran the exact same upload forever.
  fakeRepo.__reset([]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  const ids: string[] = [];
  await act(async () => {
    for (const url of ['example.com/bulk-a', 'example.com/bulk-b']) {
      const result = store.current!.addBookmark({ url });
      if (result.status !== 'invalid') {
        ids.push(result.bookmark.id);
      }
    }
  });
  expect(ids).toHaveLength(2);
  apiMock.__spies.listBookmarkIds.mockResolvedValue(ids);

  await waitFor(() => expect(apiMock.__spies.createBookmarks).toHaveBeenCalled());
  // The queue must actually drain — not just "eventually", but settle to
  // empty, proving the sync loop terminates instead of re-uploading forever.
  await waitFor(() => expect(store.current!.queue).toHaveLength(0));
  for (const id of ids) {
    expect(store.current!.getBookmark(id)?.sync_status).toBe('synced');
  }

  // Durable storage must reflect it too, or a reload resurrects the same
  // "still pending" state and the loop resumes on next launch.
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  for (const id of ids) {
    const stored = fakeRepo.__bookmarks().find((b) => b.id === id);
    expect(stored?.sync_status).toBe('synced');
  }
});

test('a bulk create sync failure records retry state instead of silently resetting to pending', async () => {
  // A bulk-endpoint failure must behave like any other sync failure: mark the
  // entry 'failed' with an incremented retry_count and last_error, so it's
  // visible to the user and eligible for health escalation (see
  // crossedHealthEscalationThreshold) — not just silently reset back to
  // 'pending' with no record anything went wrong.
  fakeRepo.__reset([]);
  apiMock.__spies.createBookmarks.mockRejectedValueOnce(new Error('network down'));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  const ids: string[] = [];
  await act(async () => {
    for (const url of ['example.com/bulk-fail-a', 'example.com/bulk-fail-b']) {
      const result = store.current!.addBookmark({ url });
      if (result.status !== 'invalid') {
        ids.push(result.bookmark.id);
      }
    }
  });
  expect(ids).toHaveLength(2);

  await waitFor(() => expect(apiMock.__spies.createBookmarks).toHaveBeenCalled());
  await waitFor(() =>
    expect(store.current!.queue.every((entry) => entry.sync_status === 'failed')).toBe(true),
  );
  for (const entry of store.current!.queue) {
    expect(entry.retry_count).toBe(1);
    expect(entry.last_error).toBe('network down');
  }
  for (const id of ids) {
    expect(store.current!.getBookmark(id)?.sync_status).toBe('failed');
  }

  // Durable storage must reflect the failure too.
  await waitFor(() =>
    expect(fakeRepo.__queue().every((entry) => entry.sync_status === 'failed')).toBe(true),
  );
  for (const id of ids) {
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.sync_status).toBe('failed');
  }
});

test('a bulk create failure keeps untried later chunks out of the single-entry fallback', async () => {
  // BULK_CREATE_SYNC_CHUNK_SIZE + 1 entries span two chunks. The first
  // chunk's bulk request fails; the second chunk is never even attempted
  // this run. Regression: marking only the failed chunk (not every
  // bulk-eligible entry) as "handled" let the per-entry loop below fall
  // through and fire single createBookmark requests for the untried
  // chunk — hundreds of sequential requests during a real outage instead of
  // waiting for the next bulk retry.
  const rows = Array.from({ length: BULK_CREATE_SYNC_CHUNK_SIZE + 1 }, (_, index) =>
    makeStoredBookmark({
      id: `7e64cf1e-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      url: `https://example.com/bulk-many-${index + 1}`,
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
  );
  fakeRepo.__reset(rows);
  for (const row of rows) {
    await fakeRepo.repository.enqueue({
      local_id: row.id,
      remote_id: null,
      operation: 'create',
      payload: { id: row.id, url: row.url!, client_id: row.id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
  // Fails exactly once, so the queue eventually quiesces (the retry
  // succeeds) instead of retrying forever — the test only needs to prove
  // createBookmark (singular) is never called along the way, not pin down
  // every intermediate per-entry status across however many auto-triggered
  // passes it takes to settle.
  apiMock.__spies.createBookmarks.mockRejectedValueOnce(new Error('network down'));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() =>
    expect(
      store.current!.queue.every(
        (entry) => entry.sync_status !== 'pending' && entry.sync_status !== 'syncing',
      ),
    ).toBe(true),
  );

  expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
});

test('a create that resolves as a server-side duplicate adopts the existing row, no doubled card (Sentry STASH-3Q)', async () => {
  // Reproduces the reported bug: the server dedupes a create against an
  // EXISTING different row (same canonical URL) and returns that row's id
  // instead of the one the client sent. Keeping the local row under its own
  // id here used to leave a phantom "synced" row under an id Postgres has no
  // record of, so the next pull fetched the real existing row separately and
  // the library doubled.
  fakeRepo.__reset([]);
  const existingId = '00000000-0000-4000-8000-0000000000ee';
  apiMock.__spies.createBookmark.mockImplementationOnce(async () => ({
    bookmark_id: existingId,
    status: 'duplicate',
  }));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  let bookmarkId = '';
  await act(async () => {
    const result = store.current!.addBookmark({ url: 'example.com/already-exists' });
    if (result.status !== 'invalid') {
      bookmarkId = result.bookmark.id;
    }
  });
  apiMock.__spies.listBookmarkIds.mockResolvedValue([existingId]);

  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  await waitFor(() => expect(store.current!.getBookmark(existingId)?.sync_status).toBe('synced'));

  // Exactly one card, under the existing id — not two.
  const matching = store.current!.inbox.filter((b) => b.url === 'https://example.com/already-exists');
  expect(matching).toHaveLength(1);
  expect(matching[0]?.id).toBe(existingId);
  // The phantom original id is gone from the visible library, but still
  // resolves to the live row via the alias map (same UX guarantee as a
  // rehome) instead of reading as "not found".
  expect(store.current!.inbox.some((b) => b.id === bookmarkId)).toBe(false);
  expect(store.current!.getBookmark(bookmarkId)?.id).toBe(existingId);

  // Durably too: the phantom row under the original id must not linger in
  // storage, or a reload resurrects the duplicate.
  await waitFor(() => expect(fakeRepo.__bookmarks().some((b) => b.id === bookmarkId)).toBe(false));
  const stored = fakeRepo.__bookmarks().filter((b) => b.url === 'https://example.com/already-exists');
  expect(stored).toHaveLength(1);
  expect(stored[0]?.id).toBe(existingId);
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
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      SYNCED_ID,
      expect.anything(),
      'en',
    ),
  );
  // ...and the durable marker is cleared once it succeeds, so it won't re-fire.
  await waitFor(() => expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]'));
});

test('a deferred first attempt keeps a durable marker throughout the in-flight window and on failure', async () => {
  // Regression: the deferred-trigger effect used to clear pending_ai_trigger
  // synchronously, before requestAiEnrichment even started — relying entirely
  // on armAiRetry (which only runs from requestAiEnrichment's own catch, after
  // a failure is observed) to arm the replacement bookkeeping. An app kill
  // mid-request (anywhere in the in-flight window below, before that catch
  // ever runs) left NEITHER marker durably recorded: this bookmark's
  // first-ever automatic enrichment attempt vanished with no trace for any
  // future relaunch to retry. This test never resolves the mocked request
  // until we explicitly fail it, so it can assert on the in-flight window
  // itself, not just the settled outcome.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  let reject!: (error: unknown) => void;
  const gate = new Promise((_resolve, r) => {
    reject = r;
  });
  gate.catch(() => {}); // silence the unhandled-rejection warning from the gate itself
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await gate; // simulates the live network round trip an app kill could land in
    throw new Error('unreachable');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The deferred trigger fires...
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());
  // ...but while the request is still in flight (the crash window), the
  // durable pending-trigger marker must NOT have been cleared yet: if the
  // process died right now, a relaunch still has a durable trace to retry.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));
  // Nor is the retry marker armed yet — armAiRetry only runs once the
  // failure is actually observed, further below.
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);

  // Now let the in-flight request actually fail.
  await act(async () => {
    reject(new Error('network died mid-request'));
    await Promise.resolve();
  });

  // Once it settles, armAiRetry has recorded the backoff-scheduled retry
  // marker...
  await waitFor(() => expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true));
  // ...and the pending-trigger marker is now cleared too: its crash-safety
  // job (surviving from launch until the outcome is durably recorded) is
  // done, since the failure now has its own durable trace in
  // `ai_suggestion_retry`. Leaving it present here would let a relaunch
  // inside the backoff window rehydrate it and re-fire the request
  // immediately via the deferred-trigger effect, bypassing backoff entirely.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]');
});

test('a failed deferred first attempt awaits the retry-marker write landing before clearing the pending-trigger marker', async () => {
  // armAiRetry's retry-state write and clearPendingAiTrigger's pending-trigger
  // write must be a true sequence — the retry marker's write settled BEFORE
  // the pending-trigger write is even issued — not two unawaited
  // fire-and-forget writes started back to back. Otherwise a process kill
  // between them could still leave storage with the trigger cleared and the
  // retry marker's replacement write never having landed, reopening the exact
  // crash window this ordering exists to close.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const setMetaCalls: string[] = [];
  let releaseRetryWrite!: () => void;
  const retryWriteGate = new Promise<void>((resolve) => {
    releaseRetryWrite = resolve;
  });
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const setMetaSpy = jest
    .spyOn(fakeRepo.repository, 'setMeta')
    .mockImplementation(async (key, value) => {
      setMetaCalls.push(key);
      if (key === 'ai_suggestion_retry') {
        await retryWriteGate; // hold this write open until the test releases it
      }
      return originalSetMeta(key, value);
    });

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('network died mid-request');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());

  // The retry-state write has been issued (armAiRetry ran and is awaiting its
  // own persistence) but is deliberately held open. If the two writes were
  // sequenced correctly, the pending-trigger write must not have been issued
  // yet at this point.
  await waitFor(() => expect(setMetaCalls).toContain('ai_suggestion_retry'));
  expect(setMetaCalls).not.toContain('pending_ai_trigger');
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));

  // Let the retry-state write land, and the rest of the catch block proceed.
  await act(async () => {
    releaseRetryWrite();
    await Promise.resolve();
    await Promise.resolve();
  });

  await waitFor(() => expect(setMetaCalls).toContain('pending_ai_trigger'));
  expect(setMetaCalls.indexOf('ai_suggestion_retry')).toBeLessThan(
    setMetaCalls.indexOf('pending_ai_trigger'),
  );
  await waitFor(() => expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]'));

  setMetaSpy.mockRestore();
});

test('a failed deferred first attempt keeps the pending-trigger marker if the retry-state write itself fails', async () => {
  // The swallow bug: persistAiRetryState's .catch always resolved, so
  // armAiRetry appeared to succeed even when repository.setMeta genuinely
  // rejected — letting clearPendingAiTrigger wipe the only durable marker with
  // nothing having actually landed on disk. armAiRetry must now know the write
  // failed and skip clearing the pending-trigger marker, so a relaunch inside
  // the backoff window still has a durable trace to retry from.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const setMetaSpy = jest
    .spyOn(fakeRepo.repository, 'setMeta')
    .mockImplementation(async (key, value) => {
      if (key === 'ai_suggestion_retry') {
        throw new Error('disk full');
      }
      return originalSetMeta(key, value);
    });

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('network died mid-request');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());

  // Let the in-flight attempt settle (it fails, armAiRetry's write rejects).
  await waitFor(() => expect(store.current!.isEnriching(SYNCED_ID)).toBe(false));

  // The retry-state write never landed...
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
  // ...so the pending-trigger marker must NOT have been cleared either —
  // otherwise this failed attempt would vanish with no durable trace for a
  // relaunch inside the backoff window to retry.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));

  setMetaSpy.mockRestore();
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
      suggested_collection_name: null,
      model: 'dummy-v0',
      status: 'complete',
      confidence: null,
      degraded: false,
      degraded_reason: null,
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
  // A default (manual) request also flags the manual-only state that drives the
  // explicit "Generating…" button feedback.
  expect(store.current!.isManuallyEnriching(SYNCED_ID)).toBe(true);

  await act(async () => {
    release();
    await pending;
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(false);
  expect(store.current!.isManuallyEnriching(SYNCED_ID)).toBe(false);
});

test("an 'auto' enrichment is in flight but not flagged as manual", async () => {
  const store = await renderReady();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => {
    await gate;
    return {
      id: 'enrichment-auto',
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
  });

  let pending: Promise<string | null>;
  await act(async () => {
    pending = store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  // The ambient placeholder still shows (isEnriching), but the section never
  // looks like a blocking wait the user must sit through (not manual).
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(true);
  expect(store.current!.isManuallyEnriching(SYNCED_ID)).toBe(false);

  await act(async () => {
    release();
    await pending;
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(false);
  expect(store.current!.isManuallyEnriching(SYNCED_ID)).toBe(false);
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

test('accepting a suggestion records it as reviewed and persists it durably', async () => {
  const store = await renderReady();
  expect(store.current!.getReviewedSuggestions(SYNCED_ID).size).toBe(0);

  await act(async () => {
    await store.current!.acceptSuggestedTags(SYNCED_ID, [{ name: 'design', confidence: 0.8 }]);
  });

  expect(store.current!.getReviewedSuggestions(SYNCED_ID).has('design')).toBe(true);
  // Persisted so the decision survives a relaunch.
  expect(fakeRepo.__bookmarks().find((b) => b.id === SYNCED_ID)?.dismissed_suggested_tags).toContain('design');
});

test('the badge stays gone after accepting then removing a suggested tag', async () => {
  // The reported bug: accept a suggestion (tag applied), then remove it — the
  // "✨" badge used to reappear because the suggestion was no longer *applied*.
  // Now an accepted suggestion is *reviewed*, so it stays out of the pending set.
  const store = await renderReady();

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });
  const enrichment = store.current!.getEnrichment(SYNCED_ID);
  // Before any review, the high-confidence suggestion is pending (badge shows).
  expect(pendingSuggestions(enrichment, new Set(), new Set()).map((s) => s.name)).toEqual([
    'design',
  ]);

  await act(async () => {
    await store.current!.acceptSuggestedTags(SYNCED_ID, [{ name: 'design', confidence: 0.8 }]);
  });
  await act(async () => {
    await store.current!.removeTagFromBookmark(SYNCED_ID, 'design');
  });

  // The tag is gone from the bookmark...
  expect(store.current!.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name)).not.toContain(
    'design',
  );
  // ...but it stays reviewed, so nothing is pending — the badge does not return.
  const applied = new Set(
    store.current!.getTagsForBookmark(SYNCED_ID).map((tag) => tag.name.toLowerCase()),
  );
  const reviewed = store.current!.getReviewedSuggestions(SYNCED_ID);
  expect(pendingSuggestions(enrichment, applied, reviewed)).toEqual([]);
});

test('markSuggestionsReviewed (dismiss path) persists across a remount', async () => {
  const store = await renderReady();

  await act(async () => {
    store.current!.markSuggestionsReviewed(SYNCED_ID, ['Video']);
  });
  expect(fakeRepo.__bookmarks().find((b) => b.id === SYNCED_ID)?.dismissed_suggested_tags).toContain('video');

  // Re-mount over the same persisted meta (simulating an app relaunch): the
  // reviewed names re-hydrate, so a dismissed suggestion never re-surfaces.
  const remounted = renderStore();
  await waitFor(() => expect(remounted.current?.isLoading).toBe(false));
  await waitFor(() => expect(remounted.current!.getReviewedSuggestions(SYNCED_ID).has('video')));
  expect(remounted.current!.getReviewedSuggestions(SYNCED_ID).has('video')).toBe(true);
});

test('clearReviewedSuggestions forgets dismissals so a manual re-run can reconsider', async () => {
  const store = await renderReady();

  await act(async () => {
    store.current!.markSuggestionsReviewed(SYNCED_ID, ['design', 'video']);
  });
  expect(store.current!.getReviewedSuggestions(SYNCED_ID).size).toBe(2);

  await act(async () => {
    store.current!.clearReviewedSuggestions(SYNCED_ID);
  });

  expect(store.current!.getReviewedSuggestions(SYNCED_ID).size).toBe(0);
  // Persisted, so the cleared state survives a relaunch too.
  await waitFor(() => expect(fakeRepo.__bookmarks().find((b) => b.id === SYNCED_ID)?.dismissed_suggested_tags?.length).toBe(0));
});

test('a background auto enrichment flags the bookmark as an unseen suggestion', async () => {
  const store = await renderReady();
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);

  // The deferred post-capture trigger fires with source 'auto' — the user isn't
  // looking at this bookmark, so its new suggestion drives the Inbox banner.
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(true);
  // Persisted so a suggestion that landed in an abandoned session re-announces.
  expect(fakeRepo.__meta('unseen_ai_suggestions')).toContain(SYNCED_ID);
});

test('a folder-only auto enrichment (no tags) still flags the bookmark as unseen', async () => {
  // The model proposed a folder but no high-confidence tags. That's reviewable
  // on the Review screen, so an unwitnessed arrival must still raise the banner.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-folder',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'Generated summary',
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: 'Travel',
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = await renderReady();
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(true);
});

test('a summary-only auto enrichment (no tags, no folder) still flags the bookmark as unseen', async () => {
  // The model proposed only a summary — no tags, no folder hint. That's
  // reviewable on the Review screen (as a proposed note), so an unwitnessed
  // arrival must still raise the banner, not just tag/folder arrivals.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-summary-only',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'A concise overview of the article.',
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'gemini-2.0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));

  const store = await renderReady();
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(true);
});

test('a manual enrichment is witnessed, so it is never flagged as unseen', async () => {
  const store = await renderReady();

  // A manual "Suggest with AI" tap happens on the Detail screen — the user is
  // already looking — so it must not surface the Inbox "new suggestions" banner.
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);
});

test('markSuggestionsSeen and clearUnseenSuggestions clear the unseen flag', async () => {
  const store = await renderReady();
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(true);

  // Opening the bookmark's Detail witnesses the suggestion.
  await act(async () => {
    store.current!.markSuggestionsSeen(SYNCED_ID);
  });
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('unseen_ai_suggestions')).toBe('[]');

  // Re-flag, then clear all at once (the Review screen does this on entry).
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.unseenSuggestionIds.size).toBe(1);
  await act(async () => {
    store.current!.clearUnseenSuggestions();
  });
  expect(store.current!.unseenSuggestionIds.size).toBe(0);
});

test('a pull that refreshes an existing enrichment (same id, newer timestamp) re-flags it', async () => {
  // Another device re-runs AI suggestions: the edge function upserts on
  // bookmark_id and keeps the same enrichment id, so gating on a brand-new id
  // would miss the changed suggestions. The pull compares updated_at instead.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID })],
    undefined,
    [
      makeEnrichment({
        id: 'enrich-1',
        bookmark_id: SYNCED_ID,
        updated_at: '2026-06-13T00:00:00.000Z',
        suggested_tags: [{ name: 'design', confidence: 0.8 }],
      }),
    ],
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  // The initial pull carried no updated enrichments, so nothing is flagged: the
  // seeded row was a bulk load, not a fresh arrival.
  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(false);

  // A later pull brings the same enrichment id back with a newer timestamp.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({
      id: 'enrich-1',
      bookmark_id: SYNCED_ID,
      updated_at: '2026-06-20T00:00:00.000Z',
      suggested_tags: [{ name: 'design', confidence: 0.8 }],
    }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  expect(store.current!.unseenSuggestionIds.has(SYNCED_ID)).toBe(true);
});

// --- AI-suggestion retry bookkeeping (postponed state + backoff) ---

/** A minimal, valid AIEnrichment success response for retry tests. */
function makeSuccessEnrichment(bookmarkId: string) {
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

test('a failed auto attempt arms the AI-suggestion retry marker', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('network down');
  });

  let error: string | null = 'unset';
  await act(async () => {
    error = await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  expect(error).not.toBeNull();
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(true);
  const persisted = JSON.parse(fakeRepo.__meta('ai_suggestion_retry') ?? '{}');
  expect(persisted[SYNCED_ID].attemptCount).toBe(1);
});

test('a failed manual attempt arms the same retry marker as an auto failure', async () => {
  // Unifying failure handling: a manual "Suggest with AI" tap that fails must
  // arm the same bookkeeping as a failed auto-trigger, not just log an error.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('server exploded');
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID); // default source: 'manual'
  });

  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
  const persisted = JSON.parse(fakeRepo.__meta('ai_suggestion_retry') ?? '{}');
  expect(persisted[SYNCED_ID].attemptCount).toBe(1);
});

test("a rehomed bookmark still fires a fresh auto AI trigger under its new id, even though its old id already fired this session", async () => {
  // Regression for the aiTriggerAttempted-carry-forward bug: aiTriggerAttempted
  // is a session-only in-memory "already fired" dedupe set. The bug carried it
  // forward across the rehome id swap, so a bookmark whose OLD id had already
  // fired once this session silently never got its fresh auto-trigger fired
  // again under its NEW (rehomed) id — denying AI suggestions until an app
  // restart. This proves the actual behavior (a fresh requestEnrichment call
  // for the new id) fires, not just that the bookkeeping key moved.
  const ANON_REMOTE_ID = '3c3c3c3c-0000-4000-8000-000000000003';
  fakeRepo.__reset([makeStoredBookmark({ id: ANON_REMOTE_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ANON_REMOTE_ID]));
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ANON_REMOTE_ID]);

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());

  // During the anonymous session, the deferred-trigger effect fires the
  // bookmark's first-ever auto attempt for ANON_REMOTE_ID — marking it
  // "already attempted this session", the exact in-memory state the bug used
  // to carry forward onto the rehomed id.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      ANON_REMOTE_ID,
      expect.anything(),
      'en',
    ),
  );

  // Sign in to a different (real) account: the anon bookmark carries over,
  // re-homed onto a fresh id.
  const realUser: { id: string; is_anonymous?: boolean } = {
    id: 'real-user',
    is_anonymous: false,
  };
  mockAuthSession = { ...mockSession, user: realUser };
  await act(async () => {
    rerender(undefined);
  });

  let rehomedId = '';
  await waitFor(() => {
    const row = result.current.inbox.find((b) => b.id !== ANON_REMOTE_ID);
    expect(row).toBeDefined();
    rehomedId = row!.id;
  });

  // The bug would have carried ANON_REMOTE_ID's "already fired" flag all the
  // way onto the rehomed id, so the deferred-trigger effect would silently
  // skip firing for it. The fix drops the flag at the swap instead of moving
  // it, so a fresh auto trigger actually fires for the bookmark's new identity.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      rehomedId,
      expect.anything(),
      'en',
    ),
  );
});

test('a successful attempt clears an armed retry marker', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('transient failure');
  });
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBe('{}');
});

test('hadPriorEnrichmentAttempt stays true through a retry\'s in-flight window, unlike isAiSuggestionPostponed', async () => {
  // Design intent: the Detail screen suppresses its first-attempt-only loading
  // shimmer for every automatic retry. isAiSuggestionPostponed goes false the
  // instant a retry starts (it's no longer "waiting"), but
  // hadPriorEnrichmentAttempt must stay true across the whole in-flight
  // window so the caller can compute `isEnriching && !hadPriorEnrichmentAttempt`
  // and get false throughout a retry.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('first attempt fails');
  });
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(true);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => {
    await gate;
    return makeSuccessEnrichment(bookmarkId);
  });

  let pending!: Promise<string | null>;
  await act(async () => {
    pending = store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(true);
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(true);

  await act(async () => {
    release();
    await pending;
  });
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
});

test('a too-soon retry check does not fire before the backoff has elapsed', async () => {
  // Seed a just-failed attempt (attempt 1 needs >= 2min before attempt 2).
  const now = new Date().toISOString();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({ [SYNCED_ID]: { firstAttemptAt: now, lastAttemptAt: now, attemptCount: 1 } }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  // The cold-launch check itself must not fire either (same backoff gate).
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  await act(async () => {
    fireForeground();
    await Promise.resolve();
  });

  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
});

test('a foreground transition retries once the backoff has elapsed', async () => {
  const now = new Date().toISOString();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({ [SYNCED_ID]: { firstAttemptAt: now, lastAttemptAt: now, attemptCount: 1 } }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  // Move the clock forward past the 2-minute backoff for attempt 2, without
  // touching real timers (so waitFor/act keep working normally).
  const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
  try {
    await act(async () => {
      fireForeground();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
        SYNCED_ID,
        expect.anything(),
        'en',
      ),
    );
    await waitFor(() => expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined());
    expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  } finally {
    dateNowSpy.mockRestore();
  }
});

test('the retry cap (6 attempts) clears bookkeeping and the bookmark reverts to looking never-asked', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementation(async () => {
    throw new Error('always fails');
  });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await act(async () => {
      await store.current!.requestAiEnrichment(SYNCED_ID, attempt === 1 ? 'auto' : 'manual');
    });
  }

  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBe('{}');
});

test('trashing a bookmark while its AI request is in flight does not re-arm the retry marker once it fails', async () => {
  // A request can already be in flight when the user trashes its bookmark.
  // trashBookmark clears any EXISTING retry marker synchronously, but that
  // can't stop the in-flight request's own failure handler from re-arming one
  // afterward — which would resurrect retry eligibility for content the user
  // just discarded.
  const store = await renderReady();

  let reject!: (error: unknown) => void;
  const gate = new Promise((_resolve, r) => {
    reject = r;
  });
  gate.catch(() => {}); // silence the unhandled-rejection warning from the gate itself
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await gate;
    throw new Error('network died after trash');
  });

  let pending!: Promise<string | null>;
  await act(async () => {
    pending = store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(true);

  // The user trashes the bookmark while the request is still in flight.
  await act(async () => {
    store.current!.trashBookmark(SYNCED_ID);
  });
  expect(store.current!.getBookmark(SYNCED_ID)?.deleted_at).not.toBeNull();

  // The in-flight request now settles as a failure.
  await act(async () => {
    reject(new Error('network died after trash'));
    await pending;
  });

  // No retry marker was (re-)armed for a bookmark the user already discarded.
  // (armAiRetry declined to write anything at all, so the meta key was never
  // even persisted — distinct from an armed-then-cleared '{}'.)
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
});

test('permanently deleting a bookmark while its AI request is in flight does not re-arm the retry marker once it fails', async () => {
  const store = await renderReady();

  let reject!: (error: unknown) => void;
  const gate = new Promise((_resolve, r) => {
    reject = r;
  });
  gate.catch(() => {});
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await gate;
    throw new Error('network died after delete');
  });

  let pending!: Promise<string | null>;
  await act(async () => {
    pending = store.current!.requestAiEnrichment(SYNCED_ID, 'auto');
  });

  await act(async () => {
    store.current!.deleteBookmark(SYNCED_ID);
  });
  expect(store.current!.getBookmark(SYNCED_ID)).toBeUndefined();

  await act(async () => {
    reject(new Error('network died after delete'));
    await pending;
  });

  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
});

test('an anon→real carried-over bookmark keeps its retry marker through the rehome id swap', async () => {
  // The rehome swap (anon id → new id) must re-key the retry marker onto the
  // new id — a bookmark's id is otherwise stable for life once captured (see
  // makeBookmarkId), so rehoming is the only id swap this bookmark ever goes
  // through.
  const ANON_REMOTE_ID = '2b2b2b2b-0000-4000-8000-000000000002';
  fakeRepo.__reset([makeStoredBookmark({ id: ANON_REMOTE_ID, sync_status: 'synced' })]);
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({
      [ANON_REMOTE_ID]: {
        firstAttemptAt: '2026-06-01T00:00:00.000Z',
        lastAttemptAt: '2026-06-01T00:00:00.000Z',
        attemptCount: 1,
      },
    }),
  );
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ANON_REMOTE_ID]);

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());
  expect(result.current.isAiSuggestionPostponed(ANON_REMOTE_ID)).toBe(true);

  // Sign in to a different (real) account: the anon bookmark carries over,
  // re-homed onto a fresh id.
  const realUser: { id: string; is_anonymous?: boolean } = {
    id: 'real-user',
    is_anonymous: false,
  };
  mockAuthSession = { ...mockSession, user: realUser };
  await act(async () => {
    rerender(undefined);
  });

  let rehomedId = '';
  await waitFor(() => {
    const row = result.current.inbox.find((b) => b.id !== ANON_REMOTE_ID);
    expect(row).toBeDefined();
    rehomedId = row!.id;
  });

  // The retry marker followed the rehome swap onto the new id.
  expect(result.current.isAiSuggestionPostponed(rehomedId)).toBe(true);
  expect(result.current.isAiSuggestionPostponed(ANON_REMOTE_ID)).toBe(false);
});

test('a relaunch inside the backoff window does not bypass backoff via the deferred first-trigger effect', async () => {
  // Regression: the crash-safety fix kept `pending_ai_trigger` present until
  // the request SUCCEEDED — so a failure left it present too. A relaunch
  // before the backoff window elapsed would rehydrate it and the deferred
  // first-trigger effect fired `requestAiEnrichment` again immediately, with
  // no backoff check at all.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('first attempt fails');
  });

  // First "launch": the deferred trigger fires the bookmark's first-ever
  // attempt, which fails.
  const first = renderStore();
  await waitFor(() => expect(first.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(first.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true));
  // The crash-safety marker's job is done now that the failure is durably
  // recorded — it must be cleared so a relaunch doesn't rehydrate it.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]');

  // Simulate a relaunch (a fresh store instance reading the same durable
  // storage) that happens well within the 2-minute backoff window.
  const second = renderStore();
  await waitFor(() => expect(second.current?.isLoading).toBe(false));
  await waitFor(() => expect(second.current?.lastPulledAt).not.toBeNull());

  // No immediate re-fire: the backoff-respecting cold-launch check is the
  // only thing that could fire here, and the window hasn't elapsed.
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);
  expect(second.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
});

test('a pull that brings down an enrichment from another path (server trigger / another device) clears the retry marker', async () => {
  // An enrichment can arrive without this device's own requestAiEnrichment
  // call ever succeeding — a server-side trigger, or another device. Once the
  // bookmark actually has suggestions, an armed retry marker from an earlier
  // failed attempt on THIS device is stale and must not keep firing redundant
  // requests.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({
      [SYNCED_ID]: {
        firstAttemptAt: '2026-06-01T00:00:00.000Z',
        lastAttemptAt: '2026-06-01T00:00:00.000Z',
        attemptCount: 1,
      },
    }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);

  // Another device's (or the server trigger's) enrichment arrives via pull.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-from-elsewhere', bookmark_id: SYNCED_ID }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined());
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);
  expect(store.current!.hadPriorEnrichmentAttempt(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBe('{}');
});

test('a pull that delivers a real enrichment clears the confirmed server-queued marker (STASH #578 follow-up)', async () => {
  // The background overflow worker's delivered result lands via the ordinary
  // sync pull — the PRIMARY way this marker is expected to clear in
  // practice. Answers "could this get stuck showing queued forever?": no.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify([SYNCED_ID]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);

  // The background overflow worker's result arrives via pull.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-from-queue-worker', bookmark_id: SYNCED_ID }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined());
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false);
  expect(fakeRepo.__meta('ai_server_queued')).toBe('[]');
});

test('a pull that re-delivers the same already-known enrichment (watermark overlap) does not clear a legitimately armed retry marker', async () => {
  // A bookmark already has a known (possibly stale) enrichment. Separately, a
  // *refresh* attempt on it fails and arms a retry marker. The pull's
  // watermark has a ~5-minute overlap window, so an ordinary later pull can
  // re-return that same unchanged enrichment row (same id, same updated_at) —
  // not a genuinely new or newer one. That re-delivery must NOT clear the
  // retry marker: nothing new actually arrived, and the scheduled retry is
  // still legitimate.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID })],
    undefined,
    [
      makeEnrichment({
        id: 'enrich-1',
        bookmark_id: SYNCED_ID,
        updated_at: '2026-06-13T00:00:00.000Z',
      }),
    ],
  );
  // lastAttemptAt is "just now" (not some fixed past date) so the app's own
  // backoff-scheduled retry checker (cold-launch checkAiRetries) sees the
  // 2-minute backoff for attemptCount 1 as NOT yet elapsed and stays inert —
  // isolating this test to the pull-merge behavior instead of also racing a
  // second, legitimate auto-retry that would independently bump attemptCount.
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({
      [SYNCED_ID]: {
        firstAttemptAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
        attemptCount: 1,
      },
    }),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);

  // An ordinary pull re-delivers the exact same (unchanged) enrichment row —
  // same id, same updated_at — inside the watermark's overlap window.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({
      id: 'enrich-1',
      bookmark_id: SYNCED_ID,
      updated_at: '2026-06-13T00:00:00.000Z',
    }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true);
  const persisted = JSON.parse(fakeRepo.__meta('ai_suggestion_retry') ?? '{}');
  expect(persisted[SYNCED_ID].attemptCount).toBe(1);
});

// STASH #578 Phase 2: the background overflow worker delivers its results
// through the ordinary sync pull (no new polling/realtime), so a pull that
// brings down 2+ enrichments this device never itself requested should feed
// the same "N bookmarks summarized & tagged" burst-completion toast that a
// burst of direct auto-dispatches already triggers (STASH #574 Phase 1).
const SECOND_SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000002';

test('a sync pull delivering 2+ worker-driven enrichments feeds the burst-completion toast', async () => {
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID }),
  ]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();

  // Neither enrichment came from this device's own direct dispatch (no
  // requestAiEnrichment call happened for either id) — exactly how the
  // background worker's output arrives.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-worker-1', bookmark_id: SYNCED_ID }),
    makeEnrichment({ id: 'enrich-worker-2', bookmark_id: SECOND_SYNCED_ID }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined());
  expect(store.current!.aiEnrichmentBurstToast).not.toBeNull();
  expect(store.current!.aiEnrichmentBurstToast?.count).toBe(2);
});

test('a sync pull delivering only 1 worker-driven enrichment stays silent (below the burst threshold)', async () => {
  const store = await renderReady();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-worker-solo', bookmark_id: SYNCED_ID }),
  ]);

  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SYNCED_ID)).toBeDefined());
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();
});

test('a pull re-delivering an already-known enrichment (watermark overlap) does not double count toward the burst toast', async () => {
  // Same watermark-overlap scenario as the retry-marker test above: an
  // unchanged, already-known row must not count as "new" a second time and
  // spuriously push a lone re-delivery over the burst threshold.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID }), makeStoredBookmark({ id: SECOND_SYNCED_ID })],
    undefined,
    [makeEnrichment({ id: 'enrich-known', bookmark_id: SYNCED_ID, updated_at: '2026-06-13T00:00:00.000Z' })],
  );
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // The pull re-returns the SAME already-known row (unchanged) alongside one
  // genuinely new one — only the new one should count, leaving the total (1)
  // below the burst threshold.
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-known', bookmark_id: SYNCED_ID, updated_at: '2026-06-13T00:00:00.000Z' }),
    makeEnrichment({ id: 'enrich-worker-new', bookmark_id: SECOND_SYNCED_ID }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SECOND_SYNCED_ID)).toBeDefined());
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();
});

test('an enrichment pulled while this device has a direct dispatch in flight for it is not double-counted toward the burst toast', async () => {
  // If this device's own direct-dispatch request for SYNCED_ID is still in
  // flight when a pull happens to observe its (not-yet-locally-known) row,
  // that arrival is attributable to the in-flight direct dispatch, not the
  // background worker — it must not also count here (the direct-dispatch
  // settle handler owns counting it, once its own request resolves).
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID }),
  ]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  // Hold the direct requestAiEnrichment call open on a manually-resolved
  // promise (never a bare `new Promise(() => {})`, so this test can settle it
  // itself before finishing rather than leaking a permanently-pending
  // promise) so `aiEnriching` still marks SYNCED_ID as in flight when the pull
  // below runs.
  let releaseDirectRequest!: (value: unknown) => void;
  apiMock.__spies.requestEnrichment.mockImplementationOnce(
    () => new Promise((resolve) => { releaseDirectRequest = resolve; }),
  );
  let inFlight!: Promise<string | null>;
  await act(async () => {
    inFlight = store.current!.requestAiEnrichment(SYNCED_ID);
  });
  expect(store.current!.isEnriching(SYNCED_ID)).toBe(true);

  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
    makeEnrichment({ id: 'enrich-inflight', bookmark_id: SYNCED_ID }),
    makeEnrichment({ id: 'enrich-worker-only', bookmark_id: SECOND_SYNCED_ID }),
  ]);
  await act(async () => {
    await store.current!.syncNow();
  });

  await waitFor(() => expect(store.current!.getEnrichment(SECOND_SYNCED_ID)).toBeDefined());
  // Only SECOND_SYNCED_ID's arrival is attributable to the worker — 1 total,
  // below the burst threshold.
  expect(store.current!.aiEnrichmentBurstToast).toBeNull();

  // Let the held-open direct request settle so nothing leaks into other tests.
  await act(async () => {
    releaseDirectRequest(makeEnrichment({ id: 'enrich-direct-settled', bookmark_id: SYNCED_ID }));
    await inFlight;
  });
});
