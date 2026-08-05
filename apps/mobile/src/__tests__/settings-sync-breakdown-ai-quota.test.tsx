import { act, render, waitFor } from '@testing-library/react-native';
import { LayoutAnimation } from 'react-native';
import type { ReactNode } from 'react';

// Sentry STASH-4W: the AI-suggestions breakdown row must swap in
// "quota reached" copy (no reset time — that's already shown elsewhere, see
// settings.aiQuotaExceeded) once a live 429 sets `aiQuotaExceeded`. Driving
// that state for real needs an authenticated session and a mocked API (the
// same harness ai-enrichment-store.test.tsx uses), which is heavier than the
// no-session harness in settings-sync-breakdown.test.tsx covers the rest of
// the STASH-4W logic — split into its own file for that reason.
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
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
    isSignedIn: true,
    userId: mockSession.user.id,
    email: null,
    displayName: null,
    avatarUrl: null,
    message: null,
    signIn: jest.fn(async () => ({ ok: true })),
    signOut: jest.fn(async () => {}),
    ensureAnonymousSession: jest.fn(async () => mockSession),
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

// Never resolves: keeps a metadata-pending fixture stable (see the same note
// in settings-sync-breakdown.test.tsx) — this file also needs it to keep a
// freshly-added bookmark's own metadata pending for the duration of the test.
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: () => new Promise(() => {}),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: 'enrichment-new',
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
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  }));
  const addTags = jest.fn(async ({ tags, source }: { tags: string[]; source: string }) =>
    tags.map((name) => ({
      id: `tag-${name}`,
      user_id: 'user-test',
      name,
      slug: name,
      source,
      created_at: '2026-08-03T00:00:00.000Z',
    })),
  );
  const updateBookmark = jest.fn(async () => undefined);
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  // Never resolves: keeps a freshly-queued create's sync_status 'pending'
  // (isSyncable) for the whole test, so the "Waiting to upload" stage stays
  // non-zero.
  const createBookmark = jest.fn(() => new Promise(() => {}));
  const createBookmarks = jest.fn(
    async (inputs: Array<{ id?: string }>) =>
      inputs.map((input) => ({
        bookmark_id: input.id ?? '00000000-0000-4000-8000-000000000000',
        status: 'created' as const,
        metadata_status: 'pending' as const,
      })),
  );
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  const enqueuePendingEnrichment = jest.fn(async () => {});
  const fetchPendingEnrichmentStatuses = jest.fn(
    async (bookmarkIds: string[]) =>
      bookmarkIds.map((bookmark_id) => ({ bookmark_id, status: 'pending' })),
  );
  const createBookmarkApi = jest.fn(() => ({
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
    fetchPendingEnrichmentStatuses,
  }));
  return {
    __spies: { requestEnrichment, createBookmark, listBookmarkIds },
    createBookmarkApi,
  };
});

import SettingsScreen from '@/app/settings';
import { AI_SUGGESTIONS_MODE_PREF_KEY } from '@/domain/ai-suggestions-pref';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { makeStoredBookmark, type FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: { requestEnrichment: jest.Mock; createBookmark: jest.Mock; listBookmarkIds: jest.Mock };
};

const AI_TRIGGER_ID = '7e64cf1e-0000-4000-8000-000000000001';
const METADATA_PENDING_ID = '7e64cf1e-0000-4000-8000-000000000002';

type Store = ReturnType<typeof useBookmarks>;

/** Mirrors settings.tsx's formatQuotaResetTime (not exported) so the
 *  quota-reached chip's reset-time text can be asserted without duplicating
 *  its own display-formatting decision as a second, possibly-drifting
 *  implementation. Locale is fixed 'en' — these tests never set a language
 *  preference, so the store falls back to it. */
function expectedResetTime(retryAt: number): string {
  const isToday = new Date(retryAt).toDateString() === new Date().toDateString();
  return new Date(retryAt).toLocaleString(
    'en',
    isToday
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeRepo.__reset([]);
});

