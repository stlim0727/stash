import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { Bookmark, MetadataStatus } from '@/domain/types';

const mockEnrichBookmark = jest.fn<
  Promise<{ patch: Partial<Bookmark>; metadata_status: MetadataStatus }>,
  [Bookmark, unknown?]
>(async () => ({ patch: {}, metadata_status: 'complete' }));
const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: (bookmark: Bookmark, fetcher?: unknown) => mockEnrichBookmark(bookmark, fetcher),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';
import { clearLogEntries, getLogEntries } from '@/observability/log-buffer';
import { PENDING_IMPORT_COLLECTIONS_KEY } from '@/domain/pending-import-collections';

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
  mockEnrichBookmark.mockReset();
  mockEnrichBookmark.mockResolvedValue({ patch: {}, metadata_status: 'complete' });
});

test('addBookmark shows the bookmark immediately and queues a create', async () => {
  const { result } = await renderStore();

  let outcome = '';
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'example.com/article' }).status;
  });

  expect(outcome).toBe('created');
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  expect(result.current.inbox[0]?.url).toBe('https://example.com/article');
  expect(result.current.inbox[0]?.sync_status).toBe('pending');
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  expect(fakeRepo.__queue()[0]?.operation).toBe('create');
});

test('markBookmarkAccessed sets last_accessed_at and persists it durably', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: 'bm-access', last_accessed_at: null })]);
  const { result } = await renderStore();
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  await act(async () => {
    result.current.markBookmarkAccessed('bm-access');
  });

  // Reflected in memory…
  expect(result.current.inbox[0]?.last_accessed_at).toEqual(expect.any(String));
  // …and written through to durable storage (not just the in-memory state),
  // so the "Recently opened" order survives a reload.
  const persisted = (await fakeRepo.repository.listBookmarks()).find((b) => b.id === 'bm-access');
  expect(persisted?.last_accessed_at).toEqual(expect.any(String));

  // It must not enqueue a sync mutation — last_accessed_at is local-only.
  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('saving the same URL twice reuses the existing bookmark', async () => {
  const { result } = await renderStore();

  await act(async () => {
    result.current.addBookmark({ url: 'example.com/a' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({ url: 'https://example.com/a' }).status;
  });

  expect(status).toBe('duplicate');
  expect(result.current.inbox).toHaveLength(1);
});

test('re-sharing a YouTube URL dedupes against a stored row with a stale si hash', async () => {
  // Simulates a local row saved by an older build, before `si` was stripped:
  // its persisted url_hash still carries the old share token and hasn't been
  // rewritten by pull sync yet. A fresh re-share (different si) must still
  // dedupe against it instead of creating a duplicate.
  fakeRepo.__reset([
    makeStoredBookmark({
      url: 'https://youtube.com/shorts/gkx8ZfytWeE?si=OLDtoken',
      url_hash: 'https://youtube.com/shorts/gkx8ZfytWeE?si=OLDtoken',
    }),
  ]);
  const { result } = await renderStore();
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({
      url: 'https://youtube.com/shorts/gkx8ZfytWeE?si=NEWtoken',
    }).status;
  });

  expect(status).toBe('duplicate');
  expect(result.current.inbox).toHaveLength(1);
});

test('invalid input is rejected with a message and saves nothing', async () => {
  const { result } = await renderStore();

  let outcome: ReturnType<typeof result.current.addBookmark> | null = null;
  await act(async () => {
    outcome = result.current.addBookmark({ url: 'not a url' });
  });

  expect(outcome).toMatchObject({ status: 'invalid' });
  expect(result.current.inbox).toHaveLength(0);
});

test('a URL too long to save is rejected up front instead of queuing a create that can never succeed', async () => {
  // Sentry STASH-2J: an Oracle email-verification link's huge embedded token
  // blew Postgres's index row-size limit on every retry, forever. Reject
  // before it ever reaches the queue.
  const { result } = await renderStore();
  const huge = `https://login.oracle.com/verify?token=${'x'.repeat(2800)}`;

  let outcome: ReturnType<typeof result.current.addBookmark> | null = null;
  await act(async () => {
    outcome = result.current.addBookmark({ url: huge });
  });

  expect(outcome).toMatchObject({ status: 'invalid', reason: 'too_long' });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.queue).toHaveLength(0);
});

