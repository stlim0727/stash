import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { LocalPendingBookmark } from '@/domain/types';
import { LAST_PULLED_AT_KEY, SYNCED_USER_ID_KEY } from '@/sync/pull-bookmarks';

jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);

// Controllable image-store double: copyImageToLibrary only resolves once
// `resolveCopyImageToLibrary` below is called, so a test can hold an image
// capture's durable-write chain open deliberately.
let resolveCopyImageToLibrary: ((uri: string) => void) | null = null;
const mockCopyImageToLibrary = jest.fn(
  (_sourceUri: string, fileName: string) =>
    new Promise<string>((resolve) => {
      resolveCopyImageToLibrary = (uri) => resolve(uri ?? `file:///docs/stash-images/${fileName}`);
    }),
);
jest.mock('@/storage/image-store', () => ({
  copyImageToLibrary: (sourceUri: string, fileName: string) =>
    mockCopyImageToLibrary(sourceUri, fileName),
  uploadImageFile: async () => {
    throw new Error('not stubbed for this test — irrelevant to what it checks');
  },
  localFileSizeBytes: () => 1024,
}));

// Authenticated real account throughout; individual tests flip it to
// signed_out to prove the reset is session-gated.
const realSession = {
  access_token: 'real-token',
  refresh_token: 'real-refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
};

jest.mock('@/supabase/auth-provider', () => {
  let state = {
    status: 'authenticated' as string,
    session: {
      access_token: 'real-token',
      refresh_token: 'real-refresh',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'real-user', is_anonymous: false, email: 'me@example.com' },
    } as unknown,
    userId: 'real-user' as string | null,
    message: null,
    ensureAnonymousSession: async () => state.session,
  };
  return {
    __setAuth: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
    useSupabaseAuth: () => state,
    SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
  };
});

// Sync/pull API mock: the remote mirrors the seeded local row so the initial
// same-user pull is a no-op, an update op FAILS fast (so a seeded pending edit
// settles as a durable 'failed' queue entry the reset must clear), and
// resetLibrary is a controllable jest.fn.
jest.mock('@/api/bookmarks', () => {
  let remote: Array<{ id: string }> = [];
  const empty = async () => [];
  const resetLibraryMock = jest.fn(async () => ({ bookmarks: 1 }));
  const updateBookmarkMock = jest.fn(async () => {
    throw new Error('update rejected (kept pending for the test)');
  });
  const createBookmarkMock = jest.fn(async (payload: { url?: string | null }) => ({
    id: 'new-remote-id',
    url: payload.url ?? null,
  }));
  const requestEnrichmentMock = jest.fn(async () => {
    throw new Error('requestEnrichment not stubbed for this test');
  });
  return {
    __setRemote: (rows: Array<{ id: string }>) => {
      remote = rows;
    },
    __resetLibraryMock: resetLibraryMock,
    __updateBookmarkMock: updateBookmarkMock,
    __createBookmarkMock: createBookmarkMock,
    __requestEnrichmentMock: requestEnrichmentMock,
    createBookmarkApi: () => ({
      listBookmarksUpdatedSince: empty,
      listBookmarkIds: async () => remote.map((row) => row.id),
      listEnrichmentsUpdatedSince: empty,
      listTags: empty,
      listBookmarkTags: empty,
      listCollections: empty,
      createBookmark: createBookmarkMock,
      updateBookmark: updateBookmarkMock,
      resetLibrary: resetLibraryMock,
      requestEnrichment: requestEnrichmentMock,
    }),
  };
});

jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));

import { BookmarksProvider, useBookmarks } from '@/store/bookmarks';
import {
  makeEnrichment,
  makeStoredBookmark,
  type FakeRepositoryModule,
} from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;
const authMock = jest.requireMock('@/supabase/auth-provider') as {
  __setAuth: (next: Record<string, unknown>) => void;
};
const apiMock = jest.requireMock('@/api/bookmarks') as {
  __setRemote: (rows: Array<{ id: string }>) => void;
  __resetLibraryMock: jest.Mock;
  __updateBookmarkMock: jest.Mock;
  __createBookmarkMock: jest.Mock;
  __requestEnrichmentMock: jest.Mock;
};

const REMOTE_ID = '1a2b3c4d-0000-4000-8000-00000000abcd';

