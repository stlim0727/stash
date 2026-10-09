import './helpers/ai-enrichment-harness';
import { clearLogEntries, getLogEntries } from '@/observability/log-buffer';
import { AI_RATE_LIMITED, BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { BULK_CREATE_SYNC_CHUNK_SIZE } from '@/sync/sync-bookmarks';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { apiMock, fakeRepo, fireForeground, makeSuccessEnrichment, mockHarness, mockSession, renderReady, renderStore, resetEnrichmentHarness, SECOND_SYNCED_ID, SYNCED_ID, waitUntilSyncQuiescent } from './helpers/ai-enrichment-harness';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


test('a request that settles AFTER an account switch does not arm the new account cooldown (Codex review round 2, PR #655)', async () => {
  // Sharper than the test above: there, account A's 429 settles BEFORE the
  // switch. Here it settles AFTER — the account-switch effect clears
  // aiQuotaCooldownUntil first, and then the stale in-flight A response
  // must not re-arm it for the now-active B.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  let releaseFirstRequest: () => void = () => { };
  const firstRequestGate = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await firstRequestGate;
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // Account A's request for SYNCED_ID is now in flight, gated on the promise
  // above — it will not settle until releaseFirstRequest() is called.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Switch to account B WHILE A's request is still stuck in flight.
  mockHarness.authSession = { ...mockSession, user: { id: 'real-user-b' } };
  await act(async () => {
    rerender(undefined);
  });

  // NOW let A's stale request finally resolve with the 429. If the bug were
  // present, this would arm a ~30-minute cooldown for the now-active B.
  await act(async () => {
    releaseFirstRequest();
    await Promise.resolve();
  });

  // Give B's own pipeline (rehome + re-trigger, same mechanism as the test
  // above) a chance to actually dispatch something. If A's stale settle had
  // wrongly armed the cooldown, this would stay at 1 for the full window.
  await waitFor(
    () => expect(apiMock.__spies.requestEnrichment.mock.calls.length).toBeGreaterThan(1),
    { timeout: 5000 },
  );
});

test('a burst-dispatch settling after a real A→real B switch does not fire a completion toast under B (#691)', async () => {
  // Sharper than the two cooldown tests above, and specifically targeting the
  // auto-dispatch BURST QUEUE (aiDispatchQueueRef) rather than the quota
  // cooldown: this needs a genuine real→real "switch" (drop), not the
  // anon-carry-over "rehome" those tests exercise — hence is_anonymous:
  // false on both accounts, so planAccountTransition picks 'switch'.
  //
  // Account A auto-dispatches two bookmarks. The first (SYNCED_ID) settles
  // normally, bumping completedInBurst to 1 — still below the toast
  // threshold, so nothing has shown yet. The second (SECOND_SYNCED_ID) is
  // held open. The switch to B happens while it's still in flight, dropping
  // both of A's bookmarks. If the stale settle were still allowed to count
  // (the #691 bug), completedInBurst would reach 2 with nothing left
  // pending — isBurstComplete — and fire a toast under B reporting two
  // bookmarks that were entirely A's.
  const realUserA: { id: string; is_anonymous?: boolean } = {
    id: 'real-user-a',
    is_anonymous: false,
  };
  mockHarness.authSession = { ...mockSession, user: realUserA };
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([SYNCED_ID, SECOND_SYNCED_ID]),
  );

  let releaseSecond: (value: unknown) => void = () => { };
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  // Two mockImplementationOnce calls (not a persistent mockImplementation,
  // which would leak into every later test in this file — beforeEach only
  // mockClear()s requestEnrichment, not mockReset()): dispatch is strictly
  // serial, so the first call is always for SYNCED_ID and the second for
  // SECOND_SYNCED_ID, matching pending_ai_trigger's insertion order above.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) =>
    makeEnrichment({ id: 'enrichment-first', bookmark_id: bookmarkId }),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => secondGate);

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // Let the initial pull settle so SYNCED_USER_ID_KEY durably records
  // real-user-a — the later switch's plan is read from that meta.
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());

  // Both of A's dispatches have started: SYNCED_ID already resolved (fast
  // path above), SECOND_SYNCED_ID is now in flight, gated on secondGate.
  await waitFor(
    () => expect(apiMock.__spies.requestEnrichment.mock.calls.length).toBeGreaterThanOrEqual(2),
    { timeout: 5000 },
  );
  expect(result.current.aiEnrichmentBurstToast).toBeNull();

  // Switch to a different REAL account WHILE SECOND_SYNCED_ID is still stuck
  // in flight — a genuine 'switch' (drop), not a 'carry-over' (rehome).
  const realUserB: { id: string; is_anonymous?: boolean } = {
    id: 'real-user-b',
    is_anonymous: false,
  };
  mockHarness.authSession = { ...mockSession, user: realUserB };
  await act(async () => {
    rerender(undefined);
  });
  // Confirm the switch actually dropped A's bookmarks locally before
  // releasing the stale request — otherwise the assertion below proves
  // nothing about the switch itself having happened yet.
  await waitFor(() => expect(result.current.getBookmark(SYNCED_ID)).toBeUndefined());

  // NOW let A's stale SECOND_SYNCED_ID request finally resolve.
  await act(async () => {
    releaseSecond(makeEnrichment({ id: 'enrichment-second', bookmark_id: SECOND_SYNCED_ID }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(result.current.aiEnrichmentBurstToast).toBeNull();
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
  // Codex review (PR #655): processingStats.diagnostics.ai.todo (Settings' backlog count)
  // must still count this bookmark — it's still legitimately waiting on the
  // server worker even though it dropped out of the local retry set.
  expect(store.current!.processingStats.diagnostics.ai.todo).toBeGreaterThanOrEqual(1);
});

test('processingStats.diagnostics.ai.todo surfaces a real account-wide server backlog this device never locally triggered', async () => {
  // The core bug this regression guards: before fetchAiServerQueueSnapshot,
  // `ai.todo` was a pure union of local-event sets (pendingAiTrigger, the
  // dispatch queue, aiRetryIds, aiServerQueuedIds) — every one of which is
  // only ever populated by THIS device's own actions. A bookmark another
  // device 429'd, one the server-side dispatch trigger enqueued, or a direct
  // `pending_ai_enrichment` backfill (verified live: 1,101 rows backfilled
  // while the worker visibly drained them) is invisible to all four, so the
  // counter read 0 even with a real, actively-processing backlog. No local
  // trigger/dispatch/retry/enqueue call happens anywhere in this test — the
  // only thing that changes is the server's own count.
  apiMock.__spies.fetchAiQueueSnapshot.mockResolvedValue(
    Array.from({ length: 1101 }, (_, index) => ({
      bookmark_id: `server-${index}`,
      status: 'pending',
      attempts: 0,
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    })),
  );
  const store = await renderReady();

  await waitFor(() => expect(store.current!.processingStats.diagnostics.ai.todo).toBe(1101));
  expect(store.current!.processingStats.diagnostics.ai.serverQueued).toBe(1101);
  expect(store.current!.processingStats.diagnostics.ai.activeUnblocked).toBe(1101);
  expect(store.current!.processingStats.diagnostics.ai.activeBlocked).toBe(1101);
});

test('processingStats.diagnostics.ai.todo does not double-count a bookmark this device already knows is server-queued', async () => {
  // The other half of the fix: a bookmark THIS device 429'd already lands in
  // both aiRetryIds (the generic armAiRetry marker, armed unconditionally on
  // every failure) AND aiServerQueuedIds (the confirmed-enqueue marker) — so
  // the account-wide server count for that same row must not be added a
  // second time on top of the existing local union.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });
  await waitFor(() => expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true));
  expect(store.current!.processingStats.diagnostics.ai.todo).toBe(1);

  // The server confirms exactly this one row is outstanding — nothing extra.
  apiMock.__spies.fetchAiQueueSnapshot.mockResolvedValue([
    {
      bookmark_id: SYNCED_ID,
      status: 'pending',
      attempts: 0,
      created_at: '2026-08-05T00:00:00.000Z',
      updated_at: '2026-08-05T00:00:00.000Z',
    },
  ]);
  await act(async () => {
    fireForeground();
  });

  // Still 1, not 2: the fetched total is entirely explained by the id this
  // device already knows about.
  await waitFor(() =>
    expect(apiMock.__spies.fetchAiQueueSnapshot).toHaveBeenCalled(),
  );
  expect(store.current!.processingStats.diagnostics.ai.todo).toBe(1);
  expect(store.current!.processingStats.diagnostics.ai.serverQueued).toBe(1);
});

test('processingStats.diagnostics.ai.degradedRateLimited counts only rate_limited-degraded enrichments, not timeout/provider_error/not_configured or non-degraded rows', async () => {
  // The Gemini provider (not the user's own quota gate) hit RESOURCE_EXHAUSTED
  // for these — the server silently served heuristic suggestions and
  // requeued them into `pending_ai_enrichment` for a real-model retry (only
  // `rate_limited` gets that auto-requeue in `ai-enrich/index.ts`). This is
  // the fact the Settings "Basic suggestions shown" chip surfaces.
  fakeRepo.__reset(
    [
      makeStoredBookmark({ id: 'bm-rate-limited-1' }),
      makeStoredBookmark({ id: 'bm-rate-limited-2' }),
      makeStoredBookmark({ id: 'bm-timeout' }),
      makeStoredBookmark({ id: 'bm-provider-error' }),
      makeStoredBookmark({ id: 'bm-not-configured' }),
      makeStoredBookmark({ id: 'bm-clean' }),
    ],
    undefined,
    [
      makeEnrichment({
        id: 'enr-1',
        bookmark_id: 'bm-rate-limited-1',
        degraded: true,
        degraded_reason: 'rate_limited',
      }),
      makeEnrichment({
        id: 'enr-2',
        bookmark_id: 'bm-rate-limited-2',
        degraded: true,
        degraded_reason: 'rate_limited',
      }),
      // Real failures with no automatic-retry promise — must not count.
      makeEnrichment({
        id: 'enr-3',
        bookmark_id: 'bm-timeout',
        degraded: true,
        degraded_reason: 'timeout',
      }),
      makeEnrichment({
        id: 'enr-4',
        bookmark_id: 'bm-provider-error',
        degraded: true,
        degraded_reason: 'provider_error',
      }),
      makeEnrichment({
        id: 'enr-5',
        bookmark_id: 'bm-not-configured',
        degraded: true,
        degraded_reason: 'not_configured',
      }),
      // A normal, non-degraded completed enrichment — must not count either.
      makeEnrichment({
        id: 'enr-6',
        bookmark_id: 'bm-clean',
        degraded: false,
        degraded_reason: null,
      }),
    ],
  );
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  expect(store.current!.processingStats.diagnostics.ai.degradedRateLimited).toBe(2);
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
  // applySyncQueueHealthEscalation) — not just silently reset back to
  // 'pending' with no record anything went wrong.
  fakeRepo.__reset([]);
  apiMock.__spies.createBookmarks.mockRejectedValueOnce(new Error('network down'));
  clearLogEntries();

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

  // Sentry STASH-62: the cycle-done summary log must count this failure —
  // `syncFailed` used to be dead code (declared, never incremented), so this
  // line always read "failed=0" even on a real bulk-endpoint outage,
  // undermining exactly the kind of triage this test's own diagnostics are
  // meant to enable.
  await waitFor(() =>
    expect(
      getLogEntries().some((entry) => /^sync: cycle done entries=2 failed=2$/.test(entry.message)),
    ).toBe(true),
  );
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

test('a bulk create failure marks untried later chunks failed too, so the auto-sync effect cannot immediately retrigger', async () => {
  // Regression: leaving untried later-chunk entries 'pending' after the
  // first chunk failed satisfied the auto-sync effect's retrigger condition
  // (any 'pending'/'syncing' entry) — the instant this run ended it called
  // syncNow() again, and that call retried the SAME already-failed first
  // chunk first, recreating a continuous retry loop for the duration of a
  // real outage instead of waiting for the next natural trigger (a save,
  // app foreground, manual Sync now), unlike every other failed entry.
  const rows = Array.from({ length: BULK_CREATE_SYNC_CHUNK_SIZE + 1 }, (_, index) =>
    makeStoredBookmark({
      id: `8e64cf1e-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      url: `https://example.com/bulk-outage-${index + 1}`,
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
  // A persistent outage — every bulk attempt fails, not just the first.
  apiMock.__spies.createBookmarks.mockRejectedValue(new Error('network down'));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await waitFor(() =>
    expect(store.current!.queue.every((entry) => entry.sync_status === 'failed')).toBe(true),
  );

  // Some other mount-time effect's own syncNow() attempt can overlap this
  // run and defer via syncPendingRef, firing one (or occasionally more)
  // legitimate follow-up retry later regardless of this fix's correctness.
  // A fixed-length wait for that races real wall-clock time (flaky when the
  // whole test:components suite loads the machine — the real scheduled
  // timer can fire later than its nominal delay), so poll until the call
  // count for these rows AND isSyncing both stop changing instead of
  // guessing a bound. This also ensures any such retry lands within this
  // test rather than leaking into the next one's shared mock queue.
  const countCallsForTheseRows = () =>
    apiMock.__spies.createBookmarks.mock.calls.filter(([inputs]: [Array<{ id?: string }>]) =>
      inputs.some((input) => input.id === rows[0]!.id),
    ).length;
  await waitUntilSyncQuiescent(store, countCallsForTheseRows);

  const untriedRowId = rows[BULK_CREATE_SYNC_CHUNK_SIZE]!.id;
  const attemptedEntries = store.current!.queue.filter((entry) => entry.local_id !== untriedRowId);
  const untriedEntry = store.current!.queue.find((entry) => entry.local_id === untriedRowId);
  expect(attemptedEntries).toHaveLength(BULK_CREATE_SYNC_CHUNK_SIZE);
  // >= 1, not exactly 1: a legitimate overlap-triggered retry (see above)
  // would re-attempt this same chunk and increment retry_count again — the
  // invariant that matters is that it happened at least once, not an exact
  // count.
  expect(attemptedEntries.every((entry) => entry.retry_count >= 1)).toBe(true);
  expect(
    attemptedEntries.every((entry) => entry.last_error_kind === 'other'),
  ).toBe(true);
  // Never attempted this run (or any repeat of it), so its retry_count must
  // stay unchanged regardless of how many times chunk 1 above retries.
  expect(untriedEntry?.retry_count).toBe(0);
  expect(untriedEntry?.last_error_kind).toBe('other');
  expect(apiMock.__spies.createBookmark).not.toHaveBeenCalled();
});

test('a bulk create failure does not revert an earlier, already-succeeded chunk back to failed', async () => {
  // Regression: marking every entry NOT in the failing chunk as 'failed'
  // (rather than only entries strictly after it) also caught earlier chunks
  // that already succeeded and had their queue entries cleared this same
  // run. Their bookmarks had no queue entry left to retry, yet got flipped
  // back to sync_status: 'failed' anyway — a false failure report that only
  // another sync pass or a restart would repair.
  const chunkCount = 2;
  const rows = Array.from({ length: chunkCount * BULK_CREATE_SYNC_CHUNK_SIZE + 1 }, (_, index) =>
    makeStoredBookmark({
      id: `9e64cf1e-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      url: `https://example.com/bulk-multi-chunk-${index + 1}`,
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
  // First chunk succeeds (mirrors the default echo-id-back behavior); the
  // second chunk hits a persistent outage. The third (untried) chunk is a
  // single row and is never attempted.
  apiMock.__spies.createBookmarks
    .mockImplementationOnce(async (inputs: Array<{ id?: string }>) =>
      inputs.map((input) => ({
        bookmark_id: input.id ?? '00000000-0000-4000-8000-000000000000',
        status: 'created' as const,
        metadata_status: 'pending' as const,
      })),
    )
    .mockRejectedValue(new Error('network down'));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  const firstChunkIds = rows.slice(0, BULK_CREATE_SYNC_CHUNK_SIZE).map((row) => row.id);
  await waitFor(() =>
    expect(
      firstChunkIds.every((id) => store.current!.getBookmark(id)?.sync_status === 'synced'),
    ).toBe(true),
  );
  await waitFor(() => expect(store.current!.isSyncing).toBe(false));

  // The first chunk must stay synced — no queue entry left to retry, so
  // reverting its bookmarks to 'failed' would be a false report.
  for (const id of firstChunkIds) {
    expect(store.current!.getBookmark(id)?.sync_status).toBe('synced');
    expect(store.current!.queue.some((entry) => entry.local_id === id)).toBe(false);
  }

  // The second chunk (the one that actually failed) is correctly 'failed'.
  const secondChunkIds = rows
    .slice(BULK_CREATE_SYNC_CHUNK_SIZE, 2 * BULK_CREATE_SYNC_CHUNK_SIZE)
    .map((row) => row.id);
  for (const id of secondChunkIds) {
    expect(store.current!.getBookmark(id)?.sync_status).toBe('failed');
  }

  // Drain any deferred follow-up retry (see waitUntilSyncQuiescent) before
  // ending, or it fires during the NEXT test and consumes its shared mock
  // queue instead of this one's own (caught in PR review).
  await waitUntilSyncQuiescent(store, () => apiMock.__spies.createBookmarks.mock.calls.length);
});

test('a bookmark permanently deleted mid-persist in an untried chunk is not resurrected as failed', async () => {
  // Regression: the "mark untried entries failed too" persist loop checks
  // each entry against a single listQueue() snapshot taken once up front
  // (a deliberate perf fix — see the earlier "read the queue once" review
  // comment). A permanent delete of a never-synced bookmark in a LATER,
  // untried chunk that lands after that snapshot but before the loop
  // reaches it wouldn't show up in the snapshot, so the stored/updated_at
  // check alone can't catch it — writing the 'failed' state back would
  // resurrect the durable queue row deleteBookmark just removed.
  const chunkSize = BULK_CREATE_SYNC_CHUNK_SIZE;
  const rows = Array.from({ length: chunkSize + 2 }, (_, index) =>
    makeStoredBookmark({
      id: `ae64cf1e-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      url: `https://example.com/deleted-during-persist-${index + 1}`,
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
  // The whole first chunk fails; the last 2 rows are untried.
  apiMock.__spies.createBookmarks.mockRejectedValue(new Error('network down'));
  const deletedUntriedId = rows[chunkSize]!.id;
  const survivorUntriedId = rows[chunkSize + 1]!.id;

  // Gate the persist loop's first durable write (the first chunk-1 entry —
  // processed before any untried entry) so the delete below lands squarely
  // between the listQueue() snapshot and the loop reaching the untried entry.
  let releaseGate: () => void = () => { };
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let gateEnteredResolve: () => void = () => { };
  const gateEntered = new Promise<void>((resolve) => {
    gateEnteredResolve = resolve;
  });
  const originalUpdateQueueEntry = fakeRepo.repository.updateQueueEntry.bind(fakeRepo.repository);
  fakeRepo.repository.updateQueueEntry = async (entry) => {
    if (entry.local_id === rows[0]!.id) {
      gateEnteredResolve();
      await gate;
    }
    return originalUpdateQueueEntry(entry);
  };

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await gateEntered;

  await act(async () => {
    store.current!.deleteBookmark(deletedUntriedId);
  });

  releaseGate();

  await waitFor(() =>
    expect(
      store.current!.queue.every(
        (entry) => entry.sync_status !== 'pending' && entry.sync_status !== 'syncing',
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(store.current!.isSyncing).toBe(false));

  // Must stay gone — not resurrected by the untried-entry failure marking.
  expect(store.current!.getBookmark(deletedUntriedId)).toBeUndefined();
  await waitFor(() =>
    expect(fakeRepo.__queue().some((entry) => entry.local_id === deletedUntriedId)).toBe(false),
  );
  expect(fakeRepo.__bookmarks().some((bookmark) => bookmark.id === deletedUntriedId)).toBe(false);

  // The other untried entry (not deleted) is still correctly marked failed.
  expect(store.current!.getBookmark(survivorUntriedId)?.sync_status).toBe('failed');

  fakeRepo.repository.updateQueueEntry = originalUpdateQueueEntry;

  // Drain any deferred follow-up retry (see waitUntilSyncQuiescent) before
  // ending, or it fires during the NEXT test and consumes its shared mock
  // queue instead of this one's own (caught in PR review).
  await waitUntilSyncQuiescent(store, () => apiMock.__spies.createBookmarks.mock.calls.length);
});