test('a permanently-too-long-URL entry stays in the queue (not removed) so startup orphan reconciliation never rebuilds a fresh doomed create (Sentry STASH-2J)', async () => {
  // Reproduces an entry queued on a pre-fix build: last_error already carries
  // the exact Postgres message from its last failed attempt, and the bookmark
  // itself is still sync_status:'failed' (syncQueueEntry marks both). isSyncable
  // excludes the entry from retries, but if it were REMOVED from the queue
  // entirely, reconcileOrphanedQueueEntries would treat the still-failed
  // bookmark as a stranded orphan on the next cold start and rebuild a fresh
  // create for the same doomed URL (caught in PR review) — so the entry must
  // stay in the queue (its mere presence is what suppresses re-creation),
  // just excluded from being retried and from any "waiting" count.
  const stuckUrl = 'https://login.oracle.com/verify?token=x';
  fakeRepo.__reset([makeStoredBookmark({ id: 'local-stuck', url: stuckUrl, sync_status: 'failed' })]);
  await fakeRepo.repository.enqueue({
    local_id: 'local-stuck',
    remote_id: null,
    operation: 'create',
    payload: { url: stuckUrl },
    sync_status: 'failed',
    retry_count: 3,
    last_error:
      'index row size 2888 exceeds btree version 4 maximum 2704 for index "bookmarks_user_url_hash_active_idx"',
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
  });

  const { result } = await renderStore();

  // Still exactly one queue entry, still failed with its original error — not
  // duplicated, not reset to a fresh 'pending' create by orphan reconciliation.
  expect(result.current.queue).toHaveLength(1);
  expect(result.current.queue[0]).toMatchObject({
    local_id: 'local-stuck',
    sync_status: 'failed',
    last_error: expect.stringContaining('exceeds btree version'),
  });
});

test('trashing moves a bookmark from inbox to trash and back', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/b' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.trashBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.trash).toHaveLength(1);

  await act(async () => {
    result.current.restoreBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.trash).toHaveLength(0);
});

test('re-adding a trashed URL creates a fresh active bookmark instead of folding into the trashed row', async () => {
  // A trashed row must not count as "already in stash": local dedupe only
  // matches active rows, so re-saving revives the URL as a new inbox item
  // rather than silently bumping the hidden trashed one.
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/revive' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.trashBookmark(id);
  });
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.trash).toHaveLength(1);

  let status = '';
  await act(async () => {
    status = result.current.addBookmark({ url: 'https://example.com/revive' }).status;
  });

  expect(status).toBe('created');
  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.trash).toHaveLength(1);
});

test('deleting a local bookmark also clears its queued upload', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/c' });
  });
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.deleteBookmark(id);
  });

  expect(result.current.inbox).toHaveLength(0);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
});

test('updateBookmarkFields edits the title and clears it back to null', async () => {
  const { result } = await renderStore();
  await act(async () => {
    result.current.addBookmark({ url: 'example.com/d', title: 'Original' });
  });
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));
  const id = result.current.inbox[0]!.id;

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: 'Renamed', notes: 'a note' });
  });
  expect(result.current.inbox[0]).toMatchObject({ title: 'Renamed', notes: 'a note' });

  await act(async () => {
    result.current.updateBookmarkFields(id, { title: '' });
  });
  expect(result.current.inbox[0]?.title).toBeNull();
});

test('editing title/notes marks a complete enrichment stale (locally + persisted)', async () => {
  const {
    makeStoredBookmark,
    makeEnrichment,
  } = require('./helpers/fake-repository');
  const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'Original title' })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, status: 'complete' })],
  );

  const { result } = await renderStore();
  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('complete');

  await act(async () => {
    result.current.updateBookmarkFields(SYNCED_ID, { title: 'A new title' });
  });

  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('stale');
  await waitFor(() =>
    expect(fakeRepo.repository.listEnrichments()).resolves.toEqual([
      expect.objectContaining({ bookmark_id: SYNCED_ID, status: 'stale' }),
    ]),
  );
});