function updateEntry(localId: string): LocalPendingBookmark {
  const now = '2026-06-12T10:00:00.000Z';
  return {
    local_id: localId,
    remote_id: localId,
    operation: 'update',
    payload: { url: 'https://example.com/edited' } as LocalPendingBookmark['payload'],
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <BookmarksProvider>{children}</BookmarksProvider>;
}

beforeEach(async () => {
  jest.clearAllMocks();
  // A real account with a synced cloud bookmark, cloud tag data, a queued edit
  // for it (which fails fast in the api mock, settling as a durable 'failed'
  // entry), and the synced-user meta + watermark a prior pull wrote.
  fakeRepo.__reset(
    [makeStoredBookmark({ id: REMOTE_ID })],
    {
      tags: [
        { id: 't1', user_id: 'real-user', name: 'tag', slug: 'tag', source: 'user', created_at: '2026' },
      ],
      bookmarkTags: [
        { bookmark_id: REMOTE_ID, tag_id: 't1', source: 'user', confidence: null, created_at: '2026' },
      ],
      collections: [],
    },
  );
  fakeRepo.__setMeta(SYNCED_USER_ID_KEY, 'real-user');
  fakeRepo.__setMeta(LAST_PULLED_AT_KEY, '2026-06-12T10:00:00.000Z');
  await fakeRepo.repository.enqueue(updateEntry(REMOTE_ID));
  apiMock.__setRemote([{ id: REMOTE_ID }]);
  authMock.__setAuth({ status: 'authenticated', session: realSession, userId: 'real-user' });
});

async function mountSettled() {
  const rendered = await renderHook(() => useBookmarks(), { wrapper });
  await waitFor(() => expect(rendered.result.current.isLoading).toBe(false));
  await waitFor(() => expect(rendered.result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID));
  // Let the startup sync settle: the queued edit fails fast and stays queued.
  await waitFor(() => expect(rendered.result.current.isSyncing).toBe(false));
  await waitFor(() =>
    expect(rendered.result.current.queue.some((e) => e.sync_status === 'failed')).toBe(true),
  );
  return rendered;
}

test('resetLibrary wipes remote via the RPC then clears local rows, queue, tag data, and the watermark', async () => {
  const { result } = await mountSettled();

  let outcome: Awaited<ReturnType<typeof result.current.resetLibrary>> | null = null;
  await act(async () => {
    outcome = await result.current.resetLibrary();
  });

  expect(outcome).toEqual({ ok: true });
  expect(apiMock.__resetLibraryMock).toHaveBeenCalledTimes(1);

  // In-memory and durable state are both empty.
  expect(result.current.inbox).toHaveLength(0);
  expect(result.current.queue).toHaveLength(0);
  expect(fakeRepo.__bookmarks()).toHaveLength(0);
  expect(fakeRepo.__queue()).toHaveLength(0);
  const tagData = await fakeRepo.repository.listTagData();
  expect(tagData.tags).toHaveLength(0);
  expect(tagData.bookmarkTags).toHaveLength(0);
  // Watermark reset so the next pull is a clean full refresh.
  expect(fakeRepo.__meta(LAST_PULLED_AT_KEY)).toBe('');
});

test('after a reset, the previously-queued work cannot re-upload to the just-emptied account', async () => {
  const { result } = await mountSettled();
  await act(async () => {
    await result.current.resetLibrary();
  });
  const updateCalls = apiMock.__updateBookmarkMock.mock.calls.length;
  const createCalls = apiMock.__createBookmarkMock.mock.calls.length;

  // An explicit sync after the reset finds nothing to upload: the failed edit
  // (and any other queued op) was cleared, not retried against the empty cloud.
  await act(async () => {
    await result.current.syncNow();
  });
  expect(apiMock.__updateBookmarkMock.mock.calls.length).toBe(updateCalls);
  expect(apiMock.__createBookmarkMock.mock.calls.length).toBe(createCalls);
  expect(fakeRepo.__queue()).toHaveLength(0);
});

test('a failed remote wipe changes nothing locally', async () => {
  const { result } = await mountSettled();
  apiMock.__resetLibraryMock.mockRejectedValueOnce(new Error('network down'));

  let outcome: Awaited<ReturnType<typeof result.current.resetLibrary>> | null = null;
  await act(async () => {
    outcome = await result.current.resetLibrary();
  });

  expect(outcome).toMatchObject({ ok: false, reason: 'remote' });
  // Local library untouched: bookmark, queued edit, and watermark all intact.
  expect(result.current.inbox.map((b) => b.id)).toContain(REMOTE_ID);
  expect(fakeRepo.__bookmarks().map((b) => b.id)).toContain(REMOTE_ID);
  expect(fakeRepo.__queue().map((e) => e.local_id)).toContain(REMOTE_ID);
  // The watermark was NOT reset (the startup pull may have advanced it, but a
  // failed reset must never blank it into a full-refresh state).
  expect(fakeRepo.__meta(LAST_PULLED_AT_KEY)).not.toBe('');
});

test('an AI enrichment in flight when the reset lands is discarded, not resurrected (PR #604 review)', async () => {
  const { result } = await mountSettled();

  // Start an enrichment request and hold its response open across the reset.
  let resolveEnrichment!: (value: unknown) => void;
  apiMock.__requestEnrichmentMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveEnrichment = resolve;
      }),
  );
  let requestPromise: Promise<string | null> = Promise.resolve(null);
  await act(async () => {
    requestPromise = result.current.requestAiEnrichment(REMOTE_ID);
  });
  expect(apiMock.__requestEnrichmentMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.resetLibrary();
  });

  // The in-flight request now settles successfully — AFTER the reset. Its
  // result must be dropped, not written into the just-cleared state.
  await act(async () => {
    resolveEnrichment(makeEnrichment({ bookmark_id: REMOTE_ID }));
    await requestPromise;
  });

  expect(result.current.getEnrichment(REMOTE_ID)).toBeUndefined();
  expect(await fakeRepo.repository.listEnrichments()).toHaveLength(0);
});

