import './helpers/ai-enrichment-harness';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, renderReady, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


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
  expect(apiMock.__spies.bulkAttachTagsAndCollections).toHaveBeenCalledWith([
    expect.objectContaining({
      bookmark_id: SYNCED_ID,
      tags: [expect.objectContaining({ name: 'design', source: 'ai' })],
    }),
  ]);
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