test('refreshBookmarkPreview replaces generated preview metadata and queues sync', async () => {
  const id = SYNCED_ID;
  fakeRepo.__reset([
    makeStoredBookmark({
      id,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'YouTube video',
      title_is_derived: true,
      site_name: 'youtu.be',
      favicon_url: 'https://youtu.be/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    }),
  ]);
  mockEnrichBookmark.mockResolvedValueOnce({
    patch: {
      title: 'Rick Astley - Never Gonna Give You Up',
      title_is_derived: false,
      site_name: 'YouTube',
      favicon_url: 'https://www.youtube.com/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    },
    metadata_status: 'complete',
  });
  const { result } = await renderStore();

  await act(async () => {
    await result.current.refreshBookmarkPreview(id);
  });

  await waitFor(() =>
    expect(result.current.getBookmark(id)).toMatchObject({
      title: 'Rick Astley - Never Gonna Give You Up',
      title_is_derived: false,
      site_name: 'YouTube',
      favicon_url: 'https://www.youtube.com/favicon.ico',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
      sync_status: 'pending',
    }),
  );
  expect(mockEnrichBookmark).toHaveBeenCalledWith(
    expect.objectContaining({
      id,
      title: null,
      site_name: null,
      favicon_url: null,
      preview_image_url: null,
    }),
    undefined,
  );
  await waitFor(() => expect(fakeRepo.__queue()).toEqual([expect.objectContaining({ local_id: id, operation: 'update' })]));
});

test('refreshBookmarkPreview keeps a user-authored title while refreshing generated fields', async () => {
  const id = SYNCED_ID;
  fakeRepo.__reset([
    makeStoredBookmark({
      id,
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'My title',
      title_is_derived: false,
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    }),
  ]);
  mockEnrichBookmark.mockResolvedValueOnce({
    patch: {
      title: 'Fetched title should not win',
      title_is_derived: false,
      site_name: 'YouTube',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    },
    metadata_status: 'complete',
  });
  const { result } = await renderStore();

  await act(async () => {
    await result.current.refreshBookmarkPreview(id);
  });

  await waitFor(() =>
    expect(result.current.getBookmark(id)).toMatchObject({
      title: 'My title',
      title_is_derived: false,
      site_name: 'YouTube',
      preview_image_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg',
    }),
  );
});

test('a no-op edit (no real text change) does not mark the enrichment stale', async () => {
  const {
    makeStoredBookmark,
    makeEnrichment,
  } = require('./helpers/fake-repository');
  const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
  fakeRepo.__reset(
    [makeStoredBookmark({ id: SYNCED_ID, title: 'Unchanged' })],
    undefined,
    [makeEnrichment({ bookmark_id: SYNCED_ID, status: 'complete' })],
  );

  const { result } = await renderStore();

  await act(async () => {
    result.current.updateBookmarkFields(SYNCED_ID, { title: 'Unchanged' });
  });

  expect(result.current.getEnrichment(SYNCED_ID)?.status).toBe('complete');
});

test('bookmarks stored from a previous session load on startup', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([makeStoredBookmark({ title: 'From last session' })]);

  const { result } = await renderStore();

  expect(result.current.inbox).toHaveLength(1);
  expect(result.current.inbox[0]?.title).toBe('From last session');
});

test('a stranded pending bookmark with no queue entry is re-enqueued on startup', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  // A non-synced local-ID row whose create entry never persisted: without a
  // queue entry it would show "sync pending" forever.
  fakeRepo.__reset([
    makeStoredBookmark({ id: 'local-stranded', sync_status: 'pending', title: 'Stuck' }),
  ]);
  expect(fakeRepo.__queue()).toHaveLength(0);

  const { result } = await renderStore();

  expect(result.current.inbox).toHaveLength(1);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(1));
  expect(fakeRepo.__queue()[0]).toMatchObject({
    local_id: 'local-stranded',
    operation: 'create',
  });
});