test('an AI enrichment FAILING after the reset arms no retry bookkeeping for the deleted bookmark', async () => {
  const { result } = await mountSettled();

  let rejectEnrichment!: (error: Error) => void;
  apiMock.__requestEnrichmentMock.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectEnrichment = reject;
      }),
  );
  let requestPromise: Promise<string | null> = Promise.resolve(null);
  await act(async () => {
    requestPromise = result.current.requestAiEnrichment(REMOTE_ID);
  });
  expect(apiMock.__requestEnrichmentMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    await result.current.resetLibrary();
  });

  await act(async () => {
    rejectEnrichment(new Error('edge function down'));
    await requestPromise;
  });

  // armAiRetry must NOT have written a retry marker for the wiped bookmark
  // ('ai_suggestion_retry' is the store's durable AI-retry meta key; the reset
  // itself persists an empty map).
  const retryMeta = fakeRepo.__meta('ai_suggestion_retry');
  expect(JSON.parse(retryMeta || '{}')).toEqual({});
});

test('a queued auto-dispatch for a bookmark that no longer exists is a no-op (no request fired)', async () => {
  const { result } = await mountSettled();
  await act(async () => {
    await result.current.resetLibrary();
  });

  // Simulate the stagger drain (or a stale retry check) dispatching an id
  // that the reset just deleted: requestAiEnrichment must refuse locally
  // without hitting the network.
  let outcome: string | null = 'unset';
  await act(async () => {
    outcome = await result.current.requestAiEnrichment(REMOTE_ID);
  });
  expect(outcome).toBeNull();
  expect(apiMock.__requestEnrichmentMock).not.toHaveBeenCalled();
});

test('resetLibrary refuses without a session (online-only, signed-in-only)', async () => {
  const { result, rerender } = await mountSettled();
  authMock.__setAuth({ status: 'signed_out', session: null, userId: null });
  await act(async () => {
    rerender(undefined);
  });

  let outcome: Awaited<ReturnType<typeof result.current.resetLibrary>> | null = null;
  await act(async () => {
    outcome = await result.current.resetLibrary();
  });

  expect(outcome).toMatchObject({ ok: false, reason: 'auth' });
  expect(apiMock.__resetLibraryMock).not.toHaveBeenCalled();
});

