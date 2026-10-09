import './helpers/ai-enrichment-harness';
import { BULK_CREATE_SYNC_CHUNK_SIZE } from '@/sync/sync-bookmarks';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


test('a bulk chunk failure with a row-specific permanent error isolates just the offending row', async () => {
  // A bulk request fails as a whole even when only ONE row in the chunk
  // actually has a problem (a legacy too-long URL trips Postgres's btree
  // index-row limit — see isRowSpecificPermanentSyncErrorText). Regression:
  // blindly copying that shared batch error text onto every entry in the
  // chunk made isPermanentlyUnsyncableUrl treat ALL of them as permanently
  // unsyncable, silently excluding the other, perfectly valid entry from
  // sync forever instead of isolating the real offender.
  const goodId = '7e64cf1e-0000-4000-8000-000000000101';
  const badId = '7e64cf1e-0000-4000-8000-000000000102';
  const rows = [
    makeStoredBookmark({
      id: goodId,
      url: 'https://example.com/good',
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
    makeStoredBookmark({
      id: badId,
      url: 'https://example.com/bad',
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
  ];
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
  apiMock.__spies.createBookmarks.mockRejectedValueOnce(
    new Error(
      'index row size 3000 exceeds btree version 4 maximum 2704 for index "bookmarks_url_hash_idx"',
    ),
  );
  apiMock.__spies.createBookmark
    .mockImplementationOnce(async (input: { id?: string }) => ({ bookmark_id: input.id }))
    .mockImplementationOnce(async () => {
      throw new Error(
        'index row size 3000 exceeds btree version 4 maximum 2704 for index "bookmarks_url_hash_idx"',
      );
    });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The good entry must sync via the per-entry fallback rather than get
  // stuck 'failed' with the batch's row-specific error attributed to it.
  await waitFor(() => expect(store.current!.getBookmark(goodId)?.sync_status).toBe('synced'));
  await waitFor(() =>
    expect(store.current!.queue.filter((entry) => entry.local_id === goodId)).toEqual([]),
  );

  // The genuinely bad entry fails on its own, individually-attributed
  // attempt — proving isolation actually happened rather than both entries
  // sharing one undifferentiated batch failure.
  await waitFor(() => expect(store.current!.getBookmark(badId)?.sync_status).toBe('failed'));
  const badQueueEntry = store.current!.queue.find((entry) => entry.local_id === badId);
  expect(badQueueEntry?.last_error).toContain('exceeds btree version');

  expect(apiMock.__spies.createBookmark).toHaveBeenCalledTimes(2);
});

test('a bulk create success with no matching local bookmark still durably clears its queue entry', async () => {
  // A create's queue entry can outlive its own bookmark if the bookmark's
  // durable write failed independently (or was never persisted) —
  // syncCreateQueueEntryBatch still returns a completed result for it (no
  // bookmarkUpdate, since there's no local row to merge onto), but
  // applyBulkCreateChunkResults used to only durably clear queue rows that
  // had a bookmark completion alongside them, silently orphaning this entry
  // so it lingers forever and gets re-uploaded after every restart.
  fakeRepo.__reset([]);
  const orphanIdA = '7e64cf1e-0000-4000-8000-000000000201';
  const orphanIdB = '7e64cf1e-0000-4000-8000-000000000202';
  const now = '2026-06-12T00:00:00.000Z';
  for (const id of [orphanIdA, orphanIdB]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/orphan-${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() => expect(apiMock.__spies.createBookmarks).toHaveBeenCalled());
  await waitFor(() => expect(fakeRepo.__queue()).toHaveLength(0));
  expect(store.current!.queue).toHaveLength(0);
});

test('a bookmark permanently deleted while its bulk-create durable persist is still in flight is not resurrected', async () => {
  // applyBulkCreateChunkResults computes its in-memory merge from a snapshot
  // taken before completeCreateSyncBatch's own await. Regression: blindly
  // writing that stale snapshot back once the await resolved would resurrect
  // a bookmark permanently deleted DURING that window — and since the
  // delete ran before this row's sync_status flip landed, deleteBookmark
  // would have seen it as never-synced and skipped enqueuing a remote
  // delete, leaving the row this batch just created stranded in the cloud.
  const survivorId = '7e64cf1e-0000-4000-8000-000000000301';
  const deletedMidFlightId = '7e64cf1e-0000-4000-8000-000000000302';
  const now = '2026-06-12T00:00:00.000Z';
  fakeRepo.__reset([
    makeStoredBookmark({
      id: survivorId,
      url: 'https://example.com/survivor',
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
    makeStoredBookmark({
      id: deletedMidFlightId,
      url: 'https://example.com/deleted-mid-flight',
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
  ]);
  for (const id of [survivorId, deletedMidFlightId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseCompletion: () => void = () => { };
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  let completionEntered: () => void = () => { };
  const completionEnteredPromise = new Promise<void>((resolve) => {
    completionEntered = resolve;
  });
  const originalComplete = fakeRepo.repository.completeCreateSyncBatch!.bind(fakeRepo.repository);
  fakeRepo.repository.completeCreateSyncBatch = async (completions) => {
    // Signals that applyBulkCreateChunkResults' pre-await snapshot has
    // already been captured (this is only called after that loop runs) —
    // waiting on the createBookmarks mock instead would be too early: a
    // jest.fn() records a call synchronously before its returned promise
    // even resolves, so the delete could land before the snapshot exists.
    completionEntered();
    await completionGate;
    return originalComplete(completions);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await completionEnteredPromise;

  await act(async () => {
    store.current!.deleteBookmark(deletedMidFlightId);
  });
  expect(store.current!.getBookmark(deletedMidFlightId)).toBeUndefined();

  releaseCompletion();

  await waitFor(() => expect(store.current!.getBookmark(survivorId)?.sync_status).toBe('synced'));

  // Must stay gone — not resurrected by the stale pre-delete snapshot the
  // completion step captured.
  expect(store.current!.getBookmark(deletedMidFlightId)).toBeUndefined();
  expect(fakeRepo.__bookmarks().find((b) => b.id === deletedMidFlightId)).toBeUndefined();

  // The row this batch just created for it must not be left stranded in the
  // cloud: a remote delete must have been enqueued for cleanup.
  await waitFor(() =>
    expect(
      store.current!.queue.some(
        (entry) => entry.local_id === deletedMidFlightId && entry.operation === 'delete',
      ),
    ).toBe(true),
  );

  fakeRepo.repository.completeCreateSyncBatch = originalComplete;
});

test('an edit made while a bulk-create durable persist is still in flight is not silently dropped', async () => {
  // followUpUpdates/the reconcile check used to be computed from the
  // pre-await snapshot in the first loop. An edit landing while
  // completeCreateSyncBatch is awaiting doesn't enqueue its own update
  // (hasSyncedOnce is still false — the row isn't confirmed synced yet), so
  // that reconcile check was the ONLY remaining path that could push it;
  // checking the stale snapshot missed the edit entirely, silently dropping
  // it (and leaving the row vulnerable to a later pull overwriting it with
  // the older uploaded values).
  const editedId = '7e64cf1e-0000-4000-8000-000000000401';
  const otherId = '7e64cf1e-0000-4000-8000-000000000402';
  const now = '2026-06-12T00:00:00.000Z';
  fakeRepo.__reset([
    makeStoredBookmark({
      id: editedId,
      url: 'https://example.com/edited-mid-flight',
      title: 'Original title',
      notes: null,
      collection_id: null,
      is_archived: false,
      deleted_at: null,
      sync_status: 'pending',
      metadata_status: 'pending',
    }),
    makeStoredBookmark({
      id: otherId,
      url: 'https://example.com/other',
      title: 'Other title',
      notes: null,
      collection_id: null,
      is_archived: false,
      deleted_at: null,
      sync_status: 'pending',
      metadata_status: 'pending',
    }),
  ]);
  for (const id of [editedId, otherId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseCompletion: () => void = () => { };
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  let completionEntered: () => void = () => { };
  const completionEnteredPromise = new Promise<void>((resolve) => {
    completionEntered = resolve;
  });
  const originalComplete = fakeRepo.repository.completeCreateSyncBatch!.bind(fakeRepo.repository);
  fakeRepo.repository.completeCreateSyncBatch = async (completions) => {
    completionEntered();
    await completionGate;
    return originalComplete(completions);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await completionEnteredPromise;

  await act(async () => {
    store.current!.updateBookmarkFields(editedId, { title: 'Edited during sync' });
  });
  expect(store.current!.getBookmark(editedId)?.title).toBe('Edited during sync');

  releaseCompletion();

  await waitFor(() => expect(store.current!.getBookmark(otherId)?.sync_status).toBe('synced'));

  // The edit must survive the sync completion, not get clobbered by the
  // stale pre-edit snapshot.
  expect(store.current!.getBookmark(editedId)?.title).toBe('Edited during sync');

  // The edit must also be durably persisted as part of THIS reconcile step,
  // not only reach the server once the follow-up 'update' sync eventually
  // runs. completeCreateSyncBatch already wrote the pre-edit snapshot
  // durably; without a fresh durable write here, exiting the app before
  // that follow-up sync fires would reload the stale (pre-edit) row on
  // restart — the 'update' queue entry carries no field snapshot of its
  // own, so the edit would be gone for good, not just delayed.
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === editedId)?.title).toBe(
      'Edited during sync',
    ),
  );

  // And it must actually reach the server: a follow-up update mutation has
  // to be enqueued (since the edit's own enqueue was skipped — the row
  // wasn't confirmed synced yet at edit time) and processed. Checked via the
  // API call itself, not the queue: a successful update syncs and clears its
  // queue entry quickly, so asserting on transient queue contents would be
  // racy.
  await waitFor(() =>
    expect(
      apiMock.__spies.updateBookmark.mock.calls.some(
        ([id, payload]) => id === editedId && payload.title === 'Edited during sync',
      ),
    ).toBe(true),
  );

  fakeRepo.repository.completeCreateSyncBatch = originalComplete;
});

test('a bulk chunk reconciling many entries at once persists them sequentially, not concurrently (STASH-3Y)', async () => {
  // Historical bug class (STASH-3B, twice under STASH-3N, documented in
  // docs/architecture/sqlite-write-contention.md): fanning out onto the
  // single serialized SQLite connection — via Promise.all OR an un-awaited
  // for loop — stacks up simultaneous native calls and shows up as "sqlite
  // tail wait" depth climbing into the tens. The reconcile follow-up persist
  // (bookmarks.tsx's followUpUpdates loop) used to fire
  // repository.updateBookmark for every reconciled entry in a chunk without
  // awaiting the previous call, which is exactly that shape. This proves at
  // most one updateBookmark call is ever in flight at a time.
  //
  // Spans BULK_CREATE_SYNC_CHUNK_SIZE + 2 entries (two chunks), not just one:
  // the first fix only made each chunk's own follow-up loop sequential
  // internally — the outer per-chunk loop still didn't await that loop
  // before starting the next chunk, so two chunks' follow-up persists could
  // still overlap with EACH OTHER (caught in PR review; a single-chunk test
  // can't detect this).
  const ids = Array.from(
    { length: BULK_CREATE_SYNC_CHUNK_SIZE + 2 },
    (_, index) => `7e64cf1e-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  const now = '2026-06-13T00:00:00.000Z';
  fakeRepo.__reset(
    ids.map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        // User-edited collection_id trips createNeedsReconcileUpdate
        // unconditionally (CreateBookmarkInput has no field for it at all).
        collection_id: 'col-1',
        sync_status: 'pending',
        // 'complete' (not 'pending') keeps the auto AI-enrichment trigger
        // from firing — that path has its own independent updateBookmark
        // call and would otherwise pollute the concurrency measurement below
        // with an unrelated source of overlap.
        metadata_status: 'complete',
      }),
    ),
  );
  for (const id of ids) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let inFlight = 0;
  let maxInFlight = 0;
  const updateCalls: string[] = [];
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    updateCalls.push(bookmark.id);
    // A real native SQLite call actually takes time — without this, two
    // fire-and-forget calls started back-to-back could both resolve within
    // the same microtask turn and never be observed overlapping.
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // Checked the instant all ids have been seen at least once — a separate,
  // later sync cycle (the reconciled entries' own queued 'update' operation
  // eventually syncing) also calls repository.updateBookmark, and that's a
  // legitimate, independent source of calls this test isn't about. Two
  // chunks' worth of 10ms-delayed sequential writes take real wall-clock
  // time, hence the longer timeout.
  await waitFor(() => expect(new Set(updateCalls).size).toBeGreaterThanOrEqual(ids.length), {
    timeout: 5000,
  });
  expect(maxInFlight).toBe(1);

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
  // Drain any of the instrumented calls still in flight so their delayed
  // writes can't land after a later test's fakeRepo.__reset.
  await waitFor(() => expect(inFlight).toBe(0), { timeout: 5000 });
});

test('an edit landing on a later entry while an earlier entry in the same reconcile chunk is still being persisted is not clobbered (STASH-3Y)', async () => {
  // Sequentializing the followUpUpdates persist (the fix above) means these
  // writes now take real wall-clock time in sequence, which widens the
  // window for this race: entry 2's write was still built from the snapshot
  // captured when the whole chunk started, so an edit to entry 2 landing
  // while entry 1's write is still in flight would be silently overwritten
  // once the loop got to entry 2, using stale (pre-edit) data (caught in PR
  // review). Fixed by re-reading each row from bookmarksRef.current
  // immediately before its own write.
  const firstId = '7e64cf1e-0000-4000-8000-000000000601';
  const secondId = '7e64cf1e-0000-4000-8000-000000000602';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [firstId, secondId].map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const id of [firstId, secondId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseFirstWrite: () => void = () => { };
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWriteEntered: () => void = () => { };
  const firstWriteEnteredPromise = new Promise<void>((resolve) => {
    firstWriteEntered = resolve;
  });
  let firstIdGated = false;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === firstId && !firstIdGated) {
      firstIdGated = true;
      firstWriteEntered();
      await firstWriteGate;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await firstWriteEnteredPromise;

  // secondId's persist (the second iteration of the followUpUpdates loop)
  // hasn't run yet — firstId's write is still gated. Edit secondId now.
  await act(async () => {
    store.current!.updateBookmarkFields(secondId, { title: 'Edited mid-reconcile' });
  });
  releaseFirstWrite();

  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === secondId)?.title).toBe(
      'Edited mid-reconcile',
    ),
  );

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('a bookmark permanently deleted while an earlier entry in the same reconcile chunk is still being persisted is not resurrected (STASH-3Y)', async () => {
  // A second, more serious variant of the same widened race: if the LATER
  // entry is permanently deleted (not just edited) while an earlier entry's
  // write is in flight, re-reading bookmarksRef.current finds nothing (the
  // row was removed, not merely changed). Falling back to the stale
  // pre-delete snapshot would resurrect it via updateBookmark's upsert, and
  // the 'update' mutation queued right after would supersede the delete's
  // own queued mutation — silently undoing the user's delete end to end
  // (caught in PR review). Fixed by treating a missing row as "already
  // handled by the delete flow" and skipping it entirely.
  const firstId = '7e64cf1e-0000-4000-8000-000000000611';
  const secondId = '7e64cf1e-0000-4000-8000-000000000612';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [firstId, secondId].map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const id of [firstId, secondId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseFirstWrite: () => void = () => { };
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWriteEntered: () => void = () => { };
  const firstWriteEnteredPromise = new Promise<void>((resolve) => {
    firstWriteEntered = resolve;
  });
  let firstIdGated = false;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === firstId && !firstIdGated) {
      firstIdGated = true;
      firstWriteEntered();
      await firstWriteGate;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await firstWriteEnteredPromise;

  // secondId's persist (the second iteration of the followUpUpdates loop)
  // hasn't run yet — firstId's write is still gated. Permanently delete
  // secondId now.
  await act(async () => {
    store.current!.deleteBookmark(secondId);
  });
  expect(store.current!.getBookmark(secondId)).toBeUndefined();
  releaseFirstWrite();

  // Must actually reach the server as a delete, not get superseded by a
  // resurrecting 'update'.
  await waitFor(() =>
    expect(
      fakeRepo
        .__queue()
        .some((entry) => entry.local_id === secondId && entry.operation === 'delete'),
    ).toBe(true),
  );

  expect(store.current!.getBookmark(secondId)).toBeUndefined();
  expect(fakeRepo.__bookmarks().find((b) => b.id === secondId)).toBeUndefined();
  expect(
    fakeRepo.__queue().some((entry) => entry.local_id === secondId && entry.operation === 'update'),
  ).toBe(false);

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('a storage failure reconciling one entry does not block the rest of the chunk from being persisted and queued (STASH-3Y)', async () => {
  // The whole followUpUpdates loop used to run inside a single try/catch:
  // completeCreateSyncBatch had already durably persisted and dequeued every
  // entry in the chunk, so a storage hiccup on ONE entry's follow-up write
  // aborted the loop and silently cost every LATER entry both its durable
  // reconcile write and its update queue entry — with no other path left to
  // recover them (caught in PR review). Each entry is now isolated in its
  // own try/catch.
  const failingId = '7e64cf1e-0000-4000-8000-000000000621';
  const okId = '7e64cf1e-0000-4000-8000-000000000622';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [failingId, okId].map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const id of [failingId, okId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === failingId) {
      throw new Error('simulated storage failure');
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // okId — ordered AFTER failingId in the chunk — must still get its
  // durable write and reach the server via its own update mutation despite
  // failingId's failure. Checked via the API call itself, not transient
  // queue contents: a successful update syncs and clears its queue entry
  // quickly, so asserting on the queue would be racy (see the identical
  // rationale on the "edit made while a bulk-create durable persist" test
  // above).
  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === okId)?.metadata_status).toBe('complete'),
  );
  await waitFor(() =>
    expect(apiMock.__spies.updateBookmark.mock.calls.some(([id]) => id === okId)).toBe(true),
  );

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('pending AI-trigger markers are persisted before the reconcile write loops, not after (STASH-3Y)', async () => {
  // completeCreateSyncBatch already marked every create in this chunk synced
  // and removed its create queue entry — if the app exits while a LATER
  // entry's reconcile write is still awaited, there is no remaining path to
  // recreate a missed durable AI-trigger marker on restart, permanently
  // costing that bookmark its automatic AI suggestions (caught in PR
  // review). Both ids' markers must already be durably persisted while the
  // first entry's reconcile write is still gated (not yet resolved).
  const firstId = '7e64cf1e-0000-4000-8000-000000000631';
  const secondId = '7e64cf1e-0000-4000-8000-000000000632';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [firstId, secondId].map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const id of [firstId, secondId]) {
    await fakeRepo.repository.enqueue({
      local_id: id,
      remote_id: null,
      operation: 'create',
      payload: { id, url: `https://example.com/${id}`, client_id: id },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseFirstWrite: () => void = () => { };
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWriteEntered: () => void = () => { };
  const firstWriteEnteredPromise = new Promise<void>((resolve) => {
    firstWriteEntered = resolve;
  });
  let firstIdGated = false;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === firstId && !firstIdGated) {
      firstIdGated = true;
      firstWriteEntered();
      await firstWriteGate;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await firstWriteEnteredPromise;

  // Still gated — the reconcile write loop hasn't resolved for either entry
  // yet — but both markers must already be durably persisted.
  const pending = JSON.parse(fakeRepo.__meta('pending_ai_trigger') ?? '[]') as string[];
  expect(pending).toEqual(expect.arrayContaining([firstId, secondId]));

  releaseFirstWrite();
  // Drain the rest of the reconcile chain (secondId's write, its own
  // enqueue, and its sync) before ending the test — otherwise this
  // continuation can still be running when the next test calls
  // fakeRepo.__reset, writing this test's ids into that fresh fixture
  // (caught in PR review).
  await waitFor(() =>
    expect(apiMock.__spies.updateBookmark.mock.calls.some(([id]) => id === secondId)).toBe(true),
  );
  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});
