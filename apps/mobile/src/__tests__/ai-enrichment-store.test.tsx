import { act, render, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

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
// Mutable so a test can simulate a cold start where storage loads before the
// auth session is restored (session null). `mock`-prefixed so jest's factory
// hoisting allows referencing it.
let mockAuthSession: typeof mockSession | null = mockSession;

jest.mock('@/supabase/auth-provider', () => ({
  // `userId` is derived from `mockAuthSession` (rather than hardcoded) so a
  // test can simulate an account switch (e.g. anonymous → real) by mutating
  // the session and re-rendering — the store's sign-in/account-switch pull
  // effect is keyed off `auth.userId` changing. Every other existing test's
  // default (`mockAuthSession = mockSession`, user id 'user-test') is
  // unaffected: this simply reads the same id off it instead of repeating it.
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockAuthSession,
    userId: mockAuthSession?.user.id ?? null,
    message: null,
    ensureAnonymousSession: async () => mockAuthSession,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

// Fake foreground-state registration so tests can simulate an app
// background→foreground transition without depending on react-native's
// AppState mock (which the real `.native.ts` implementation subscribes to only
// once, module-wide — awkward to drive from a test). Mirrors the real
// module's shape; `mockForegroundHandlers` must keep the `mock` prefix so
// Jest's module-factory hoisting allows referencing it here.
let mockForegroundHandlers: Array<{
  onForeground?: () => void;
  onBackground?: () => void;
}> = [];
jest.mock('@/storage/sqlite-app-lifecycle', () => ({
  registerForForegroundState: (handler: { onForeground?: () => void; onBackground?: () => void }) => {
    mockForegroundHandlers.push(handler);
    return () => {
      mockForegroundHandlers = mockForegroundHandlers.filter((h) => h !== handler);
    };
  },
  registerForBackgroundClose: () => {},
}));

/** Simulate the app returning to the foreground: fires every registered
 *  `onForeground` callback (the loop-stall watchdog's and the AI-retry
 *  check's alike — both are inert/idempotent to call). */
function fireForeground() {
  for (const handler of [...mockForegroundHandlers]) {
    handler.onForeground?.();
  }
}

// Stub the network API: the enrichment "producer" and tag writes are spied,
// while the pull-sync list calls return nothing so mounting stays inert.
jest.mock('@/api/bookmarks', () => {
  const empty = async () => [];
  const requestEnrichment = jest.fn(async (bookmarkId: string) => ({
    id: 'enrichment-new',
    bookmark_id: bookmarkId,
    user_id: 'user-test',
    summary: 'Generated summary',
    topics: ['design'],
    suggested_tags: [{ name: 'design', confidence: 0.8 }],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: 0.8,
    degraded: false,
    degraded_reason: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
  }));
  const addTags = jest.fn(async ({ tags, source }: { tags: string[]; source: string }) =>
    tags.map((name) => ({
      id: `tag-${name}`,
      user_id: 'user-test',
      name,
      slug: name,
      source,
      created_at: '2026-06-13T00:00:00.000Z',
    })),
  );
  // Reconfigurable so a test can let the pull keep a seeded row in state
  // (the default empty list otherwise diffs it away as a remote deletion).
  const listBookmarkIds = jest.fn(async () => [] as string[]);
  // Sync upload: a create returns the remote id the local row adopts. Spied so
  // the auto-enrich-on-receive test can drive the full capture→sync→trigger path.
  const createBookmark = jest.fn(async () => ({
    bookmark_id: '7e64cf1e-0000-4000-8000-0000000000aa',
  }));
  // Pull's enrichment feed. Spied so a test can simulate another device
  // refreshing AI suggestions (a row arriving via pull rather than a local tap).
  const listEnrichmentsUpdatedSince = jest.fn(async () => [] as unknown[]);
  return {
    __spies: { requestEnrichment, addTags, listBookmarkIds, createBookmark, listEnrichmentsUpdatedSince },
    createBookmarkApi: () => ({
      requestEnrichment,
      addTags,
      createBookmark,
      listBookmarksUpdatedSince: empty,
      listBookmarkIds,
      listEnrichmentsUpdatedSince,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
    }),
  };
});

import { AI_RATE_LIMITED, BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import { SupabaseRequestError } from '@/supabase/client';
import { pendingSuggestions } from '@/domain/ai-suggestions';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeEnrichment, makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __spies: {
    requestEnrichment: jest.Mock;
    addTags: jest.Mock;
    listBookmarkIds: jest.Mock;
    createBookmark: jest.Mock;
    listEnrichmentsUpdatedSince: jest.Mock;
  };
};

const SYNCED_ID = '7e64cf1e-0000-4000-8000-000000000001';
// The remote id a synced create adopts (must match the mock's createBookmark).
const REMOTE_ID = '7e64cf1e-0000-4000-8000-0000000000aa';

type Store = ReturnType<typeof useBookmarks>;

function renderStore() {
  const ref: { current: Store | null } = { current: null };
  function Probe() {
    ref.current = useBookmarks();
    return null;
  }
  render(
    <BookmarksProvider>
      <Probe />
    </BookmarksProvider>,
  );
  return ref;
}

async function renderReady() {
  fakeRepo.__reset([makeStoredBookmark({ id: SYNCED_ID })]);
  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));
  // Let the initial pull settle so it can't overwrite state after our action.
  await waitFor(() => expect(store.current?.lastPulledAt).not.toBeNull());
  return store;
}

beforeEach(() => {
  mockAuthSession = mockSession;
  mockForegroundHandlers = [];
  apiMock.__spies.requestEnrichment.mockClear();
  apiMock.__spies.addTags.mockClear();
  apiMock.__spies.listBookmarkIds.mockReset();
  apiMock.__spies.listBookmarkIds.mockResolvedValue([]);
  apiMock.__spies.createBookmark.mockClear();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockReset();
  apiMock.__spies.listEnrichmentsUpdatedSince.mockResolvedValue([]);
});

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
  // path (addBookmark → create upload → remote-id swap → deferred trigger).
  fakeRepo.__reset([]);
  // The synced row must survive the pull's deletion diff (which would otherwise
  // treat an id it can't see remotely as a remote deletion).
  apiMock.__spies.listBookmarkIds.mockResolvedValue([REMOTE_ID]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await act(async () => {
    store.current!.addBookmark({ url: 'example.com/auto-suggest' });
  });

  // The create uploads and the local row adopts the remote id...
  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  // ...and the AI enrichment fires for it WITHOUT any manual requestAiEnrichment.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      REMOTE_ID,
      expect.anything(),
      'en',
    ),
  );
  await waitFor(() => expect(store.current!.getEnrichment(REMOTE_ID)).toBeDefined());
});

