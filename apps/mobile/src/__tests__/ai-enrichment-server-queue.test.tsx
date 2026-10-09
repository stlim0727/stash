import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, fireForeground, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


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

test('a server-queued marker clears when the queue worker gives up on the row (status: failed) (Codex review, PR #656)', async () => {
  // When the overflow worker exhausts MAX_ENRICHMENT_ATTEMPTS it marks the
  // remote row 'failed' and never revisits it -- no ai_enrichments row will
  // ever arrive for this bookmark, so the pull-based clear (the test above)
  // never fires. Without the periodic reconcile, isAiSuggestionServerQueued
  // would say "still queued" forever for a bookmark that can never complete.
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockResolvedValueOnce([
    { bookmark_id: SYNCED_ID, status: 'failed' },
  ]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);

  // The reconcile effect runs on foreground (like the retry checker).
  await act(async () => {
    fireForeground();
  });

  await waitFor(() =>
    expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false),
  );
  expect(apiMock.__spies.fetchPendingEnrichmentStatuses).toHaveBeenCalledWith([
    SYNCED_ID,
  ]);
});

test('a server-queued marker clears when its remote row no longer exists (Codex review, PR #656)', async () => {
  // A deleted bookmark cascades its pending_ai_enrichment row away -- the
  // reconcile query then simply returns nothing for that id, which must be
  // treated the same as an explicit 'failed' (never revive/hide it forever).
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockResolvedValueOnce([]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);

  await act(async () => {
    fireForeground();
  });

  await waitFor(() =>
    expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false),
  );
});

test('a server-queued marker stays put while the remote row is still pending/processing', async () => {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockResolvedValueOnce([
    { bookmark_id: SYNCED_ID, status: 'processing' },
  ]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    fireForeground();
  });
  await waitFor(() =>
    expect(apiMock.__spies.fetchPendingEnrichmentStatuses).toHaveBeenCalled(),
  );

  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);
});

test('a server-queued marker clears when the remote row is already done (Codex review, PR #660)', async () => {
  // A stale enqueue: a bookmark whose pending_ai_enrichment row the worker
  // already finished hits 429 again later (e.g. a manual "Refresh AI
  // suggestions" while quota is exhausted). enqueuePendingEnrichment's
  // ignore-duplicates resolves successfully against the existing 'done' row
  // without reviving it, so the client marks it server-queued anyway -- but
  // the worker will never revisit a 'done' row, and the existing
  // ai_enrichments row is unchanged (not newer), so no pull would ever clear
  // this the normal way either. 'done' must be treated as terminal here too.
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockResolvedValueOnce([
    { bookmark_id: SYNCED_ID, status: 'done' },
  ]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(true);

  await act(async () => {
    fireForeground();
  });

  await waitFor(() =>
    expect(store.current!.isAiSuggestionServerQueued(SYNCED_ID)).toBe(false),
  );
});

test('reconciling many terminal ids in one pass persists the removal once, not once per id (Codex review, PR #660)', async () => {
  // A device returning after many queued rows failed/disappeared must not
  // fan one setMeta write per id onto the single-connection SQLite actor --
  // the documented tail-wait contention pattern (STASH-3B, -3N, -3Y).
  const ids = Array.from(
    { length: 5 },
    (_, i) => `7e64cf1e-1111-4000-8000-00000000000${i}`,
  );
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify(ids));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockResolvedValueOnce(
    ids.map((bookmark_id) => ({ bookmark_id, status: 'failed' })),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  const setMetaSpy = jest.spyOn(fakeRepo.repository, 'setMeta');
  const callsBefore = setMetaSpy.mock.calls.filter(
    ([key]) => key === 'ai_server_queued',
  ).length;

  await act(async () => {
    fireForeground();
  });

  await waitFor(() => expect(fakeRepo.__meta('ai_server_queued')).toBe('[]'));
  const serverQueuedCalls = setMetaSpy.mock.calls.filter(
    ([key]) => key === 'ai_server_queued',
  ).length;
  expect(serverQueuedCalls - callsBefore).toBe(1);
  setMetaSpy.mockRestore();
});

test('reconciling more ids than the batch size splits the status check into chunks (Codex review, PR #660)', async () => {
  // A bulk-import-sized confirmed-queued backlog in one `bookmark_id=in.(...)`
  // query target runs well into tens of KB, which common HTTP gateways
  // reject as URI-too-long. 51 ids (one over the 50-per-chunk batch size)
  // must produce two calls, not one.
  const ids = Array.from({ length: 51 }, (_, i) => {
    const hex = i.toString(16).padStart(12, '0');
    return `7e64cf1e-2222-4000-8000-${hex}`;
  });
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  await fakeRepo.repository.setMeta('ai_server_queued', JSON.stringify(ids));
  apiMock.__spies.fetchPendingEnrichmentStatuses.mockImplementation(
    async (chunk: string[]) =>
      chunk.map((bookmark_id) => ({ bookmark_id, status: 'pending' })),
  );

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    fireForeground();
  });

  await waitFor(() =>
    expect(apiMock.__spies.fetchPendingEnrichmentStatuses).toHaveBeenCalledTimes(2),
  );
  const callSizes = apiMock.__spies.fetchPendingEnrichmentStatuses.mock.calls.map(
    ([chunk]: [string[]]) => chunk.length,
  );
  expect(callSizes.sort((a: number, b: number) => b - a)).toEqual([50, 1]);
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