test('AI quota reached: the AI chip swaps to a visually distinct quota-reached chip (no count, timer icon), alongside the metadata chip (STASH-4W, docs/design/settings-activity-status.md)', async () => {
  fakeRepo.__reset([
    makeStoredBookmark({ id: AI_TRIGGER_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: METADATA_PENDING_ID, metadata_status: 'pending' }),
  ]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([AI_TRIGGER_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  // Let the startup pull settle first (mirrors sync-paused.test.tsx) so its
  // own state updates land before the test proceeds, instead of leaking into
  // later act() batches.
  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  // The deferred auto-AI-trigger effect fires requestAiEnrichment on mount
  // (pending_ai_trigger is seeded and the bookmark's metadata is already
  // complete), which 429s and sets aiQuotaExceeded.
  await waitFor(() => expect(storeRef.current!.aiQuotaExceeded).not.toBeNull());

  // Now queue a second, unrelated create — its upload hangs (mocked
  // createBookmark never resolves), keeping the headline's waiting count
  // non-zero for the rest of the test without racing the AI dispatch loop
  // (which defers AI work until the sync queue is clear — see the
  // deferred-dispatch effect).
  await act(async () => {
    storeRef.current!.addBookmark({ url: 'https://example.com/still-uploading' });
  });

  await waitFor(() => expect(screen.getByText('1 item waiting to upload')).toBeTruthy());
  // No "Waiting to upload" chip ever renders — the headline above already
  // reports that same count (the redesign's whole point).
  expect(screen.queryByText('Waiting to upload')).toBeNull();
  expect(screen.getByText('Fetching info')).toBeTruthy();
  // Metadata count is 2 here: METADATA_PENDING_ID plus the freshly-added
  // "still-uploading" bookmark, which also starts metadata_status 'pending'
  // (not yet enriched).
  expect(screen.getByText('· 2')).toBeTruthy();
  // The AI chip drops its bare "AI suggestions" label entirely once quota is
  // reached, swapping to the distinct chip's own copy — so only the
  // Preferences mode-selector row's own label matches "AI suggestions" now.
  await waitFor(() => expect(screen.getAllByText('AI suggestions')).toHaveLength(1));
  // The chip is a single pill (no room for the hourly/daily/generic reason
  // text), but the reset time itself is always accurate
  // (`request_ai_enrichment_slot`'s `retry_after`, STASH-4P follow-up) and
  // small enough to fit — restored after a #698 regression dropped it.
  const resetTime = expectedResetTime(storeRef.current!.aiQuotaExceeded!.retryAt);
  expect(screen.getByText(`AI suggestions · resumes at ${resetTime}`)).toBeTruthy();
  // Distinct icon (not the normal hourglass) confirms the visually-different
  // chip, not just different text on the same neutral pill.
  expect(screen.getByTestId('chip-icon-timer-outline')).toBeTruthy();
});

test('a manual "Suggest with AI" request in flight is counted even though it never joined the trigger/dispatch/retry sets (Codex review, PR #670)', async () => {
  const MANUAL_ID = '7e64cf1e-0000-4000-8000-000000000003';
  fakeRepo.__reset([makeStoredBookmark({ id: MANUAL_ID, metadata_status: 'complete' })]);
  // Never resolves: requestAiEnrichment adds the id to `enrichingIds` (and,
  // for a manual call, `manualEnrichingIds`) before awaiting the API call —
  // neither the trigger set, the dispatch queue, nor aiRetryIds ever see
  // this id, since none of those producers are involved in a direct manual
  // call. Before this fix, diagnosticStats.ai.todo stayed 0 for the whole
  // window this request is in flight.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(() => new Promise(() => {}));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(MANUAL_ID);
  });
  await waitFor(() => expect(storeRef.current!.isEnriching(MANUAL_ID)).toBe(true));

  // Nothing else is active — uploads are done and metadata is already
  // complete — so this is a lone AI chip, and per the earlier fix (a lone
  // non-upload pipeline must still show) it renders on its own.
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  expect(screen.getByText('· 1')).toBeTruthy();
});

test('a manual AI request stays visible even when aiSuggestionsMode is "off" — manual calls are not gated on that preference (Codex review, PR #670)', async () => {
  const MANUAL_ID = '7e64cf1e-0000-4000-8000-000000000004';
  fakeRepo.__reset([makeStoredBookmark({ id: MANUAL_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, 'off');
  // Never resolves, same as the sibling test above — keeps the manual
  // request "in flight" for the duration of the assertions.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(() => new Promise(() => {}));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(MANUAL_ID);
  });
  await waitFor(() => expect(storeRef.current!.isEnriching(MANUAL_ID)).toBe(true));

  // Before the underlying fix, the breakdown's `aiSuggestionsMode === "off"`
  // branch zeroed the count unconditionally, hiding this in-flight manual
  // request and leaving the headline at "All backed up" with no trace of
  // real work. The chip now stays visible with the in-flight request's count
  // (1) even though local auto-dispatch is off — the compact chip form
  // doesn't spell out the "off"/"paused" reason text the old full-sentence
  // row did (docs/design/settings-activity-status.md §3), but the count
  // itself must still reflect this manual request.
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());
  expect(screen.getAllByText('AI suggestions')).toHaveLength(2);
  expect(screen.getByText('· 1')).toBeTruthy();
});

test('manually retrying a bookmark already in the local AI backlog is not double-counted (Codex review, PR #670)', async () => {
  const OVERLAP_ID = '7e64cf1e-0000-4000-8000-000000000005';
  fakeRepo.__reset([makeStoredBookmark({ id: OVERLAP_ID, metadata_status: 'complete' })]);
  // Seeded into the local backlog (pendingAiTrigger) — while the manual
  // request below is in flight, this id is NOT removed from
  // pendingAiTrigger.current (that only happens in requestAiEnrichment's
  // settle/failure handlers), so it's simultaneously present in the backlog
  // union AND enrichingIds — exactly the Detail-button-bypasses-backoff
  // overlap the fix guards against.
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([OVERLAP_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(() => new Promise(() => {}));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(OVERLAP_ID);
  });
  await waitFor(() => expect(storeRef.current!.isEnriching(OVERLAP_ID)).toBe(true));

  // Before this fix (additive aiBacklogCount + manualInFlight), this would
  // have read "· 2" for one bookmark present in both sets.
  await waitFor(() => expect(screen.getByText('All backed up')).toBeTruthy());
  expect(screen.getByText('· 1')).toBeTruthy();
  expect(screen.queryByText('· 2')).toBeNull();
});

test('an automatic AI request already executing stays visible when sync pauses mid-run, even though the not-yet-dispatched local backlog is frozen (Codex review, PR #670)', async () => {
  const AUTO_INFLIGHT_ID = '7e64cf1e-0000-4000-8000-000000000006';
  fakeRepo.__reset([makeStoredBookmark({ id: AUTO_INFLIGHT_ID, metadata_status: 'complete' })]);
  // Never resolves: simulates an AUTOMATIC dispatch already executing
  // (source: 'auto', not 'manual') — populates enrichingIds only, same as a
  // real dispatched-then-in-flight request (dequeueAiEnrichmentDispatch
  // removes it from aiDispatchQueueRef.current.pending the moment dispatch
  // starts, so by the time it's executing it's no longer in the backlog
  // union either).
  apiMock.__spies.requestEnrichment.mockImplementationOnce(() => new Promise(() => {}));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(AUTO_INFLIGHT_ID, 'auto');
  });
  await waitFor(() => expect(storeRef.current!.isEnriching(AUTO_INFLIGHT_ID)).toBe(true));

  // Now pause sync with a pending upload queued — this freezes local AI
  // dispatch (per the drain loop's own gate), but must NOT hide the request
  // that's already executing.
  await act(async () => {
    storeRef.current!.addBookmark({ url: 'https://example.com/still-uploading' });
    storeRef.current!.setSyncPaused(true);
  });
  await waitFor(() => expect(storeRef.current!.syncPaused).toBe(true));

  // Before the underlying fix, pausing here would have replaced the AI count
  // with `serverQueued` alone (0), hiding the already-running automatic
  // request. The freshly-added bookmark also has metadata_status 'pending'
  // (a fresh capture, not yet enriched), so the metadata chip independently
  // reads "· 1". The AI chip's own count is 1 too (the in-flight request).
  await waitFor(() => expect(screen.getByText('Paused — 1 item waiting')).toBeTruthy());
  expect(screen.getByText('Fetching info')).toBeTruthy();
  expect(screen.getAllByText('AI suggestions').length).toBeGreaterThanOrEqual(1);
  expect(screen.getAllByText('· 1')).toHaveLength(2);
});