test('resetLibrary refuses while an import is still flushing in the background, instead of wiping mid-race', async () => {
  // resetLibrary's busy-guard used to only check syncInFlight, not
  // localCreateFlushesInFlight (the separate counter importBookmarks uses for
  // its own sequential durable-write loop). Without this, a reset landing
  // mid-import wiped storage via clearAllData() and the import's still-
  // running loop then kept calling insertBookmark/enqueue for its remaining
  // items — silently repopulating the "just cleared" library (user-reported:
  // "reset doesn't clear the queue in one shot").
  const { result } = await mountSettled();

  // Never-resolving on purpose: this test only needs the import's durable
  // write to still be in flight, not to ever complete.
  const originalInsertBookmark = fakeRepo.repository.insertBookmark;
  const neverResolves = new Promise<void>(() => {});
  fakeRepo.repository.insertBookmark = async (bookmark) => {
    await neverResolves;
    return originalInsertBookmark(bookmark);
  };

  await act(async () => {
    result.current.importBookmarks([
      { url: 'https://example.com/still-flushing', title: null, notes: null, tags: [], collection: null },
    ]);
  });

  let outcome: Awaited<ReturnType<typeof result.current.resetLibrary>> | null = null;
  await act(async () => {
    outcome = await result.current.resetLibrary();
  });

  // Refused outright — the pre-existing bookmark is untouched and the remote
  // wipe RPC was never even called, rather than a partial/racy clear.
  expect(outcome).toEqual({ ok: false, reason: 'busy' });
  expect(apiMock.__resetLibraryMock).not.toHaveBeenCalled();
  expect(fakeRepo.__bookmarks().map((b) => b.id)).toContain(REMOTE_ID);

  // Restore the real insertBookmark so it can't affect later tests. The
  // import's own durable write is deliberately left stuck mid-flight — this
  // test only needs to prove the refusal, not the import's eventual
  // completion (which would also retry this fixture's pre-seeded always-
  // failing update entry, an unrelated pre-existing retry-loop interaction
  // out of scope here).
  fakeRepo.repository.insertBookmark = originalInsertBookmark;
});

// Not really about resetLibrary — reuses this file's real-session/api-mock
// harness (the closest already-working fixture for exercising syncNow, the
// same shape reset's own busy-guard tests above already exercise) to prove
// the image-capture-vs-syncNow race a Codex review round flagged as P1.
test("syncNow defers while an image capture's durable write is still landing, instead of wiping it from state", async () => {
  // The image copy is a real (and, for a large photo, potentially slow) file
  // operation sitting between the optimistic setBookmarks/setQueue call and
  // the durable insert+enqueue that follows it — unlike URL/text captures,
  // which have no meaningful I/O in that gap. syncNow unconditionally
  // reloads bookmarks/queue from the repository and REPLACES React state
  // with that snapshot (deliberate, for account-transition correctness —
  // see the comment above reconcileAccountTransition in syncNow). Without
  // localCreateFlushesInFlight gating it here the same way it already gates
  // a bulk import's own flush (see the busy-guard tests above), a syncNow
  // landing mid-copy would wipe the just-captured image straight out of the
  // UI — recoverable on disk, but gone from the screen and out of live sync
  // tracking until the next full reload, which looks exactly like data loss.
  const { result } = await mountSettled();

  let addResult: ReturnType<typeof result.current.addBookmark> | undefined;
  await act(async () => {
    addResult = result.current.addBookmark({
      image: { uri: 'file:///tmp/share/shot.png', mimeType: 'image/png', fileName: 'shot.png' },
    });
  });
  if (!addResult || addResult.status !== 'created') {
    throw new Error(`expected addBookmark to report 'created', got ${JSON.stringify(addResult)}`);
  }
  const imageId = addResult.bookmark.id;

  // The image renders optimistically, but its durable write (the copy) is
  // deliberately still in flight — resolveCopyImageToLibrary hasn't fired.
  expect(result.current.inbox.map((b) => b.id)).toContain(imageId);

  // A syncNow call landing in exactly this window must defer, not run.
  let syncOutcome: boolean | null = null;
  await act(async () => {
    syncOutcome = await result.current.syncNow();
  });
  expect(syncOutcome).toBe(false);

  // Critically: the just-captured image must still be there — syncNow did
  // NOT reload from the repository and replace state with a snapshot that
  // doesn't have it yet.
  expect(result.current.inbox.map((b) => b.id)).toContain(imageId);

  // Let the copy (and the durable insert+enqueue that follows it) finish.
  await act(async () => {
    resolveCopyImageToLibrary?.('file:///docs/stash-images/shot.png');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // The row lands durably and stays visible, and its real create entry gets
  // queued — nothing was lost, and sync self-resumes once it's safe to run.
  await waitFor(() => expect(fakeRepo.__bookmarks().map((b) => b.id)).toContain(imageId));
  await waitFor(() => expect(fakeRepo.__queue().some((e) => e.local_id === imageId)).toBe(true));
  expect(result.current.inbox.map((b) => b.id)).toContain(imageId);
});
