import './helpers/ai-enrichment-harness';
import { clearLogEntries, getLogEntries } from '@/observability/log-buffer';
import { AI_RATE_LIMITED, BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { apiMock, fakeRepo, mockEnsureAnonymousSession, mockHarness, mockSession, renderReady, renderStore, resetEnrichmentHarness, SECOND_SYNCED_ID, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


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

test('a 429 overflow-queue enqueue uses the freshly-ensured session, not a stale auth.session (STASH-49)', async () => {
  // Simulate a session that was refreshed AFTER the reactive `auth.session`
  // was last read (e.g. a token rotation mid-session): `ensureAnonymousSession()`
  // — which the request itself awaits before firing — resolves the CURRENT
  // token, while `auth.session` still reflects the stale one.
  //
  // `pending_ai_enrichment`'s insert policy requires `auth.uid() = user_id`,
  // so if the overflow-queue enqueue fell back to the stale `auth.session`
  // instead of reusing the session the request itself just proved current,
  // its JWT could resolve to a different auth context than the row it's
  // inserting for — and get rejected. That's exactly what happened in
  // production (STASH-49): every enqueue during a bulk import failed with
  // "new row violates row-level security policy for table
  // pending_ai_enrichment", because the enqueue read `auth.session` directly
  // instead of the `session` variable the request above it had just ensured.
  const freshSession = { ...mockSession, access_token: 'fresh-token' };
  mockHarness.authSession = { ...mockSession, access_token: 'stale-token' };
  mockEnsureAnonymousSession.mockResolvedValue(freshSession);
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(() => expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledTimes(1));
  const sessionsUsed = apiMock.__spies.createBookmarkApi.mock.calls.map(
    ([session]: [{ access_token: string }]) => session.access_token,
  );
  expect(sessionsUsed.length).toBeGreaterThan(0);
  expect(sessionsUsed.every((token: string) => token === 'fresh-token')).toBe(true);
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

test('a 429 enqueue failure logs session diagnostics for triage (STASH-4D/4E)', async () => {
  // STASH-49's fix (reuse the freshly-ensured `session`, not `auth.session`)
  // shipped, but production kept reporting the identical RLS-violation
  // failure on this exact insert. Since static review of the code found
  // nothing further wrong, the enqueue-failure log now carries enough about
  // the session actually used — its owning user id vs the reactive
  // `auth.session`'s, whether its token value matches auth.session's, whether
  // the JWT's own `sub` claim agrees with the session object's user id, and
  // whether it even has a token — to tell "wrong identity" from "stale
  // reference" from "empty token" apart on the next occurrence, instead of
  // guessing again.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  apiMock.__spies.enqueuePendingEnrichment.mockRejectedValueOnce(
    new Error('new row violates row-level security policy for table "pending_ai_enrichment"'),
  );
  clearLogEntries();

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(() => {
    const entry = getLogEntries().find((e) =>
      e.message.includes('pending_ai_enrichment enqueue failed'),
    );
    expect(entry).toBeDefined();
    // Field names deliberately avoid "token"/"auth"/"session"/"secret"/
    // "credential" — Sentry's default Data Scrubber redacts a whole log line
    // (this ships as one opaque string, not a structured object it can scrub
    // key-by-key) when it contains a value under one of those words, which is
    // exactly what happened to the first cut of this diagnostic (STASH-4F).
    expect(entry!.message).toContain(`"bookmarkId":"${SYNCED_ID}"`);
    expect(entry!.message).toContain('"enqueueOwnerId":"user-test"');
    expect(entry!.message).toContain('"jwtSubMatchesOwnerId"');
    expect(entry!.message).toContain('"ownerIsAnonymous"');
    expect(entry!.message).toContain('"reactiveOwnerId":"user-test"');
    expect(entry!.message).toContain('"bearerMatchesReactive"');
    expect(entry!.message).toContain('"bearerLength"');
    expect(entry!.message).toContain('"expiresAt"');
    expect(entry!.message).toContain('"secondsUntilExpiry"');
  });
});

test('a 429 enqueue failure that is an RLS violation (403) is retried once and succeeds (STASH-4J)', async () => {
  // STASH-4G/4H's diagnostics proved every occurrence has healthy session
  // identity; production DB logs then showed these landing in tight bursts
  // right alongside an unrelated Realtime logical-decoding slot restart — a
  // transient platform-level window, not a logic bug. The identical insert,
  // replayed moments later, succeeds. This test simulates exactly that: the
  // first enqueue attempt gets the real production error shape (a
  // SupabaseRequestError with status 403), the retry succeeds, and no
  // "enqueue failed" warning should be logged.
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  apiMock.__spies.enqueuePendingEnrichment
    .mockRejectedValueOnce(
      new SupabaseRequestError(
        'new row violates row-level security policy for table "pending_ai_enrichment"',
        403,
      ),
    )
    .mockResolvedValueOnce(undefined);
  clearLogEntries();

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(
    () => expect(apiMock.__spies.enqueuePendingEnrichment).toHaveBeenCalledTimes(2),
    { timeout: 8000 },
  );
  expect(
    getLogEntries().some((entry) => entry.message.includes('pending_ai_enrichment enqueue failed')),
  ).toBe(false);
}, 10000);

test('a 429 enqueue failure that is an RLS violation (403) logs after the retry also fails (STASH-4J)', async () => {
  const store = await renderReady();
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429);
  });
  const rlsError = new SupabaseRequestError(
    'new row violates row-level security policy for table "pending_ai_enrichment"',
    403,
  );
  apiMock.__spies.enqueuePendingEnrichment
    .mockRejectedValueOnce(rlsError)
    .mockRejectedValueOnce(rlsError);
  clearLogEntries();

  await act(async () => {
    await store.current!.requestAiEnrichment(SYNCED_ID);
  });

  await waitFor(
    () => {
      const entry = getLogEntries().find((e) =>
        e.message.includes('pending_ai_enrichment enqueue failed after retry'),
      );
      expect(entry).toBeDefined();
    },
    { timeout: 8000 },
  );
}, 10000);

