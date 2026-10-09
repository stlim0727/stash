import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderStore, resetEnrichmentHarness } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


test('a bulk chunk persists its AI-trigger markers with one coalesced write, not one per entry (STASH-3Y)', async () => {
  // markPendingAiTrigger's own persistPendingAiTrigger() call is
  // fire-and-forget. Calling it once per completed entry in a chunk (as the
  // loop used to) fires that many independent, un-awaited setMeta writes
  // for the SAME meta key onto the single serialized SQLite actor —
  // recreating the exact fan-out contention this PR exists to fix (caught
  // in PR review). Every id is added to the ref first (cheap, synchronous)
  // and persisted with a single awaited write instead.
  const ids = Array.from(
    { length: 5 },
    (_, index) => `7e64cf1e-0000-4000-8000-00000000067${index}`,
  );
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    ids.map((id) =>
      makeStoredBookmark({
        id,
        url: `https://example.com/${id}`,
        sync_status: 'pending',
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

  let pendingAiTriggerWrites = 0;
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  fakeRepo.repository.setMeta = async (key, value) => {
    if (key === 'pending_ai_trigger') {
      pendingAiTriggerWrites += 1;
    }
    return originalSetMeta(key, value);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() => {
    const pending = JSON.parse(fakeRepo.__meta('pending_ai_trigger') ?? '[]') as string[];
    expect(ids.every((id) => pending.includes(id))).toBe(true);
  });

  expect(pendingAiTriggerWrites).toBe(1);

  fakeRepo.repository.setMeta = originalSetMeta;
});

test('a transient failure persisting the coalesced AI-trigger marker is retried, not silently accepted (STASH-3Y)', async () => {
  // persistPendingAiTrigger catches its own repository.setMeta failure
  // internally and resolves anyway, so awaiting it can never observe a
  // failure — a transient failure would silently "succeed" on the first
  // attempt, and since the successful creates are already durably
  // dequeued, exiting before some later unrelated marker write happens to
  // rewrite the meta value would leave every id from this chunk without a
  // restart trigger (caught in PR review). The chunk now calls
  // repository.setMeta directly, wrapped in retryStorageWrite, so a
  // transient failure is actually retried rather than accepted.
  const id = '7e64cf1e-0000-4000-8000-000000000665';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000666';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let failuresLeft = 1;
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  fakeRepo.repository.setMeta = async (key, value) => {
    if (key === 'pending_ai_trigger' && failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('simulated transient storage failure');
    }
    return originalSetMeta(key, value);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() => {
    const pending = JSON.parse(fakeRepo.__meta('pending_ai_trigger') ?? '[]') as string[];
    expect(pending).toEqual(expect.arrayContaining([id, fillerId]));
  });
  expect(failuresLeft).toBe(0);

  fakeRepo.repository.setMeta = originalSetMeta;
});

test('a bookmark permanently deleted while its own reconcile write is in flight does not have that delete superseded (STASH-3Y)', async () => {
  // A narrower variant of the earlier "deleted while an EARLIER entry's
  // write is in flight" case: here the SAME bookmark is deleted while its
  // OWN repository.updateBookmark(current) call is awaited. The
  // already-null-checked `current` was non-null when the write started, so
  // the earlier "missing row" guard doesn't catch this — deleteBookmark's
  // own 'delete' mutation lands first, but the unconditional
  // enqueueMutation(bookmark.id, 'update') that used to run right after the
  // write resolved would supersede it, resurrecting the row (caught in PR
  // review). Fixed by rechecking bookmarksRef.current AFTER the write, not
  // just before it.
  // A second, unrelated entry is needed alongside `id` so this chunk goes
  // through the bulk path (applyBulkCreateChunkResults) at all — a single
  // entry falls through to the single-create fallback, a different code
  // path this fix doesn't touch. Both need reconcile so, once `fillerId`'s
  // update reaches the server, that's durable proof the loop already made
  // (and acted on) its decision for `id` first — no need to poll transient
  // queue contents for `id` itself, which a fast/mocked sync could clear
  // before a waitFor poll ever observes it.
  const id = '7e64cf1e-0000-4000-8000-000000000641';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000643';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseWrite: () => void = () => { };
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writeEntered: () => void = () => { };
  const writeEnteredPromise = new Promise<void>((resolve) => {
    writeEntered = resolve;
  });
  let gated = false;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === id && !gated) {
      gated = true;
      writeEntered();
      await writeGate;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await writeEnteredPromise;

  // The write for `id` has started (current was found, non-null) but hasn't
  // resolved yet. Permanently delete it now, mid-write.
  await act(async () => {
    store.current!.deleteBookmark(id);
  });
  expect(store.current!.getBookmark(id)).toBeUndefined();
  releaseWrite();

  // Durable proof the loop has moved past `id`'s branch decision.
  await waitFor(() =>
    expect(apiMock.__spies.updateBookmark.mock.calls.some(([callId]) => callId === fillerId)).toBe(
      true,
    ),
  );

  expect(store.current!.getBookmark(id)).toBeUndefined();
  expect(fakeRepo.__bookmarks().find((b) => b.id === id)).toBeUndefined();
  expect(
    fakeRepo.__queue().some((entry) => entry.local_id === id && entry.operation === 'update'),
  ).toBe(false);
  expect(apiMock.__spies.updateBookmark.mock.calls.some(([callId]) => callId === id)).toBe(false);

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('a transient storage failure reconciling an entry is retried rather than abandoned immediately (STASH-3Y)', async () => {
  // Nothing else will ever retry this specific reconcile write once
  // completeCreateSyncBatch has already dequeued the create — a transient
  // failure (this test simulates one) must not be treated the same as a
  // persistent one and abandoned on the first attempt. A second, unrelated
  // entry is needed alongside `id` so this chunk actually goes through the
  // bulk path (applyBulkCreateChunkResults) — a single entry falls through
  // to the single-create fallback, a different code path this fix doesn't
  // touch.
  const id = '7e64cf1e-0000-4000-8000-000000000642';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000644';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let failuresLeft = 1;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === id && failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error('simulated transient storage failure');
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() =>
    expect(fakeRepo.__bookmarks().find((b) => b.id === id)?.metadata_status).toBe('complete'),
  );
  await waitFor(() =>
    expect(apiMock.__spies.updateBookmark.mock.calls.some(([callId]) => callId === id)).toBe(true),
  );
  expect(failuresLeft).toBe(0);

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('a bookmark deleted during the reconcile write retry delay is not resurrected by a later retry attempt (STASH-3Y)', async () => {
  // The reconcile write's first attempt closed over a single `current`
  // snapshot resolved once, before calling retryStorageWrite — every retry
  // reused that same stale snapshot. If the row was permanently deleted
  // during the retry delay, a later retry would still write the stale
  // (pre-delete) snapshot back via updateBookmark's upsert, resurrecting a
  // row the user already deleted (caught in PR review). Fixed by
  // re-resolving the current row from bookmarksRef.current inside every
  // retry attempt, no-oping if it's gone rather than writing stale data.
  const id = '7e64cf1e-0000-4000-8000-000000000651';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000652';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let firstAttemptFailed: () => void = () => { };
  const firstAttemptFailedPromise = new Promise<void>((resolve) => {
    firstAttemptFailed = resolve;
  });
  let originalCallsForId = 0;
  let calls = 0;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === id) {
      calls += 1;
      if (calls === 1) {
        firstAttemptFailed();
        throw new Error('simulated transient storage failure');
      }
      originalCallsForId += 1;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await firstAttemptFailedPromise;

  // The first attempt just failed; the retry is scheduled ~50ms out.
  // Permanently delete `id` right now, inside that delay.
  await act(async () => {
    store.current!.deleteBookmark(id);
  });
  expect(store.current!.getBookmark(id)).toBeUndefined();

  // Durable proof the retry loop has moved on (to fillerId) — by which
  // point `id`'s retry attempt(s) have already run and made their decision.
  await waitFor(() =>
    expect(apiMock.__spies.updateBookmark.mock.calls.some(([callId]) => callId === fillerId)).toBe(
      true,
    ),
  );

  // The retry must never have actually written `id` back — it was gone by
  // the time any retry ran, so the fixed code no-ops instead of upserting
  // the stale pre-delete snapshot.
  expect(originalCallsForId).toBe(0);
  expect(fakeRepo.__bookmarks().find((b) => b.id === id)).toBeUndefined();
  expect(
    fakeRepo.__queue().some((entry) => entry.local_id === id && entry.operation === 'update'),
  ).toBe(false);

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('AI dispatch stays suppressed while a bulk chunk reconcile follow-up is still in flight (STASH-3Y)', async () => {
  // The completed-create entries are removed from the queue before the
  // reconcile follow-up's replacement 'update' mutations are enqueued — a
  // gap that now spans real, sequential SQLite writes. The AI-dispatch
  // interval (400ms) only checks the queue for pending/syncing entries, so
  // it could observe that gap as "sync settled" and start firing AI
  // requests while reconciliation is still blocked — adding exactly the
  // storage/network load this fix is meant to relieve (caught in PR
  // review). Fixed with an explicit bulkReconcileInFlight flag the interval
  // also checks.
  const id = '7e64cf1e-0000-4000-8000-000000000661';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000662';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        site_name: 'Example Site',
        collection_id: 'col-1',
        sync_status: 'pending',
        // 'complete' (already fetched) so the deferred AI-trigger effect
        // doesn't wait on a background metadata fetch first — it's
        // eligible to dispatch the instant the create completes.
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseWrite: () => void = () => { };
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writeEntered: () => void = () => { };
  const writeEnteredPromise = new Promise<void>((resolve) => {
    writeEntered = resolve;
  });
  let gated = false;
  const originalUpdateBookmark = fakeRepo.repository.updateBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.updateBookmark = async (bookmark) => {
    if (bookmark.id === id && !gated) {
      gated = true;
      writeEntered();
      await writeGate;
    }
    return originalUpdateBookmark(bookmark);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await writeEnteredPromise;

  // Still gated, well past one 400ms dispatch tick: no AI request must have
  // fired yet.
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  releaseWrite();

  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(id, expect.anything(), 'en'),
  );

  fakeRepo.repository.updateBookmark = originalUpdateBookmark;
});

test('AI dispatch stays suppressed during the coalesced AI-marker write itself, not just the loops after it (STASH-3Y)', async () => {
  // bulkReconcileInFlight used to increment AFTER the awaited AI-marker
  // persist, not before it — so during that specific write (which can
  // itself outlast one 400ms dispatch tick), the flag was still 0 and the
  // queue already had nothing pending/syncing for this chunk, making the
  // dispatch interval think sync had settled (caught in PR review). Fixed
  // by incrementing the flag before the marker persist, not just before
  // the two follow-up loops.
  const id = '7e64cf1e-0000-4000-8000-000000000663';
  const fillerId = '7e64cf1e-0000-4000-8000-000000000664';
  const now = '2026-06-14T00:00:00.000Z';
  fakeRepo.__reset(
    [id, fillerId].map((bookmarkId) =>
      makeStoredBookmark({
        id: bookmarkId,
        url: `https://example.com/${bookmarkId}`,
        sync_status: 'pending',
        metadata_status: 'complete',
      }),
    ),
  );
  for (const bookmarkId of [id, fillerId]) {
    await fakeRepo.repository.enqueue({
      local_id: bookmarkId,
      remote_id: null,
      operation: 'create',
      payload: { id: bookmarkId, url: `https://example.com/${bookmarkId}`, client_id: bookmarkId },
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }

  let releaseWrite: () => void = () => { };
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let writeEntered: () => void = () => { };
  const writeEnteredPromise = new Promise<void>((resolve) => {
    writeEntered = resolve;
  });
  let gated = false;
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  fakeRepo.repository.setMeta = async (key, value) => {
    if (key === 'pending_ai_trigger' && !gated) {
      gated = true;
      writeEntered();
      await writeGate;
    }
    return originalSetMeta(key, value);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await writeEnteredPromise;

  // Still gated on the AI-marker write itself, well past one 400ms dispatch
  // tick: no AI request must have fired yet.
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();

  releaseWrite();

  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(id, expect.anything(), 'en'),
  );

  fakeRepo.repository.setMeta = originalSetMeta;
});

test('a bookmark deleted mid-flight during a bulk create is persisted locally before its remote-delete mutation is queued (STASH-3Y)', async () => {
  // Ordering regression: queueing all of a chunk's remote-delete mutations
  // before any of the durable local deletes land means a crash between the
  // two leaves a 'delete' queue entry whose local row was never actually
  // removed — that entry's eventual sync only deletes the remote row and
  // itself, leaving the local row resurrected indefinitely (caught in PR
  // review). Each id's local delete must land before its own mutation is
  // queued.
  const survivorId = '7e64cf1e-0000-4000-8000-000000000701';
  const deletedMidFlightId = '7e64cf1e-0000-4000-8000-000000000702';
  const now = '2026-06-15T00:00:00.000Z';
  fakeRepo.__reset([
    makeStoredBookmark({
      id: survivorId,
      url: 'https://example.com/survivor-2',
      sync_status: 'pending',
      metadata_status: 'complete',
    }),
    makeStoredBookmark({
      id: deletedMidFlightId,
      url: 'https://example.com/deleted-mid-flight-2',
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
    completionEntered();
    await completionGate;
    return originalComplete(completions);
  };

  let deletedWhileAlreadyQueued = false;
  const originalDeleteBookmark = fakeRepo.repository.deleteBookmark.bind(fakeRepo.repository);
  fakeRepo.repository.deleteBookmark = async (id) => {
    if (
      id === deletedMidFlightId &&
      fakeRepo
        .__queue()
        .some((entry) => entry.local_id === id && entry.operation === 'delete')
    ) {
      deletedWhileAlreadyQueued = true;
    }
    return originalDeleteBookmark(id);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await completionEnteredPromise;

  await act(async () => {
    store.current!.deleteBookmark(deletedMidFlightId);
  });
  releaseCompletion();

  await waitFor(() =>
    expect(
      fakeRepo
        .__queue()
        .some((entry) => entry.local_id === deletedMidFlightId && entry.operation === 'delete'),
    ).toBe(true),
  );

  // Drain the follow-up delete's own sync attempt before restoring the
  // mocked methods — this entry was added after the active sync's own
  // queue snapshot, so a later auto-sync pass drains it; api.deleteBookmark
  // isn't mocked in this file, so that attempt throws and settles to
  // 'failed' quickly. Without waiting for that, the provider could still be
  // mid-attempt when the next test resets the shared fake repository,
  // mutating that fresh fixture (caught in PR review).
  await waitFor(() =>
    expect(
      fakeRepo
        .__queue()
        .find((entry) => entry.local_id === deletedMidFlightId && entry.operation === 'delete')
        ?.sync_status,
    ).toBe('failed'),
  );

  expect(deletedWhileAlreadyQueued).toBe(false);

  fakeRepo.repository.completeCreateSyncBatch = originalComplete;
  fakeRepo.repository.deleteBookmark = originalDeleteBookmark;
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