test('multiple stranded bookmarks are re-enqueued sequentially, not as a concurrent burst (Sentry STASH-3N)', async () => {
  // The orphan re-enqueue used to fan out via Promise.all — on a device with
  // a large backlog (a big import that never fully synced before the app was
  // closed), that meant dozens of simultaneous native SQLite calls stacking
  // up on the single serialized connection: "sqlite tail wait" depth
  // reaching 40, multi-second stalls on every launch. Sequential now,
  // matching the STASH-3B precedent already used for bulk import.
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([
    makeStoredBookmark({ id: 'local-stranded-1', url: 'https://example.com/s1', sync_status: 'pending' }),
    makeStoredBookmark({ id: 'local-stranded-2', url: 'https://example.com/s2', sync_status: 'pending' }),
    makeStoredBookmark({ id: 'local-stranded-3', url: 'https://example.com/s3', sync_status: 'pending' }),
  ]);

  let concurrent = 0;
  let maxConcurrent = 0;
  const originalEnqueue = fakeRepo.repository.enqueue;
  fakeRepo.repository.enqueue = async (entry) => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 5));
    concurrent -= 1;
    return originalEnqueue(entry);
  };

  const { result } = await renderStore();
  expect(result.current.inbox).toHaveLength(3);
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(3));

  expect(maxConcurrent).toBe(1);
  fakeRepo.repository.enqueue = originalEnqueue;
});

test('a synced bookmark loaded on startup is not re-enqueued', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  fakeRepo.__reset([makeStoredBookmark({ sync_status: 'synced' })]);

  await renderStore();

  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('import: an enrichment finishing early never gets clobbered by the row\'s later durable insert (PR #594 review)', async () => {
  // The race: importBookmarks persists rows sequentially, but an enrichment
  // fetch that resolves before its row's insert lands would write the enriched
  // row first — and the later insertBookmark (INSERT OR REPLACE on native)
  // would replace it with the stale `metadata_status: 'pending'` snapshot,
  // stranding the row pending in storage until another startup pass. Instant
  // enrichment + artificially slow inserts make the pre-fix ordering lose
  // deterministically.
  const { result } = await renderStore();
  mockEnrichBookmark.mockImplementation(async (bookmark) => ({
    patch: { title: `Enriched ${bookmark.url}`, title_is_derived: false },
    metadata_status: 'complete',
  }));
  const realInsert = fakeRepo.repository.insertBookmark;
  jest.spyOn(fakeRepo.repository, 'insertBookmark').mockImplementation(async (bookmark) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return realInsert(bookmark);
  });

  await act(async () => {
    result.current.importBookmarks([
      { url: 'https://example.com/imported-1', title: null, notes: null, tags: [], collection: null },
      { url: 'https://example.com/imported-2', title: null, notes: null, tags: [], collection: null },
      { url: 'https://example.com/imported-3', title: null, notes: null, tags: [], collection: null },
    ]);
  });

  // Every imported row must end up durably enriched — no row may be left
  // persisted as 'pending' while React state says 'complete'.
  await waitFor(() => {
    const stored = fakeRepo.__bookmarks();
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row.metadata_status).toBe('complete');
      expect(row.title).toBe(`Enriched ${row.url}`);
    }
  });
});

test('import: tags and collection intent are written durably', async () => {
  const { result } = await renderStore();

  await act(async () => {
    result.current.importBookmarks([
      {
        source: 'stash-backup',
        url: 'https://example.com/organized',
        title: 'Organized',
        notes: null,
        tags: ['reading', 'research'],
        collection: 'Projects',
      },
    ]);
  });

  await waitFor(() => expect(fakeRepo.__bookmarks()).toHaveLength(1));
  const bookmarkId = fakeRepo.__bookmarks()[0]!.id;
  expect(
    result.current
      .getTagsForBookmark(bookmarkId)
      .map((tag) => tag.name)
      .sort(),
  ).toEqual(['reading', 'research']);
  expect(JSON.parse(fakeRepo.__meta('pending_tag_ops') ?? '[]')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ bookmark_id: bookmarkId, tag_name: 'reading' }),
      expect.objectContaining({ bookmark_id: bookmarkId, tag_name: 'research' }),
    ]),
  );
  expect(
    JSON.parse(fakeRepo.__meta(PENDING_IMPORT_COLLECTIONS_KEY) ?? '[]'),
  ).toEqual([
    expect.objectContaining({
      bookmark_id: bookmarkId,
      collection_name: 'Projects',
      status: 'pending',
    }),
  ]);
});