test('getBookmark still resolves a bookmark by its pre-sync local id after the create swaps it onto the remote id', async () => {
  // Regression: share a link, open its Detail immediately (navigated with the
  // local id), and moments later its create syncs — swapping the row's id from
  // local-* to the remote UUID. A Detail screen still holding the local id used
  // to read "this bookmark could not be found" until you backed out and
  // re-entered. getBookmark must follow the id alias so the live row resolves.
  fakeRepo.__reset([]);
  apiMock.__spies.listBookmarkIds.mockResolvedValue([REMOTE_ID]);

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  let localId = '';
  await act(async () => {
    const result = store.current!.addBookmark({ url: 'example.com/shared-then-opened' });
    if (result.status !== 'invalid') {
      localId = result.bookmark.id;
    }
  });
  expect(localId).toMatch(/^local-/);

  // The create uploads and the row adopts the remote id.
  await waitFor(() => expect(apiMock.__spies.createBookmark).toHaveBeenCalled());
  await waitFor(() => expect(store.current!.getBookmark(REMOTE_ID)?.id).toBe(REMOTE_ID));

  // The still-open Detail's stale local id now resolves to the same live row
  // instead of "not found".
  expect(store.current!.getBookmark(localId)?.id).toBe(REMOTE_ID);
});

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
  gate.catch(() => {}); // silence the unhandled-rejection warning from the gate itself
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
  mockAuthSession = null;
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
  expect(apiMock.__spies.addTags).toHaveBeenCalledWith(
    expect.objectContaining({ bookmark_id: SYNCED_ID, source: 'ai' }),
  );
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

// --- AI-suggestion retry bookkeeping (postponed state + backoff) ---