test('a chip inserting into an already-mounted strip animates via LayoutAnimation (docs/design/settings-activity-status.md §2.1)', async () => {
  const METADATA_ONLY_ID = '7e64cf1e-0000-4000-8000-000000000007';
  const MANUAL_ID = '7e64cf1e-0000-4000-8000-000000000008';
  fakeRepo.__reset([
    makeStoredBookmark({ id: METADATA_ONLY_ID, metadata_status: 'pending' }),
    makeStoredBookmark({ id: MANUAL_ID, metadata_status: 'complete' }),
  ]);
  // Never resolves — keeps the manual request "in flight" for the assertions.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(() => new Promise(() => {}));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const configureNextSpy = jest.spyOn(LayoutAnimation, 'configureNext');

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());
  // The strip is already mounted with just the metadata chip before the AI
  // chip ever exists.
  await waitFor(() => expect(screen.getByText('Fetching info')).toBeTruthy());
  expect(screen.queryByTestId('activity-chip-ai')).toBeNull();

  configureNextSpy.mockClear();
  await act(async () => {
    void storeRef.current!.requestAiEnrichment(MANUAL_ID);
  });
  await waitFor(() => expect(screen.getByTestId('activity-chip-ai')).toBeTruthy());

  // The AI chip inserting into the ALREADY-mounted strip (metadata chip stays
  // put) goes through LayoutAnimation, not the strip's own scoped `Animated`
  // mount transition.
  expect(configureNextSpy).toHaveBeenCalled();
});