test('a 429 revealing quota exhaustion pauses the auto dispatch queue for other bookmarks too (STASH-4K follow-up)', async () => {
  // A large backlog (e.g. a bulk import with hundreds of un-enriched
  // bookmarks) used to keep firing the staggered auto dispatch every 400ms
  // regardless of quota state, so once the daily/hourly cap was hit, every
  // remaining dispatch was a guaranteed repeat 429 — wasted battery/network
  // for a result already known. The first 429 should pause the drain
  // entirely, not just this one bookmark's own retry.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([SYNCED_ID, SECOND_SYNCED_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Several more 400ms-staggered ticks: without the cooldown gate, the
  // second queued bookmark would have dispatched (and succeeded, since the
  // mocked 429 above only fires once) well within this window.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);
});

test('the auto dispatch queue resumes once the quota cooldown elapses (STASH-4K follow-up)', async () => {
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([SYNCED_ID, SECOND_SYNCED_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Confirm the gate is actually holding before advancing time — otherwise
  // the assertion below would pass vacuously even with no gate at all.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);

  const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  try {
    await waitFor(() =>
      expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
        SECOND_SYNCED_ID,
        expect.anything(),
        'en',
      ),
    );
  } finally {
    dateNowSpy.mockRestore();
  }
});

test('an hourly-limit 429 uses the server-reported retry_after instead of the fixed fallback (Codex review, PR #655)', async () => {
  // The server computes retry_after exactly for hourly_limit (seconds until
  // the oldest hourly request leaves the window) — trusting it means the
  // queue can resume in, say, 30s instead of always waiting the fixed
  // 10-minute fallback that's sized for the case no retry_after was sent.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([SYNCED_ID, SECOND_SYNCED_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Well short of the 10-minute fixed fallback, but past the reported 30s.
  const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 35_000);
  try {
    await waitFor(() =>
      expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
        SECOND_SYNCED_ID,
        expect.anything(),
        'en',
      ),
    );
  } finally {
    dateNowSpy.mockRestore();
  }
});