test('import: logs a start/finish summary (Sentry STASH-3K/3M instrumentation)', async () => {
  // STASH-3K and its repeat STASH-3M both reported a bulk HTML import doubling
  // the library (local total exactly 2x the cloud count) with no evidence of
  // why — recordLog here is what would let the next occurrence show whether
  // dedupe saw the existing library (seenKeys) and whether it actually caught
  // duplicates on a re-import, instead of guessing again blind.
  clearLogEntries();
  fakeRepo.__reset([makeStoredBookmark({ url: 'https://example.com/already-here' })]);
  const { result } = await renderStore();
  await waitFor(() => expect(result.current.inbox).toHaveLength(1));

  let summary: ReturnType<typeof result.current.importBookmarks> | null = null;
  await act(async () => {
    summary = result.current.importBookmarks([
      { url: 'https://example.com/already-here', title: null, notes: null, tags: [], collection: null },
      { url: 'https://example.com/new-one', title: null, notes: null, tags: [], collection: null },
    ]);
  });

  expect(summary).toEqual({ imported: 1, duplicates: 1, skipped: 0 });
  const messages = getLogEntries().map((entry) => entry.message);
  expect(messages).toContainEqual(
    expect.stringMatching(/^import: starting items=2 activeLocal=1 seenKeys=1$/),
  );
  expect(messages).toContainEqual(
    expect.stringMatching(/^import: finished items=2 imported=1 duplicates=1 skipped=0$/),
  );
  // Let the durable insert settle before the test ends — otherwise its
  // un-awaited write lands after the next test's own fakeRepo.__reset().
  await waitFor(() => expect(fakeRepo.__bookmarks()).toHaveLength(2));
});

test('import while the initial load is still in flight is refused instead of durably duplicating rows (Sentry STASH-3K/3M repro)', async () => {
  // Reproduces the reported "561 -> 1122" doubling directly: importBookmarks
  // dedupes against bookmarksRef.current, which is empty until the initial
  // load resolves. Gate that load (simulating the real-device SQLite latency
  // seen in production diagnostics) and call importBookmarks while it's still
  // in flight — before the fix, this durably created a second row for a URL
  // that already existed in storage even though it hadn't loaded into React
  // state yet.
  const ALREADY_STORED_URL = 'https://example.com/already-here';
  fakeRepo.__reset([makeStoredBookmark({ url: ALREADY_STORED_URL })]);

  const originalListBookmarks = fakeRepo.repository.listBookmarks;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  fakeRepo.repository.listBookmarks = () => gate.then(() => originalListBookmarks());

  const utils = await renderHook(() => useBookmarks(), { wrapper });
  expect(utils.result.current.isLoading).toBe(true);

  let summary: ReturnType<typeof utils.result.current.importBookmarks> | null = null;
  await act(async () => {
    summary = utils.result.current.importBookmarks([
      { url: ALREADY_STORED_URL, title: null, notes: null, tags: [], collection: null },
    ]);
  });

  expect(summary).toEqual({ imported: 0, duplicates: 0, skipped: 0, notReady: true });
  // Nothing was queued or durably written — the refusal is a true no-op, not
  // a deferred/silent retry.
  expect(fakeRepo.__queue()).toHaveLength(0);
  expect(fakeRepo.__bookmarks()).toHaveLength(1);

  releaseGate();
  fakeRepo.repository.listBookmarks = originalListBookmarks;
  await waitFor(() => expect(utils.result.current.isLoading).toBe(false));

  // Once loaded, importing the same URL now correctly dedupes.
  let secondSummary: ReturnType<typeof utils.result.current.importBookmarks> | null = null;
  await act(async () => {
    secondSummary = utils.result.current.importBookmarks([
      { url: ALREADY_STORED_URL, title: null, notes: null, tags: [], collection: null },
    ]);
  });
  expect(secondSummary).toEqual({ imported: 0, duplicates: 1, skipped: 0 });
  expect(fakeRepo.__bookmarks()).toHaveLength(1);
});

test('enriching a synced bookmark queues an update so metadata reaches the cloud', async () => {
  const { makeStoredBookmark } = require('./helpers/fake-repository');
  // A cloud-synced bookmark whose metadata has not been enriched yet.
  fakeRepo.__reset([makeStoredBookmark({ metadata_status: 'pending' })]);

  await renderStore();

  // The startup enrichment pass completes it and queues a metadata update.
  await waitFor(() => {
    const entry = fakeRepo.__queue().find((q) => q.operation === 'update');
    expect(entry).toBeTruthy();
  });
});