/** A minimal, valid AIEnrichment success response for retry tests. */
function makeSuccessEnrichment(bookmarkId: string) {
  return {
    id: 'enrichment-retry-success',
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
}

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

test('a synced create-leftover reconciliation keeps its AI-retry marker through the id swap', async () => {
  // Mirrors duplicate-id-swap.test.tsx's crash-recovery scenario: a create
  // uploaded (the queue entry is marked 'synced' with the new remote id) but
  // the app was killed before the local->remote id swap. syncNow's first step
  // reconciles that leftover — this is a bookmark-id swap like any other, so
  // it must carry the retry marker onto the reconciled id too.
  const LOCAL_ID = 'local-ai-retry-leftover';
  const localTwin = makeStoredBookmark({
    id: LOCAL_ID,
    url: 'https://example.com/leftover-retry',
    url_hash: 'https://example.com/leftover-retry',
    sync_status: 'pending',
  });
  fakeRepo.__reset([localTwin]);
  await fakeRepo.repository.setMeta(
    'ai_suggestion_retry',
    JSON.stringify({
      [LOCAL_ID]: {
        firstAttemptAt: '2026-06-01T00:00:00.000Z',
        lastAttemptAt: '2026-06-01T00:00:00.000Z',
        attemptCount: 1,
      },
    }),
  );
  apiMock.__spies.listBookmarkIds.mockResolvedValue([REMOTE_ID]);
  await fakeRepo.repository.enqueue({
    local_id: LOCAL_ID,
    remote_id: REMOTE_ID,
    operation: 'create',
    payload: { url: 'https://example.com/leftover-retry' },
    sync_status: 'synced',
    retry_count: 0,
    last_error: null,
    created_at: '2026-06-12T00:00:00.000Z',
    updated_at: '2026-06-12T00:00:00.000Z',
  });

  const store = renderStore();
  await waitFor(() => expect(store.current?.isLoading).toBe(false));

  await act(async () => {
    await store.current!.syncNow();
  });

  // The leftover reconciliation collapsed the local-* row onto REMOTE_ID...
  await waitFor(() => expect(store.current!.getBookmark(REMOTE_ID)?.id).toBe(REMOTE_ID));
  // ...and the retry marker followed it there instead of being stranded on
  // the now-dead local id.
  expect(store.current!.isAiSuggestionPostponed(REMOTE_ID)).toBe(true);
  expect(store.current!.isAiSuggestionPostponed(LOCAL_ID)).toBe(false);
});

test("a rehomed bookmark's create-upload swap still fires a fresh auto AI trigger, even though its old id already fired this session", async () => {
  // Regression for the aiTriggerAttempted-carry-forward bug: aiTriggerAttempted
  // is a session-only in-memory "already fired" dedupe set. The bug carried it
  // forward across every id swap, so a bookmark whose OLD id had already fired
  // once this session silently never got its fresh auto-trigger fired again
  // under its FINAL id — denying AI suggestions until an app restart. This
  // proves the actual behavior (a fresh requestEnrichment call for the new id)
  // fires, not just that the bookkeeping key moved.
  const ANON_REMOTE_ID = '3c3c3c3c-0000-4000-8000-000000000003';
  fakeRepo.__reset([makeStoredBookmark({ id: ANON_REMOTE_ID, metadata_status: 'complete' })]);
  await fakeRepo.repository.setMeta('pending_ai_trigger', JSON.stringify([ANON_REMOTE_ID]));
  apiMock.__spies.listBookmarkIds.mockResolvedValue([ANON_REMOTE_ID]);

  // Gate the rehomed row's re-issued create so the second swap doesn't
  // complete within the same act() as the rehome, letting the test observe
  // the intermediate rehomed-local-id state.
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  apiMock.__spies.createBookmark.mockImplementationOnce(async () => {
    await createGate;
    return { bookmark_id: REMOTE_ID };
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());

  // During the anonymous session, the deferred-trigger effect fires the
  // bookmark's first-ever auto attempt for ANON_REMOTE_ID — marking it
  // "already attempted this session", the exact in-memory state the bug used
  // to carry forward onto every subsequent id this bookmark takes on.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      ANON_REMOTE_ID,
      expect.anything(),
      'en',
    ),
  );

  // Sign in to a different (real) account: the anon bookmark carries over,
  // re-homed onto a fresh local id (the FIRST swap).
  const realUser: { id: string; is_anonymous?: boolean } = {
    id: 'real-user',
    is_anonymous: false,
  };
  mockAuthSession = { ...mockSession, user: realUser };
  await act(async () => {
    rerender(undefined);
  });

  let rehomedLocalId = '';
  await waitFor(() => {
    const row = result.current.inbox.find((b) => b.id !== ANON_REMOTE_ID);
    expect(row).toBeDefined();
    rehomedLocalId = row!.id;
  });
  expect(rehomedLocalId).toMatch(/^local-/);

  // Let the rehomed row's create upload complete: this swaps its id a SECOND
  // time, from the intermediate local id onto the new account's
  // server-assigned remote id.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([REMOTE_ID]);
  await act(async () => {
    releaseCreate();
    await Promise.resolve();
  });

  await waitFor(() => expect(result.current.getBookmark(REMOTE_ID)?.id).toBe(REMOTE_ID));

  // The bug would have carried ANON_REMOTE_ID's "already fired" flag all the
  // way onto REMOTE_ID, so the deferred-trigger effect would silently skip
  // firing for it. The fix drops the flag at every swap instead of moving it,
  // so a fresh auto trigger actually fires for the bookmark's final identity.
  await waitFor(() =>
    expect(apiMock.__spies.requestEnrichment).toHaveBeenCalledWith(
      REMOTE_ID,
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
  gate.catch(() => {}); // silence the unhandled-rejection warning from the gate itself
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
  gate.catch(() => {});
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

test('an anon→real carried-over bookmark keeps its retry marker through both id swaps (rehome, then its create upload)', async () => {
  // The rehome swap (anon remote id → new local id) already re-keys the retry
  // marker. That carried-over row then goes through the NORMAL create-upload
  // flow once its re-issued create syncs — swapping its local id onto the
  // account's server-assigned remote id a SECOND time. Both swaps must
  // preserve the marker.
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

  // Gate the rehomed row's re-issued create so the background-sync effect
  // (which auto-fires as soon as the rehome enqueues a pending entry) stalls
  // BEFORE the second swap, letting the test observe the intermediate
  // rehomed-local-id state instead of both swaps completing back-to-back
  // within the same act().
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  apiMock.__spies.createBookmark.mockImplementationOnce(async () => {
    await createGate;
    return { bookmark_id: REMOTE_ID };
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <BookmarksProvider>{children}</BookmarksProvider>;
  }
  const { result, rerender } = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(result.current.lastPulledAt).not.toBeNull());
  expect(result.current.isAiSuggestionPostponed(ANON_REMOTE_ID)).toBe(true);

  // Sign in to a different (real) account: the anon bookmark carries over,
  // re-homed onto a fresh local id (the FIRST swap).
  const realUser: { id: string; is_anonymous?: boolean } = {
    id: 'real-user',
    is_anonymous: false,
  };
  mockAuthSession = { ...mockSession, user: realUser };
  await act(async () => {
    rerender(undefined);
  });

  let rehomedLocalId = '';
  await waitFor(() => {
    const row = result.current.inbox.find((b) => b.id !== ANON_REMOTE_ID);
    expect(row).toBeDefined();
    rehomedLocalId = row!.id;
  });
  expect(rehomedLocalId).toMatch(/^local-/);

  // The retry marker followed the rehome swap onto the new local id.
  expect(result.current.isAiSuggestionPostponed(rehomedLocalId)).toBe(true);
  expect(result.current.isAiSuggestionPostponed(ANON_REMOTE_ID)).toBe(false);

  // Let the rehomed row's create upload complete: this swaps its id a SECOND
  // time, from the intermediate local id onto the new account's
  // server-assigned remote id.
  apiMock.__spies.listBookmarkIds.mockResolvedValue([REMOTE_ID]);
  await act(async () => {
    releaseCreate();
    await Promise.resolve();
  });

  await waitFor(() => expect(result.current.getBookmark(REMOTE_ID)?.id).toBe(REMOTE_ID));
  // The retry marker must have followed this SECOND swap too — not stranded
  // on the now-dead intermediate local id.
  expect(result.current.isAiSuggestionPostponed(REMOTE_ID)).toBe(true);
  expect(result.current.isAiSuggestionPostponed(rehomedLocalId)).toBe(false);
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