test('a 429 sets aiQuotaExceeded with the reason and the server-reported reset time (STASH-4P follow-up)', async () => {
  // Settings/feedback-diagnostics visibility: distinct from the internal
  // aiQuotaCooldownUntil ref (which stays capped at a fixed ceiling for the
  // drain loop's own pacing), this display-only state should reflect the
  // server's real retry_after verbatim.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  const before = Date.now();
  await waitFor(() => expect(store.current!.aiQuotaExceeded).not.toBeNull());
  expect(store.current!.aiQuotaExceeded?.reason).toBe('hourly_limit');
  // ~30s out from when the 429 landed, not the far larger fixed fallback.
  const retryAt = store.current!.aiQuotaExceeded!.retryAt;
  expect(retryAt).toBeGreaterThanOrEqual(before + 29_000);
  expect(retryAt).toBeLessThan(before + 60_000);
});

test('aiQuotaExceeded clears once its server-reported reset time passes (STASH-4P follow-up)', async () => {
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current!.aiQuotaExceeded).not.toBeNull());

  const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 35_000);
  try {
    await waitFor(() => expect(store.current!.aiQuotaExceeded).toBeNull());
  } finally {
    dateNowSpy.mockRestore();
  }
});

test('aiQuotaExceeded clears when the session disappears, not just on an account switch (Codex review, PR #664)', async () => {
  // The account-switch effect only fires for a NEW user id, and the
  // drain-loop interval that otherwise expires this on its own timer stops
  // entirely while there's no session — so signing out (or a session
  // expiring with no replacement minted yet) must clear this independently,
  // or a departed account's quota state would show indefinitely.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.aiQuotaExceeded).not.toBeNull());

  // Session disappears with nothing minted to replace it yet.
  mockHarness.authSession = null;
  await act(async () => {
    rerender(undefined);
  });

  await waitFor(() => expect(result.current.aiQuotaExceeded).toBeNull());
});

test('aiQuotaExceeded clears when an anonymous account links to a real one under the same user id (Codex review, PR #664)', async () => {
  // OAuth linking preserves the user id while flipping is_anonymous false —
  // the account-switch effect (keyed on a CHANGED id) never fires for this,
  // and the session-loss effect never sees a null session either. Without a
  // dedicated check, a stale "exceeded" state from the old anonymous caps
  // (10/hr, 50/day) would linger even though the just-linked real account's
  // limits are much higher (30/hr, 500/day).
  const anonUser: { id: string; is_anonymous?: boolean } = { id: 'user-test', is_anonymous: true };
  mockHarness.authSession = { ...mockSession, user: anonUser };
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'hourly_limit', 30);
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.aiQuotaExceeded).not.toBeNull());

  // Link to a real account: same user id, is_anonymous flips false.
  const linkedUser: { id: string; is_anonymous?: boolean } = { id: 'user-test', is_anonymous: false };
  mockHarness.authSession = { ...mockSession, user: linkedUser };
  await act(async () => {
    rerender(undefined);
  });

  await waitFor(() => expect(result.current.aiQuotaExceeded).toBeNull());
});

