import './helpers/ai-enrichment-harness';
import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { apiMock, fakeRepo, fireForeground, makeSuccessEnrichment, mockHarness, mockSession, renderReady, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


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
  mockHarness.authSession = { ...mockSession, user: realUser };
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
  gate.catch(() => { }); // silence the unhandled-rejection warning from the gate itself
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
  gate.catch(() => { });
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
  mockHarness.authSession = { ...mockSession, user: realUser };
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

test('a bookmark still staged in the auto-dispatch burst queue keeps its place through an anon→real rehome (#692)', async () => {
  // Distinct from the retry-marker test above: this targets aiDispatchQueueRef
  // specifically (the staggered burst queue), not aiRetryState. Reuses the
  // STASH-4K 429-cooldown mechanism (see "pauses the auto dispatch queue for
  // other bookmarks too" above) to reliably freeze ANON_ID in .pending —
  // racing the real 400ms drain interval to catch it there would be flaky.
  //
  // SYNCED_ID dispatches first and 429s, arming the cooldown; ANON_ID sits
  // queued behind it, still pending, when the rehome happens. If the burst
  // queue isn't re-keyed (the #692 bug), the stale old ANON_ID lingers in
  // aiDispatchQueueRef.pending forever — a ghost entry alongside the
  // (correctly re-keyed) pendingAiTrigger's new id — inflating
  // processingStats.diagnostics.ai.todo by one phantom bookmark that no longer exists.
  const ANON_SYNCED_ID = '4d4d4d4d-0000-4000-8000-000000000004';
  const ANON_TARGET_ID = '5e5e5e5e-0000-4000-8000-000000000005';
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ANON_SYNCED_ID, ANON_TARGET_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({
      id: ANON_SYNCED_ID,
      url: 'https://example.com/anon-429-source',
      metadata_status: 'complete',
    }),
    makeStoredBookmark({
      id: ANON_TARGET_ID,
      url: 'https://example.com/anon-rehome-target',
      metadata_status: 'complete',
    }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([ANON_SYNCED_ID, ANON_TARGET_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Confirm the cooldown gate is actually holding ANON_TARGET_ID back before
  // rehoming — otherwise the assertions below would prove nothing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);
  expect(result.current.processingStats.diagnostics.ai.todo).toBe(2);

  // Sign in to a real account: both anon bookmarks carry over, re-homed onto
  // fresh ids.
  const realUser: { id: string; is_anonymous?: boolean } = {
    id: 'real-user',
    is_anonymous: false,
  };
  mockHarness.authSession = { ...mockSession, user: realUser };
  await act(async () => {
    rerender(undefined);
  });

  let rehomedTargetId = '';
  await waitFor(() => {
    const row = result.current.inbox.find(
      (b) => b.url === 'https://example.com/anon-rehome-target',
    );
    expect(row).toBeDefined();
    rehomedTargetId = row!.id;
  });
  expect(rehomedTargetId).not.toBe(ANON_TARGET_ID);

  // The count must stay at 2 — the same two bookmarks, just re-keyed. A
  // stale old ANON_TARGET_ID left behind in aiDispatchQueueRef.pending would
  // inflate this to 3.
  expect(result.current.processingStats.diagnostics.ai.todo).toBe(2);
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