test('a rate-limited-degraded enrichment surfaces the "Basic suggestions shown" chip, with the reused wording, refresh icon, and no other chip active', async () => {
  const DEGRADED_ID = '7e64cf1e-0000-4000-8000-000000000009';
  fakeRepo.__reset([makeStoredBookmark({ id: DEGRADED_ID, metadata_status: 'complete' })]);
  // The Gemini provider itself hit RESOURCE_EXHAUSTED — the server served
  // heuristic suggestions but still returns HTTP 200, so `aiQuotaExceeded`
  // (429-only) never fires; this is a *separate* signal carried on the
  // enrichment row itself.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-degraded',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'heuristic-v0',
    status: 'complete',
    confidence: null,
    degraded: true,
    degraded_reason: 'rate_limited',
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  }));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());
  expect(screen.queryByTestId('activity-chip-degraded')).toBeNull();

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(DEGRADED_ID);
  });

  await waitFor(() =>
    expect(storeRef.current!.diagnosticStats.ai.degradedRateLimited).toBe(1),
  );
  await waitFor(() => expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy());
  expect(screen.getByText('Basic suggestions shown')).toBeTruthy();
  expect(screen.getByText('· 1')).toBeTruthy();
  expect(screen.getByTestId('chip-icon-refresh-outline')).toBeTruthy();
});

test('the degraded-results chip hides again ~2s after the count returns to 0, the same debounce every other Activity chip uses', async () => {
  jest.useFakeTimers();
  const DEGRADED_ID = '7e64cf1e-0000-4000-8000-000000000010';
  fakeRepo.__reset([makeStoredBookmark({ id: DEGRADED_ID, metadata_status: 'complete' })]);
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-degraded',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'heuristic-v0',
    status: 'complete',
    confidence: null,
    degraded: true,
    degraded_reason: 'rate_limited',
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  }));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(DEGRADED_ID);
  });
  await waitFor(() =>
    expect(storeRef.current!.diagnosticStats.ai.degradedRateLimited).toBe(1),
  );
  await waitFor(() => expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy());

  // The background worker's real-model retry lands: same bookmark, this time
  // clean (not degraded) — the count drops back to 0.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-clean',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'Real summary',
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: 0.9,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-08-03T00:05:00.000Z',
    updated_at: '2026-08-03T00:05:00.000Z',
  }));
  await act(async () => {
    void storeRef.current!.requestAiEnrichment(DEGRADED_ID);
  });
  await waitFor(() =>
    expect(storeRef.current!.diagnosticStats.ai.degradedRateLimited).toBe(0),
  );

  // Immediately after the count drops, the chip is still visible (debounced,
  // not an instant unmount).
  expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy();

  await act(async () => {
    jest.advanceTimersByTime(1999);
  });
  expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy();

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  await waitFor(() => expect(screen.queryByTestId('activity-chip-degraded')).toBeNull());

  jest.useRealTimers();
});

test('all three Activity chips (metadata, AI, degraded-results) can be visible together without breaking the wrap layout', async () => {
  const METADATA_ID = '7e64cf1e-0000-4000-8000-000000000011';
  const AI_TRIGGER_ID_2 = '7e64cf1e-0000-4000-8000-000000000012';
  const DEGRADED_ID = '7e64cf1e-0000-4000-8000-000000000013';
  fakeRepo.__reset([
    makeStoredBookmark({ id: METADATA_ID, metadata_status: 'pending' }),
    makeStoredBookmark({ id: AI_TRIGGER_ID_2, metadata_status: 'complete' }),
    makeStoredBookmark({ id: DEGRADED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([AI_TRIGGER_ID_2]));
  // The auto-trigger for AI_TRIGGER_ID_2 429s (sets aiQuotaExceeded, driving
  // the AI chip); a manual request for DEGRADED_ID comes back degraded
  // (driving the new chip) — both alongside the pending-metadata chip.
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async (bookmarkId: string) => ({
    id: 'enrichment-degraded',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'heuristic-v0',
    status: 'complete',
    confidence: null,
    degraded: true,
    degraded_reason: 'rate_limited',
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  }));

  const storeRef: { current: Store | null } = { current: null };
  function Probe() {
    storeRef.current = useBookmarks();
    return null;
  }

  const screen = await render(
    <BookmarksProvider>
      <Probe />
      <SettingsScreen />
    </BookmarksProvider>,
  );

  await waitFor(() => expect(storeRef.current?.isLoading).toBe(false));
  await waitFor(() => expect(storeRef.current?.lastPulledAt).not.toBeNull());
  await waitFor(() => expect(storeRef.current!.aiQuotaExceeded).not.toBeNull());

  await act(async () => {
    void storeRef.current!.requestAiEnrichment(DEGRADED_ID);
  });

  await waitFor(() => expect(screen.getByTestId('activity-chip-metadata')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('activity-chip-ai')).toBeTruthy());
  await waitFor(() => expect(screen.getByTestId('activity-chip-degraded')).toBeTruthy());
  expect(screen.getByTestId('activity-strip')).toBeTruthy();
});
