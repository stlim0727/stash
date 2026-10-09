import './helpers/ai-enrichment-harness';
import { act, waitFor } from '@testing-library/react-native';
import { apiMock, fakeRepo, mockHarness, renderStore, resetEnrichmentHarness, SYNCED_ID } from './helpers/ai-enrichment-harness';
import { makeStoredBookmark } from './helpers/fake-repository';

beforeEach(resetEnrichmentHarness);


test('re-hydrates a persisted deferred AI trigger and fires it after a restart', async () => {
  // Simulates: a create synced, then the app was killed during the metadata
  // fetch window. The marker was persisted; metadata is settled on relaunch.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The deferred trigger fires on launch (no manual tap needed)...
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      SYNCED_ID,
      expect.anything(),
      'en',
    ),
  );
  // ...and the durable marker is cleared once it succeeds, so it won't re-fire.
  await waitFor(() => expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]'));
});

test('a deferred first attempt keeps a durable marker throughout the in-flight window and on failure', async () => {
  // Regression: the deferred-trigger effect used to clear pending_ai_trigger
  // synchronously, before requestAiEnrichment even started — relying entirely
  // on armAiRetry (which only runs from requestAiEnrichment's own catch, after
  // a failure is observed) to arm the replacement bookkeeping. An app kill
  // mid-request (anywhere in the in-flight window below, before that catch
  // ever runs) left NEITHER marker durably recorded: this bookmark's
  // first-ever automatic enrichment attempt vanished with no trace for any
  // future relaunch to retry. This test never resolves the mocked request
  // until we explicitly fail it, so it can assert on the in-flight window
  // itself, not just the settled outcome.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  let reject!: (error: unknown) => void;
  const gate = new Promise((_resolve, r) => {
    reject = r;
  });
  gate.catch(() => { }); // silence the unhandled-rejection warning from the gate itself
  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    await gate; // simulates the live network round trip an app kill could land in
    throw new Error('unreachable');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  // The deferred trigger fires...
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());
  // ...but while the request is still in flight (the crash window), the
  // durable pending-trigger marker must NOT have been cleared yet: if the
  // process died right now, a relaunch still has a durable trace to retry.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));
  // Nor is the retry marker armed yet — armAiRetry only runs once the
  // failure is actually observed, further below.
  expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(false);

  // Now let the in-flight request actually fail.
  await act(async () => {
    reject(new Error('network died mid-request'));
    await Promise.resolve();
  });

  // Once it settles, armAiRetry has recorded the backoff-scheduled retry
  // marker...
  await waitFor(() => expect(store.current!.isAiSuggestionPostponed(SYNCED_ID)).toBe(true));
  // ...and the pending-trigger marker is now cleared too: its crash-safety
  // job (surviving from launch until the outcome is durably recorded) is
  // done, since the failure now has its own durable trace in
  // `ai_suggestion_retry`. Leaving it present here would let a relaunch
  // inside the backoff window rehydrate it and re-fire the request
  // immediately via the deferred-trigger effect, bypassing backoff entirely.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]');
});

test('a failed deferred first attempt awaits the retry-marker write landing before clearing the pending-trigger marker', async () => {
  // armAiRetry's retry-state write and clearPendingAiTrigger's pending-trigger
  // write must be a true sequence — the retry marker's write settled BEFORE
  // the pending-trigger write is even issued — not two unawaited
  // fire-and-forget writes started back to back. Otherwise a process kill
  // between them could still leave storage with the trigger cleared and the
  // retry marker's replacement write never having landed, reopening the exact
  // crash window this ordering exists to close.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const setMetaCalls: string[] = [];
  let releaseRetryWrite!: () => void;
  const retryWriteGate = new Promise<void>((resolve) => {
    releaseRetryWrite = resolve;
  });
  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const setMetaSpy = jest
    .spyOn(fakeRepo.repository, 'setMeta')
    .mockImplementation(async (key, value) => {
      setMetaCalls.push(key);
      if (key === 'ai_suggestion_retry') {
        await retryWriteGate; // hold this write open until the test releases it
      }
      return originalSetMeta(key, value);
    });

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('network died mid-request');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());

  // The retry-state write has been issued (armAiRetry ran and is awaiting its
  // own persistence) but is deliberately held open. If the two writes were
  // sequenced correctly, the pending-trigger write must not have been issued
  // yet at this point.
  await waitFor(() => expect(setMetaCalls).toContain('ai_suggestion_retry'));
  expect(setMetaCalls).not.toContain('pending_ai_trigger');
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));

  // Let the retry-state write land, and the rest of the catch block proceed.
  await act(async () => {
    releaseRetryWrite();
    await Promise.resolve();
    await Promise.resolve();
  });

  await waitFor(() => expect(setMetaCalls).toContain('pending_ai_trigger'));
  expect(setMetaCalls.indexOf('ai_suggestion_retry')).toBeLessThan(
    setMetaCalls.indexOf('pending_ai_trigger'),
  );
  await waitFor(() => expect(fakeRepo.__meta('pending_ai_trigger')).toBe('[]'));

  setMetaSpy.mockRestore();
});

test('a failed deferred first attempt keeps the pending-trigger marker if the retry-state write itself fails', async () => {
  // The swallow bug: persistAiRetryState's .catch always resolved, so
  // armAiRetry appeared to succeed even when repository.setMeta genuinely
  // rejected — letting clearPendingAiTrigger wipe the only durable marker with
  // nothing having actually landed on disk. armAiRetry must now know the write
  // failed and skip clearing the pending-trigger marker, so a relaunch inside
  // the backoff window still has a durable trace to retry from.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const originalSetMeta = fakeRepo.repository.setMeta.bind(fakeRepo.repository);
  const setMetaSpy = jest
    .spyOn(fakeRepo.repository, 'setMeta')
    .mockImplementation(async (key, value) => {
      if (key === 'ai_suggestion_retry') {
        throw new Error('disk full');
      }
      return originalSetMeta(key, value);
    });

  apiMock.__spies.requestEnrichment.mockImplementationOnce(async () => {
    throw new Error('network died mid-request');
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(apiMock.__spies.requestEnrichment).toHaveBeenCalled());

  // Let the in-flight attempt settle (it fails, armAiRetry's write rejects).
  await waitFor(() => expect(store.current!.isEnriching(SYNCED_ID)).toBe(false));

  // The retry-state write never landed...
  expect(fakeRepo.__meta('ai_suggestion_retry')).toBeNull();
  // ...so the pending-trigger marker must NOT have been cleared either —
  // otherwise this failed attempt would vanish with no durable trace for a
  // relaunch inside the backoff window to retry.
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));

  setMetaSpy.mockRestore();
});

test('does not consume a deferred AI trigger before the auth session is ready', async () => {
  // Cold start: storage (and the persisted marker) loads before auth restores.
  mockHarness.authSession = null;
  apiMock.__spies.listBookmarkIds.mockResolvedValue([SYNCED_ID]);
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([SYNCED_ID]));

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  await waitFor(() => expect(store.current?.getBookmark(SYNCED_ID)).toBeDefined());

  // With no session the effect must NOT fire or burn the marker — otherwise the
  // trigger would be lost when auth becomes ready.
  expect(apiMock.__spies.requestEnrichment).not.toHaveBeenCalled();
  expect(fakeRepo.__meta('pending_ai_trigger')).toBe(JSON.stringify([SYNCED_ID]));
});
