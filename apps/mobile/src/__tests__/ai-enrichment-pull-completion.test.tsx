import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderReady, renderStore, resetEnrichmentHarness, SECOND_SYNCED_ID, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


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

test('a sync pull batches many unseen suggestions into one durable meta write (STASH-6G)', async () => {
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID }),
  ]);
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  let unseenWrites = 0;
  fakeRepo.repository.setMeta = async (key, value) => {
    if (key === 'unseen_ai_suggestions') unseenWrites += 1;
    await originalSetMeta(key, value);
  };

  try {
    const store = renderStore();
    await waitFor(() => expect(store.current?.isLoading).toBe(false));
    await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
    apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValueOnce([
      makeEnrichment({
        id: 'enrich-unseen-1',
        bookmark_id: SYNCED_ID,
        suggested_tags: [{ name: 'design', confidence: 0.9 }],
      }),
      makeEnrichment({
        id: 'enrich-unseen-2',
        bookmark_id: SECOND_SYNCED_ID,
        suggested_tags: [{ name: 'research', confidence: 0.9 }],
      }),
    ]);

    await act(async () => {
      await store.current!.syncNow();
    });

    expect(store.current!.unseenSuggestionIds).toEqual(
      new Set([SYNCED_ID, SECOND_SYNCED_ID]),
    );
    expect(unseenWrites).toBe(1);
  } finally {
    fakeRepo.repository.setMeta = originalSetMeta;
  }
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