test('a late 429 from a request started before linking does not repopulate aiQuotaExceeded after linking (Codex review round 2, PR #664)', async () => {
  // Sharper than the test above: there, linking completes strictly AFTER the
  // anonymous 429 already landed. Here the anonymous request is still in
  // flight WHEN linking completes, and only settles afterward with a 429
  // captured under the OLD anonymous session — id-only equality (linking
  // preserves the id) would otherwise let this late response repopulate
  // aiQuotaExceeded right after the link effect just cleared it.
  const anonUser: { id: string; is_anonymous?: boolean } = { id: 'user-test', is_anonymous: true };
  mockHarness.authSession = { ...mockSession, user: anonUser };
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  let releaseRequest: () => void = () => { };
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await requestGate;
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // The anonymous request for SYNCED_ID is now in flight, gated on the
  // promise above — it will not settle until releaseRequest() is called.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Link to a real account WHILE the anonymous request is still stuck.
  const linkedUser: { id: string; is_anonymous?: boolean } = { id: 'user-test', is_anonymous: false };
  mockHarness.authSession = { ...mockSession, user: linkedUser };
  await act(async () => {
    rerender(undefined);
  });
  expect(result.current.aiQuotaExceeded).toBeNull();

  // NOW let the stale anonymous request finally resolve with its 429.
  await act(async () => {
    releaseRequest();
    await Promise.resolve();
  });

  expect(result.current.aiQuotaExceeded).toBeNull();
});

test('a late 429 from a request started before session expiry does not repopulate aiQuotaExceeded (Codex review round 3, PR #664)', async () => {
  // Sharper still: session_expired (or a plain sign-out with nothing minted
  // yet) never touches lastSyncedUserId.current -- that ref is only reset by
  // an actual NEW sign-in -- so the id check alone still "matches" the
  // departed user. wasAnonymousRef.current also goes to null (no current
  // session at all), and null was previously coalesced to `false` --
  // accidentally "matching" a captured NON-anonymous session's
  // is_anonymous: false and letting the late 429 back in with no live
  // session to even own the resulting state.
  const realUser: { id: string; is_anonymous?: boolean } = { id: 'user-test', is_anonymous: false };
  mockHarness.authSession = { ...mockSession, user: realUser };
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  let releaseRequest: () => void = () => { };
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await requestGate;
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Session disappears WHILE the request is still stuck in flight.
  mockHarness.authSession = null;
  await act(async () => {
    rerender(undefined);
  });
  expect(result.current.aiQuotaExceeded).toBeNull();

  // NOW let the stale request finally resolve with its 429.
  await act(async () => {
    releaseRequest();
    await Promise.resolve();
  });

  expect(result.current.aiQuotaExceeded).toBeNull();
});

test('a quota cooldown armed for one account does not throttle a different account switched into (Codex review, PR #655)', async () => {
  // Each account has its own independent per-user AI quota server-side — a
  // cooldown armed for account A's exhausted quota must not silently block
  // up to 30 minutes of account B's unrelated AI work after a switch.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID, SECOND_SYNCED_ID]);
  fakeRepo.__reset([
    makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' }),
    makeStoredBookmark({ id: SECOND_SYNCED_ID, metadata_status: 'complete' }),
  ]);
  await fakeRepo.repository.setMeta(
    'pending_ai_trigger',
    JSON.stringify([SYNCED_ID, SECOND_SYNCED_ID]),
  );
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new SupabaseRequestError('Supabase request failed with HTTP 429', 429, 'daily_limit');
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  // Account A's first (and only, given mockImplementationOnce) dispatch hits
  // the 429 and arms the 30-minute daily cooldown.
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1));

  // Confirm the cooldown is actually holding SECOND_SYNCED_ID back before
  // switching accounts — otherwise the assertion below proves nothing.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledTimes(1);

  // Switch to a different real account (well short of the 30-minute cooldown
  // — real time has barely moved).
  mockHarness.authSession = { ...mockSession, user: { id: 'real-user-b' } };
  await act(async () => {
    rerender(undefined);
  });

  // The account switch also carries bookmarks over onto rehomed ids (a
  // separate, already-tested mechanism — see "an anon→real carried-over
  // bookmark..." above), so this doesn't assert on a specific id being
  // dispatched; it only proves dispatch resumes at all, beyond the single
  // pre-switch call. If the cooldown had leaked across the switch, this
  // count would stay frozen at 1 indefinitely (as already confirmed above,
  // pre-switch) rather than eventually growing once the rehome settles.
  await waitFor(
    () => expect(apiMock.__spies.requestEnrichment.mock.calls.length).toBeGreaterThan(1),
    { timeout: 5000 },
  );
});
