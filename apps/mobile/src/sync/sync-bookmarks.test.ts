import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UPLOAD_RETRY_BACKOFF_MS,
  applySyncQueueHealthEscalation,
  createNeedsReconcileUpdate,
  didSyncQueueHealthEscalate,
  findStaleQueueEntries,
  hasBulkCreateResultKey,
  hasRemoteIdentity,
  isSyncable,
  makeMutationEntry,
  mergeSyncedBookmarkFields,
  reconcileOrphanedQueueEntries,
  syncCreateQueueEntryBatch,
  syncErrorKind,
  syncQueueEntry,
  uploadRetryBackoffMs,
} from './sync-bookmarks.ts';
import { BOOKMARK_NOT_FOUND_ERROR_MESSAGE } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, CreateBookmarkInput, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';
import { SupabaseRequestError } from '@/supabase/client';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'local-abc',
    user_id: 'user-test',
    url: 'https://example.com/a',
    canonical_url: null,
    url_hash: 'https://example.com/a',
    title: null,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    sync_status: 'pending',
    ...overrides,
  } as Bookmark;
}

function makeCreateEntry(overrides: Partial<LocalPendingBookmark> = {}): LocalPendingBookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    local_id: 'local-abc',
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://example.com/a' },
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function fakeRepository(storedQueue: LocalPendingBookmark[] = []) {
  const calls: string[] = [];
  const repository: BookmarkRepository = {
    init: async () => {},
    listBookmarks: async () => [],
    getBookmark: async () => null,
    insertBookmark: async (bookmark) => {
      calls.push(`insertBookmark:${bookmark.id}:${bookmark.sync_status}`);
    },
    updateBookmark: async (bookmark) => {
      calls.push(`updateBookmark:${bookmark.id}:${bookmark.sync_status}`);
    },
    replaceBookmark: async (previousId, bookmark) => {
      calls.push(`replaceBookmark:${previousId}->${bookmark.id}`);
    },
    deleteBookmark: async (id) => {
      calls.push(`deleteBookmark:${id}`);
    },
    listQueue: async () => storedQueue,
    enqueue: async (entry) => {
      calls.push(`enqueue:${entry.local_id}`);
    },
    updateQueueEntry: async (entry) => {
      calls.push(`updateQueueEntry:${entry.local_id}:${entry.sync_status}`);
    },
    removeQueueEntry: async (id) => {
      calls.push(`removeQueueEntry:${id}`);
    },
    getMeta: async () => null,
    setMeta: async () => {},
    listEnrichments: async () => [],
    upsertEnrichments: async () => {},
    deleteEnrichment: async () => {},
    listTagData: async () => ({ tags: [], bookmarkTags: [], collections: [] }),
    replaceTagData: async () => {},
    clearAllData: async () => {
      calls.push('clearAllData');
    },
  };
  return { calls, repository };
}

function fakeApi(overrides: Partial<Record<keyof BookmarkApi, unknown>> = {}): BookmarkApi {
  return {
    createBookmark: async () => ({
      bookmark_id: '00000000-0000-4000-8000-000000000001',
      status: 'created',
      metadata_status: 'pending',
    }),
    createBookmarks: async () => [
      {
        bookmark_id: '00000000-0000-4000-8000-000000000001',
        status: 'created',
        metadata_status: 'pending',
      },
    ],
    updateBookmark: async () => makeBookmark({ id: '00000000-0000-4000-8000-000000000001', sync_status: 'synced' }),
    deleteBookmark: async () => undefined,
    ...overrides,
  } as unknown as BookmarkApi;
}

test('create: bookmark stays under its own id and turns synced', async () => {
  const { calls, repository } = fakeRepository();
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(fakeApi(), repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.entry.sync_status, 'synced');
  assert.equal(result.entry.remote_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(result.bookmarkUpdate?.id, 'local-abc');
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
  assert.equal(result.bookmarkUpdate?.ever_synced, true);
  assert.ok(calls.includes('updateBookmark:local-abc:synced'));
});

test('create: a server-side duplicate adopts the EXISTING row\'s id (Sentry STASH-3Q)', async () => {
  // The server dedupes a create against an existing different row (same
  // canonical URL) and returns THAT row's id, not the one the client sent.
  // Keeping the local row under its own id here is the STASH-3Q bug: the row
  // gets marked synced under an id Postgres has no row for, and the next
  // pull fetches the real existing row separately, doubling the library.
  const { calls, repository } = fakeRepository();
  const existingId = '00000000-0000-4000-8000-0000000000ee';
  const api = fakeApi({
    createBookmark: async () => ({
      bookmark_id: existingId,
      status: 'duplicate',
      metadata_status: 'complete',
    }),
  });
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.bookmarkUpdate?.id, existingId);
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
  assert.equal(result.originalLocalId, 'local-abc');
  // The phantom row under the original id must be removed, not just left
  // alongside the row now living under the existing id.
  assert.ok(calls.includes('deleteBookmark:local-abc'));
  // insertBookmark (not updateBookmark) — the existing row's id is new to
  // THIS device, and updateBookmark only replaces a row already stored under
  // that id (a strict replace, not an upsert, on the web backend).
  assert.ok(calls.includes(`insertBookmark:${existingId}:synced`));
});

test('create: duplicate adoption is not undone when queue removal fails', async () => {
  const { calls, repository } = fakeRepository();
  repository.removeQueueEntry = async (id) => {
    calls.push(`removeQueueEntry:${id}:failed`);
    throw new Error('queue cleanup failed');
  };
  const existingId = '00000000-0000-4000-8000-0000000000ee';
  const api = fakeApi({
    createBookmark: async () => ({
      bookmark_id: existingId,
      status: 'duplicate',
      metadata_status: 'complete',
    }),
  });
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.bookmarkUpdate?.id, existingId);
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
  assert.equal(result.removeEntry, false);
  assert.ok(calls.includes('deleteBookmark:local-abc'));
  assert.ok(calls.includes(`insertBookmark:${existingId}:synced`));
  assert.ok(!calls.includes('updateBookmark:local-abc:failed'));
});

test('create: a duplicate that resolves to the SAME id is not treated as a swap', async () => {
  // A retried create can land a duplicate hit against the row itself (e.g.
  // the previous attempt's insert actually landed, and this retry's lookup
  // finds it) — same id, so there is nothing to swap or delete.
  const { calls, repository } = fakeRepository();
  const api = fakeApi({
    createBookmark: async () => ({
      bookmark_id: 'local-abc',
      status: 'duplicate',
      metadata_status: 'complete',
    }),
  });
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.bookmarkUpdate?.id, 'local-abc');
  assert.equal(result.originalLocalId, undefined);
  assert.ok(!calls.some((call) => call.startsWith('deleteBookmark:')));
});

test('bulk create: a server-side duplicate adopts the existing row\'s id too (Sentry STASH-3Q)', async () => {
  const existingId = '00000000-0000-4000-8000-0000000000ee';
  const entry = makeCreateEntry({
    local_id: 'local-dup',
    payload: { url: 'https://example.com/a', client_id: '11111111-1111-4111-8111-111111111111' },
  });
  const api = fakeApi({
    createBookmarks: async () => [
      { bookmark_id: existingId, status: 'duplicate', metadata_status: 'complete' },
    ],
  });
  const local = makeBookmark({ id: 'local-dup' });

  const [result] = await syncCreateQueueEntryBatch(api, [entry], () => local);

  assert.equal(result?.bookmarkUpdate?.id, existingId);
  assert.equal(result?.originalLocalId, 'local-dup');
});

test('create: uploads the LATEST title/notes, not the payload captured at save', async () => {
  const { repository } = fakeRepository();
  const sent: unknown[] = [];
  const api = fakeApi({
    createBookmark: async (input: unknown) => {
      sent.push(input);
      return { bookmark_id: '00000000-0000-4000-8000-000000000001', status: 'created', metadata_status: 'pending' };
    },
  });
  const editedSinceSave = makeBookmark({ title: 'Edited title', notes: 'edited notes' });

  const result = await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { url: 'https://example.com/a', notes: 'original' } }),
    () => editedSinceSave,
  );

  assert.deepEqual(sent[0], {
    url: 'https://example.com/a',
    title: 'Edited title',
    notes: 'edited notes',
  });
  assert.equal(result.uploadedPayload?.title, 'Edited title');
});

test('create: uploads generated metadata that settled before create upload', async () => {
  const { repository } = fakeRepository();
  const sent: Array<Record<string, unknown>> = [];
  const api = fakeApi({
    createBookmark: async (input: Record<string, unknown>) => {
      sent.push(input);
      return { bookmark_id: '00000000-0000-4000-8000-000000000001', status: 'created', metadata_status: 'complete' };
    },
  });
  const enrichedBeforeUpload = makeBookmark({
    title: 'Fetched title',
    site_name: 'Example',
    favicon_url: 'https://example.com/favicon.ico',
    preview_image_url: 'https://example.com/preview.png',
    metadata_status: 'complete',
  });

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => enrichedBeforeUpload);

  assert.equal(sent[0]?.title, 'Fetched title');
  assert.equal(sent[0]?.site_name, 'Example');
  assert.equal(sent[0]?.favicon_url, 'https://example.com/favicon.ico');
  assert.equal(sent[0]?.preview_image_url, 'https://example.com/preview.png');
  assert.equal(sent[0]?.metadata_status, 'complete');
  assert.equal(result.uploadedPayload?.metadata_status, 'complete');
});

test('create: forwards the payload client_id so a retried text note stays idempotent', async () => {
  const { repository } = fakeRepository();
  const sent: Array<{ client_id?: string }> = [];
  const api = fakeApi({
    createBookmark: async (input: { client_id?: string }) => {
      sent.push(input);
      return { bookmark_id: '00000000-0000-4000-8000-000000000001', status: 'created', metadata_status: 'skipped' };
    },
  });
  // A text note: no URL, body in description, idempotency rests on client_id.
  const note = makeBookmark({ url: null, content_type: 'text', description: 'a thought' });

  await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { shared_text: 'a thought', client_id: 'cid-text' } }),
    () => note,
  );

  assert.equal(sent[0].client_id, 'cid-text');
});

test('bulk create: uploads latest titles and replaces local rows with returned remote ids', async () => {
  const first = makeCreateEntry({
    local_id: 'local-a',
    payload: { url: 'https://example.com/a', title: 'stale', client_id: '11111111-1111-4111-8111-111111111111' },
  });
  const second = makeCreateEntry({
    local_id: 'local-b',
    payload: { url: 'https://example.com/b', client_id: '22222222-2222-4222-8222-222222222222' },
  });
  const { calls, repository } = fakeRepository();
  const sent: unknown[] = [];
  const api = fakeApi({
    createBookmarks: async (inputs: unknown[]) => {
      sent.push(inputs);
      return [
        {
          bookmark_id: '00000000-0000-4000-8000-000000000101',
          status: 'created',
          metadata_status: 'pending',
        },
        {
          bookmark_id: '00000000-0000-4000-8000-000000000102',
          status: 'created',
          metadata_status: 'pending',
        },
      ];
    },
  });
  const latest = (id: string) =>
    id === 'local-a'
      ? makeBookmark({ id, title: 'fresh title', notes: 'fresh notes' })
      : makeBookmark({ id, url: 'https://example.com/b' });

  const results = await syncCreateQueueEntryBatch(api, [first, second], latest);

  assert.deepEqual(sent[0], [
    {
      url: 'https://example.com/a',
      title: 'fresh title',
      notes: 'fresh notes',
      client_id: '11111111-1111-4111-8111-111111111111',
    },
    {
      url: 'https://example.com/b',
      title: undefined,
      notes: undefined,
      client_id: '22222222-2222-4222-8222-222222222222',
    },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.entry.remote_id, '00000000-0000-4000-8000-000000000101');
  assert.equal(results[0]?.bookmarkUpdate?.id, 'local-a');
  assert.equal(results[0]?.bookmarkUpdate?.sync_status, 'synced');
  assert.equal(results[0]?.uploadedPayload?.title, 'fresh title');
  assert.equal(results[1]?.entry.remote_id, '00000000-0000-4000-8000-000000000102');
  assert.equal(calls.length, 0);
});

test('bulk create: preserves enrichment_policy skip from entry payload in uploaded payload', async () => {
  const skipEntry = makeCreateEntry({
    local_id: 'local-skip',
    payload: {
      url: 'https://example.com/skip',
      client_id: '33333333-3333-4333-8333-333333333333',
      enrichment_policy: 'skip',
    },
  });
  let sent: unknown[] = [];
  const api = fakeApi({
    createBookmarks: async (payloads: CreateBookmarkInput[]) => {
      sent = payloads;
      return [
        {
          bookmark_id: '00000000-0000-4000-8000-000000000103',
          status: 'created',
          client_id: '33333333-3333-4333-8333-333333333333',
        },
      ];
    },
  });
  const latest = (id: string) => makeBookmark({ id, url: 'https://example.com/skip' });

  const results = await syncCreateQueueEntryBatch(api, [skipEntry], latest);

  assert.equal((sent[0] as { enrichment_policy?: string }).enrichment_policy, 'skip');
  assert.equal(results[0]?.uploadedPayload?.enrichment_policy, 'skip');
});

test('bulk create: rejects non-create queue entries', async () => {
  const update = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');

  await assert.rejects(
    () => syncCreateQueueEntryBatch(fakeApi(), [update], () => undefined),
    /only accepts create/,
  );
});

test('bulk create: rejects an image entry (needs the per-entry upload step, not the bulk endpoint)', async () => {
  const imageEntry = makeCreateEntry({
    payload: {
      content_type: 'image',
      client_id: '11111111-1111-4111-8111-111111111112',
    },
  });

  await assert.rejects(
    () => syncCreateQueueEntryBatch(fakeApi(), [imageEntry], () => undefined),
    /does not support image bookmarks/,
  );
});

test('bulk create eligibility excludes legacy URL-less creates without client_id', async () => {
  const legacyTextEntry = makeCreateEntry({
    payload: { shared_text: 'legacy note without an idempotency key' },
  });
  const keyedTextEntry = makeCreateEntry({
    payload: {
      shared_text: 'newer note',
      client_id: '11111111-1111-4111-8111-111111111111',
    },
  });
  const urlEntry = makeCreateEntry({ payload: { url: 'https://example.com/a' } });

  assert.equal(hasBulkCreateResultKey(legacyTextEntry), false);
  assert.equal(hasBulkCreateResultKey(keyedTextEntry), true);
  assert.equal(hasBulkCreateResultKey(urlEntry), true);
});

test('bulk create rejects unkeyed entries before calling the API', async () => {
  let called = false;
  const api = fakeApi({
    createBookmarks: async () => {
      called = true;
      return [];
    },
  });

  await assert.rejects(
    () =>
      syncCreateQueueEntryBatch(
        api,
        [makeCreateEntry({ payload: { shared_text: 'legacy note' } })],
        () => undefined,
      ),
    /requires a client_id or URL/,
  );
  assert.equal(called, false);
});

test('create: an image upload persists the FRESHEST row, not a stale pre-upload snapshot (concurrent edit must survive)', async () => {
  // The upload can take real wall-clock time — long enough for a concurrent
  // title/notes edit to land in durable storage while it's in flight. The
  // upload-step's own repository.updateBookmark write must not clobber that
  // edit by writing back a stale pre-upload snapshot (AGENTS.md's "full-row
  // storage writes should re-read the freshest row" rule).
  const persistedBookmarks: Bookmark[] = [];
  const repository: BookmarkRepository = {
    init: async () => {},
    listBookmarks: async () => [],
    getBookmark: async () => null,
    insertBookmark: async () => {},
    updateBookmark: async (bookmark) => {
      persistedBookmarks.push(bookmark);
    },
    replaceBookmark: async () => {},
    deleteBookmark: async () => {},
    listQueue: async () => [],
    enqueue: async () => {},
    updateQueueEntry: async () => {},
    removeQueueEntry: async () => {},
    getMeta: async () => null,
    setMeta: async () => {},
    listEnrichments: async () => [],
    upsertEnrichments: async () => {},
    deleteEnrichment: async () => {},
    listTagData: async () => ({ tags: [], bookmarkTags: [], collections: [] }),
    replaceTagData: async () => {},
    clearAllData: async () => {},
  };

  const staleBookmark = makeBookmark({
    content_type: 'image',
    title: 'Before edit',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });
  const editedBookmark: Bookmark = { ...staleBookmark, title: 'Edited mid-upload' };
  let getBookmarkCalls = 0;
  const getBookmark = () => {
    getBookmarkCalls += 1;
    // First read (before the upload starts) sees the pre-edit title; every
    // read after that — including the one right before the upload-step's
    // own persist — sees the edit that landed while the upload was in flight.
    return getBookmarkCalls === 1 ? staleBookmark : editedBookmark;
  };
  const uploadImage = async () => 'https://storage.example.com/bookmark-images/user-test/local-abc';

  await syncQueueEntry(
    fakeApi(),
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    getBookmark,
    uploadImage,
  );

  const uploadStepPersist = persistedBookmarks.find(
    (bookmark) => bookmark.preview_image_url && bookmark.sync_status !== 'synced',
  );
  assert.equal(uploadStepPersist?.title, 'Edited mid-upload');
});

test('create: an image bookmark uploads its binary before creating the row, then becomes a confirmed synced row', async () => {
  const { calls, repository } = fakeRepository();
  const imageBookmark = makeBookmark({
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });
  const uploadCalls: Bookmark[] = [];
  const uploadImage = async (bookmark: Bookmark) => {
    uploadCalls.push(bookmark);
    return 'https://storage.example.com/bookmark-images/user-test/local-abc';
  };
  let createdPayload: CreateBookmarkInput | undefined;
  const api = fakeApi({
    createBookmark: async (input: CreateBookmarkInput) => {
      createdPayload = input;
      return {
        bookmark_id: '00000000-0000-4000-8000-000000000001',
        status: 'created',
        metadata_status: 'skipped',
      };
    },
  });

  const result = await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { content_type: 'image', title: 'Screenshot' } }),
    () => imageBookmark,
    uploadImage,
  );

  // The binary uploads exactly once, before the row is created.
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0]?.id, 'local-abc');
  assert.equal(createdPayload?.content_type, 'image');
  assert.equal(createdPayload?.preview_image_url, 'https://storage.example.com/bookmark-images/user-test/local-abc');
  // The upload is persisted locally right away (not just carried in the
  // outgoing payload), so a retry after this point never re-uploads.
  assert.ok(
    calls.some(
      (call) => call.startsWith('updateBookmark:local-abc') && call !== 'updateBookmark:local-abc:pending',
    ),
  );
  // The row only becomes a confirmed cloud row (ever_synced: true) once the
  // upload AND the create both actually succeeded — this is what flips
  // isLocalOnlyBookmark to false and makes the row eligible for the
  // remote-deletion diff going forward.
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
  assert.equal(result.bookmarkUpdate?.ever_synced, true);
  assert.equal(
    result.bookmarkUpdate?.preview_image_url,
    'https://storage.example.com/bookmark-images/user-test/local-abc',
  );
});

test('create: an image bookmark already uploaded (preview_image_url set) does not re-upload on retry', async () => {
  const { repository } = fakeRepository();
  const alreadyUploaded = makeBookmark({
    content_type: 'image',
    preview_image_url: 'https://storage.example.com/bookmark-images/user-test/local-abc',
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });
  let uploadCallCount = 0;
  const uploadImage = async () => {
    uploadCallCount += 1;
    return 'https://storage.example.com/bookmark-images/user-test/local-abc';
  };

  const result = await syncQueueEntry(
    fakeApi(),
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    () => alreadyUploaded,
    uploadImage,
  );

  assert.equal(uploadCallCount, 0);
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
});

test('create: an image upload failure never calls createBookmark and stays retryable (STASH-65 invariant preserved)', async () => {
  const { repository } = fakeRepository();
  const imageBookmark = makeBookmark({
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
    ever_synced: undefined,
  });
  let createBookmarkCalled = false;
  const api = fakeApi({
    createBookmark: async () => {
      createBookmarkCalled = true;
      throw new Error('should never be called before the image upload succeeds');
    },
  });
  const uploadImage = async () => {
    throw new Error('network down mid-upload');
  };

  const result = await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    () => imageBookmark,
    uploadImage,
  );

  assert.equal(createBookmarkCalled, false);
  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(result.entry.last_error, 'network down mid-upload');
  // The bookmark itself is left with ever_synced still unset — exactly the
  // isLocalOnlyBookmark(bookmark) === true shape STASH-65 depends on to keep
  // this row excluded from the remote-deletion diff while it retries.
  assert.notEqual(result.bookmarkUpdate?.ever_synced, true);
});

test('create: an image bookmark with no uploader available on this platform fails cleanly instead of mis-syncing', async () => {
  const { repository } = fakeRepository();
  const imageBookmark = makeBookmark({
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });

  const result = await syncQueueEntry(
    fakeApi(),
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    () => imageBookmark,
    // uploadImage omitted entirely, as on web.
  );

  assert.equal(result.entry.sync_status, 'failed');
  assert.match(result.entry.last_error ?? '', /not available on this platform/);
});

test('create: an image bookmark permanently deleted mid-upload aborts instead of resurrecting the stale snapshot (P1)', async () => {
  // On native, repository.updateBookmark is `INSERT OR REPLACE` (an upsert
  // — see repository.native.ts). If a permanent delete removes the row
  // WHILE its image is uploading, blindly persisting the pre-delete
  // snapshot after the upload resolves would durably re-insert a row the
  // user just deleted, reappearing after restart.
  const { calls, repository } = fakeRepository();
  const imageBookmark = makeBookmark({
    id: 'local-abc',
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });
  let getBookmarkCalls = 0;
  const getBookmark = () => {
    getBookmarkCalls += 1;
    // First read (top of the create branch, before the upload starts) still
    // sees the row; every read after that simulates it having been
    // permanently deleted while the upload was in flight.
    return getBookmarkCalls === 1 ? imageBookmark : undefined;
  };
  let createBookmarkCalled = false;
  const api = fakeApi({
    createBookmark: async () => {
      createBookmarkCalled = true;
      throw new Error('must never be called for a row that no longer exists');
    },
  });
  const uploadImage = async () => 'https://storage.example.com/bookmark-images/user-test/local-abc';

  const result = await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    getBookmark,
    uploadImage,
  );

  assert.equal(createBookmarkCalled, false);
  // No insert/upsert of the stale pre-delete snapshot.
  assert.equal(calls.some((call) => call.startsWith('insertBookmark:')), false);
  assert.equal(calls.some((call) => call.startsWith('updateBookmark:')), false);
  assert.equal(result.removeEntry, true);
  assert.equal(result.entry.sync_status, 'synced');
  assert.equal(result.bookmarkUpdate, undefined);
});

test('create: an image upload that succeeds right before createBookmark fails still carries the uploaded URL into the failed row (P2)', async () => {
  // Without this, the failure-path write clobbers the just-persisted
  // preview_image_url back to null (the in-memory `localBookmark` snapshot
  // never reflects the upload step's direct repository write), so every
  // retry re-uploads the whole image needlessly.
  const { repository } = fakeRepository();
  const imageBookmark = makeBookmark({
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-abc.jpg',
  });
  const uploadImage = async () => 'https://storage.example.com/bookmark-images/user-test/local-abc';
  const api = fakeApi({
    createBookmark: async () => {
      throw new Error('the row itself failed to create, after a successful upload');
    },
  });

  const result = await syncQueueEntry(
    api,
    repository,
    makeCreateEntry({ payload: { content_type: 'image' } }),
    () => imageBookmark,
    uploadImage,
  );

  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(
    result.bookmarkUpdate?.preview_image_url,
    'https://storage.example.com/bookmark-images/user-test/local-abc',
  );
});

test('create: failure stays retryable with the error recorded', async () => {
  const { repository } = fakeRepository();
  const api = fakeApi({
    createBookmark: async () => {
      throw new Error('network down');
    },
  });

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => makeBookmark());

  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(result.entry.retry_count, 1);
  assert.equal(result.entry.last_error, 'network down');
  assert.equal(result.entry.last_error_kind, 'other');
  assert.equal(result.bookmarkUpdate?.sync_status, 'failed');
  // last_attempt_at is what the retry backoff (isSyncable/uploadRetryBackoffMs)
  // clocks from — a failure that doesn't record it would be retried instantly.
  assert.equal(typeof result.entry.last_attempt_at, 'string');
});

test('create: the threshold-crossing failure persists its health escalation marker', async () => {
  const entry = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 2,
    last_error_kind: 'other',
  });
  const { calls, repository } = fakeRepository([entry]);
  const api = fakeApi({
    createBookmark: async () => {
      throw new Error('server contract failed');
    },
  });

  const result = await syncQueueEntry(api, repository, entry, () => makeBookmark());

  assert.equal(result.entry.retry_count, 3);
  assert.equal(typeof result.entry.health_escalated_at, 'string');
  assert.ok(calls.includes(`updateQueueEntry:${entry.local_id}:failed`));
});

test('syncErrorKind preserves transport-vs-HTTP provenance before persistence', () => {
  const dnsError = new Error(
    'fetch failed: java.net.UnknownHostException: Unable to resolve host "example.supabase.co"',
  );
  const responseError = new SupabaseRequestError('The request timed out', 503);

  assert.equal(syncErrorKind(dnsError), 'transient_network');
  assert.equal(syncErrorKind(responseError), 'other');
});

test('update: sends the LATEST user-editable fields and leaves the queue', async () => {
  const { calls, repository } = fakeRepository();
  const sent: unknown[] = [];
  const api = fakeApi({
    updateBookmark: async (id: string, input: unknown) => {
      sent.push([id, input]);
      return makeBookmark({ id, sync_status: 'synced' });
    },
  });
  const latest = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    sync_status: 'pending',
    is_archived: true,
    notes: 'edited after enqueue',
    site_name: 'example.com',
    favicon_url: 'https://example.com/favicon.ico',
    metadata_status: 'complete',
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(api, repository, entry, () => latest);

  assert.equal(result.removeEntry, true);
  assert.deepEqual(sent[0], [
    '00000000-0000-4000-8000-000000000001',
    {
      title: null,
      description: null,
      notes: 'edited after enqueue',
      collection_id: null,
      is_archived: true,
      deleted_at: null,
      // Generated metadata rides along so enrichment reaches the cloud.
      site_name: 'example.com',
      favicon_url: 'https://example.com/favicon.ico',
      preview_image_url: null,
      metadata_status: 'complete',
    },
  ]);
  assert.equal(result.bookmarkUpdate?.sync_status, 'synced');
  assert.ok(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
});

test('update: retries without optional AI dismissal fields when the schema is behind', async () => {
  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const { calls, repository } = fakeRepository([entry]);
  const sent: unknown[] = [];
  const api = fakeApi({
    updateBookmark: async (id: string, input: Record<string, unknown>) => {
      sent.push([id, input]);
      if (sent.length === 1) {
        throw new SupabaseRequestError(
          "Could not find the 'reviewed_summary_tokens' column of 'bookmarks' in the schema cache",
          400,
        );
      }
      return makeBookmark({ id, sync_status: 'synced' });
    },
  });
  const latest = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    sync_status: 'pending',
    dismissed_suggested_tags: ['tag-token'],
    dismissed_suggested_folders: ['folder-token'],
    reviewed_summary_tokens: ['summary-token'],
  });

  const result = await syncQueueEntry(api, repository, entry, () => latest);

  assert.equal(result.removeEntry, undefined);
  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(
    result.entry.last_error,
    'Optional AI dismissal fields are waiting for the Supabase schema to update.',
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], [
    '00000000-0000-4000-8000-000000000001',
    {
      title: null,
      description: null,
      notes: null,
      collection_id: null,
      is_archived: false,
      deleted_at: null,
      site_name: null,
      favicon_url: null,
      preview_image_url: null,
      metadata_status: 'pending',
      dismissed_suggested_tags: ['tag-token'],
      dismissed_suggested_folders: ['folder-token'],
      reviewed_summary_tokens: ['summary-token'],
    },
  ]);
  assert.deepEqual(sent[1], [
    '00000000-0000-4000-8000-000000000001',
    {
      title: null,
      description: null,
      notes: null,
      collection_id: null,
      is_archived: false,
      deleted_at: null,
      site_name: null,
      favicon_url: null,
      preview_image_url: null,
      metadata_status: 'pending',
    },
  ]);
  assert.ok(calls.includes('updateQueueEntry:00000000-0000-4000-8000-000000000001:failed'));
  assert.ok(!calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
});

test('update: failure does not overwrite a queue entry if a newer operation has superseded it', async () => {
  const latest = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    sync_status: 'pending',
  });

  const originalEntry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');

  // The database queue now has a newer enqueued delete mutation that superseded our update while it was running
  const supersedingDelete = {
    ...originalEntry,
    operation: 'delete' as const,
    updated_at: '2026-06-12T00:05:00.000Z', // newer
  };

  const { calls, repository } = fakeRepository([supersedingDelete]);
  const api = fakeApi({
    updateBookmark: async () => {
      throw new Error('API update failed');
    },
  });

  const result = await syncQueueEntry(api, repository, originalEntry, () => latest);

  assert.equal(result.removeEntry, undefined);
  // It must return the superseding delete entry, preserving it for in-memory queue integration
  assert.equal(result.entry.sync_status, 'pending');
  assert.equal(result.entry.operation, 'delete');
  assert.equal(result.entry.updated_at, '2026-06-12T00:05:00.000Z');
  // Since the delete mutation is in the queue, we must NOT write 'failed' back to the queue
  assert.ok(!calls.includes('updateQueueEntry:00000000-0000-4000-8000-000000000001:failed'));
});

test('update: a locally deleted bookmark just clears the entry', async () => {
  const { calls, repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    updateBookmark: async () => {
      apiCalled = true;
      return makeBookmark();
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.equal(apiCalled, false);
  assert.ok(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
});

test('update: failure stays retryable', async () => {
  const { repository } = fakeRepository();
  const api = fakeApi({
    updateBookmark: async () => {
      throw new Error('500');
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: '00000000-0000-4000-8000-000000000001' }),
  );

  assert.equal(result.removeEntry, undefined);
  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(result.entry.retry_count, 1);
});

test('update: reconciles (removes local row + queue entry) when the remote row is confirmed gone (Sentry STASH-2F)', async () => {
  // Deleted on another device while this device still had a queued edit —
  // the exact, unambiguous error updateBookmark throws for a zero-row PATCH
  // already scoped to the current user. Retrying can never succeed.
  const { calls, repository } = fakeRepository();
  const api = fakeApi({
    updateBookmark: async () => {
      throw new Error(BOOKMARK_NOT_FOUND_ERROR_MESSAGE);
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: '00000000-0000-4000-8000-000000000001' }),
  );

  assert.equal(result.removeEntry, true);
  assert.equal(result.removedBookmarkId, '00000000-0000-4000-8000-000000000001');
  assert.equal(result.entry.sync_status, 'synced');
  assert.ok(calls.includes('deleteBookmark:00000000-0000-4000-8000-000000000001'));
  assert.ok(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
});

test('update: a generic failure still stays retryable, not reconciled as gone', async () => {
  // Guards against over-matching: only the exact BOOKMARK_NOT_FOUND_ERROR_MESSAGE
  // triggers reconciliation. Anything else (network blip, 500, etc.) must keep
  // retrying normally.
  const { calls, repository } = fakeRepository();
  const api = fakeApi({
    updateBookmark: async () => {
      throw new Error('Bookmark not found or not owned by the current user, maybe');
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: '00000000-0000-4000-8000-000000000001' }),
  );

  assert.equal(result.removeEntry, undefined);
  assert.equal(result.removedBookmarkId, undefined);
  assert.equal(result.entry.sync_status, 'failed');
  assert.ok(!calls.includes('deleteBookmark:00000000-0000-4000-8000-000000000001'));
});

test('delete: permanently removes the remote row and leaves the queue', async () => {
  const { calls, repository } = fakeRepository();
  const sent: unknown[] = [];
  const api = fakeApi({
    deleteBookmark: async (id: string, permanent: boolean) => {
      sent.push([id, permanent]);
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'delete');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.deepEqual(sent[0], ['00000000-0000-4000-8000-000000000001', true]);
  assert.ok(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
});

test('delete: failure stays retryable', async () => {
  const { repository } = fakeRepository();
  const api = fakeApi({
    deleteBookmark: async () => {
      throw new Error('timeout');
    },
  });

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'delete');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, undefined);
  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(result.entry.last_error, 'timeout');
});

test('mergeSyncedBookmarkFields: carries the just-uploaded preview_image_url for an image bookmark', () => {
  // `latest` simulates in-memory state that has NOT caught up to the upload
  // step's direct repository write (still null) — this is the real shape
  // the bug hit.
  const latest = makeBookmark({
    content_type: 'image',
    preview_image_url: null,
    title: 'Screenshot',
  });
  const update = makeBookmark({
    content_type: 'image',
    preview_image_url: 'https://storage.example.com/bookmark-images/user-test/local-abc',
    sync_status: 'synced',
    ever_synced: true,
    updated_at: '2026-06-13T00:00:00.000Z',
  });

  const merged = mergeSyncedBookmarkFields(latest, update);

  assert.equal(merged.preview_image_url, 'https://storage.example.com/bookmark-images/user-test/local-abc');
  assert.equal(merged.sync_status, 'synced');
  assert.equal(merged.ever_synced, true);
  assert.equal(merged.updated_at, '2026-06-13T00:00:00.000Z');
  // Non-sync-owned fields still come from `latest`, not `update`.
  assert.equal(merged.title, 'Screenshot');
});

test('mergeSyncedBookmarkFields: does NOT carry preview_image_url for a non-image bookmark (protects a concurrent enrichment write)', () => {
  // A URL bookmark's `update` snapshot was taken before an on-device
  // OpenGraph fetch may have completed — if it carried preview_image_url
  // through unconditionally, a real scraped image that landed in `latest`
  // while the create was uploading would be clobbered back to whatever
  // (possibly null) the pre-upload snapshot had.
  const latest = makeBookmark({
    content_type: 'url',
    preview_image_url: 'https://example.com/og-image-that-arrived-after-create-started.png',
  });
  const update = makeBookmark({
    content_type: 'url',
    preview_image_url: null,
    sync_status: 'synced',
    ever_synced: true,
  });

  const merged = mergeSyncedBookmarkFields(latest, update);

  assert.equal(
    merged.preview_image_url,
    'https://example.com/og-image-that-arrived-after-create-started.png',
  );
});

test('mergeSyncedBookmarkFields: id/sync_status/ever_synced/updated_at always come from `update`', () => {
  const latest = makeBookmark({
    id: 'local-abc',
    sync_status: 'pending',
    ever_synced: undefined,
    updated_at: '2026-06-12T00:00:00.000Z',
  });
  const update = makeBookmark({
    id: '00000000-0000-4000-8000-000000000099',
    sync_status: 'synced',
    ever_synced: true,
    updated_at: '2026-06-13T00:00:00.000Z',
  });

  const merged = mergeSyncedBookmarkFields(latest, update);

  assert.equal(merged.id, '00000000-0000-4000-8000-000000000099');
  assert.equal(merged.sync_status, 'synced');
  assert.equal(merged.ever_synced, true);
  assert.equal(merged.updated_at, '2026-06-13T00:00:00.000Z');
});

test('createNeedsReconcileUpdate: a pristine just-created row needs no follow-up', () => {
  // The remote row mirrors exactly what the create payload sent: same title/notes,
  // active, no metadata, no collection. Nothing diverged, so no follow-up update.
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Title',
    notes: 'note',
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, {
    url: 'https://example.com/a',
    title: 'Title',
    notes: 'note',
  });
  assert.equal(needs, false);
});

test('createNeedsReconcileUpdate: a generated title filled during create upload needs no follow-up', () => {
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'OpenGraph title',
    title_is_derived: true,
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, {
    url: 'https://example.com/a',
  });
  assert.equal(needs, false);
});

test('createNeedsReconcileUpdate: a fetched title filled during create upload needs no follow-up', () => {
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Fetched page title',
    title_is_derived: false,
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, {
    url: 'https://example.com/a',
  });
  assert.equal(needs, false);
});

test('createNeedsReconcileUpdate: metadata settling mid-upload needs no follow-up (Sentry STASH-3Y queue-bouncing regression)', () => {
  // The bug: background OpenGraph enrichment finishes for nearly every newly
  // created bookmark while its own create upload is still in flight. Before
  // this predicate dropped metadata_status/site_name/favicon_url/
  // preview_image_url, that alone made this return true for almost every row
  // in a bulk import, re-queuing a just-finished batch as "update" mutations
  // and making the Settings "N syncing" counter bounce back up instead of
  // draining to 0. None of these are user-authored, so they must never
  // trigger a follow-up on their own.
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Title',
    notes: 'note',
    metadata_status: 'complete',
    site_name: 'Example Site',
    favicon_url: 'https://example.com/favicon.ico',
    preview_image_url: 'https://example.com/preview.png',
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, {
    url: 'https://example.com/a',
    title: 'Title',
    notes: 'note',
  });
  assert.equal(needs, false);
});

test('createNeedsReconcileUpdate: a genuine user edit concurrent with metadata settling still needs a follow-up (STASH-3Y)', () => {
  // Metadata churn alone must not trigger reconciliation (see above), but a
  // real user-authored change landing in the SAME window still must — the
  // fix must not have overcorrected into silently dropping real divergence.
  const archivedWhileEnriching = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Title',
    notes: 'note',
    is_archived: true,
    metadata_status: 'complete',
    site_name: 'Example Site',
    sync_status: 'synced',
  });
  assert.equal(
    createNeedsReconcileUpdate(archivedWhileEnriching, {
      url: 'https://example.com/a',
      title: 'Title',
      notes: 'note',
    }),
    true,
  );

  const filedWhileEnriching = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Title',
    collection_id: 'collection-1',
    metadata_status: 'complete',
    favicon_url: 'https://example.com/favicon.ico',
    sync_status: 'synced',
  });
  assert.equal(
    createNeedsReconcileUpdate(filedWhileEnriching, {
      url: 'https://example.com/a',
      title: 'Title',
    }),
    true,
  );

  const editedWhileEnriching = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'User-edited title',
    metadata_status: 'complete',
    preview_image_url: 'https://example.com/preview.png',
    sync_status: 'synced',
  });
  assert.equal(
    createNeedsReconcileUpdate(
      editedWhileEnriching,
      { url: 'https://example.com/a', title: 'Original title' },
      { titleChangedByUser: true },
    ),
    true,
  );
});

test('createNeedsReconcileUpdate: a user title edited during create upload needs a follow-up', () => {
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Edited title',
    title_is_derived: false,
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, {
    url: 'https://example.com/a',
  }, { titleChangedByUser: true });
  assert.equal(needs, true);
});

test('createNeedsReconcileUpdate: a text note whose body was edited before upload needs a follow-up', () => {
  // A text note uploads its body as shared_text; the remote row stores it in
  // description. If the user edited the body before the create ran, the uploaded
  // shared_text is stale, so the divergence must trigger a follow-up update.
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    url: null,
    content_type: 'text',
    description: 'edited body',
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, { shared_text: 'original body' });
  assert.equal(needs, true);
});

test('createNeedsReconcileUpdate: a pristine text note (body unchanged) needs no follow-up', () => {
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    url: null,
    content_type: 'text',
    description: 'a thought',
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, { shared_text: 'a thought' });
  assert.equal(needs, false);
});

test('createNeedsReconcileUpdate: a row trashed before it had a remote id needs a follow-up', () => {
  // The genuine bug: trashBookmark on a local-only row sets deleted_at but
  // enqueues no update (no remote identity yet); the create uploads ACTIVE.
  // Without deleted_at in the reconcile condition the cloud row stays live and
  // resurrects on other devices. This asserts the follow-up update fires.
  const persisted = makeBookmark({
    id: '00000000-0000-4000-8000-000000000001',
    deleted_at: '2026-06-24T00:00:00.000Z',
    sync_status: 'synced',
  });
  const needs = createNeedsReconcileUpdate(persisted, { url: 'https://example.com/a' });
  assert.equal(needs, true);
});

test('create→sync round-trip: a trashed-before-remote-id create lands deleted_at in the cloud', async () => {
  // End-to-end through BOTH sync passes the store performs, asserting the fake
  // cloud row ends trashed — not just that the reconcile predicate is true.
  const { repository } = fakeRepository();
  const createReceived: unknown[] = [];
  const updateReceived: Array<[string, Record<string, unknown>]> = [];
  const api = fakeApi({
    createBookmark: async (input: unknown) => {
      createReceived.push(input);
      return { bookmark_id: '00000000-0000-4000-8000-000000000001', status: 'created', metadata_status: 'pending' };
    },
    updateBookmark: async (id: string, input: Record<string, unknown>) => {
      updateReceived.push([id, input]);
      return makeBookmark({ id, sync_status: 'synced' });
    },
  });

  // The local row is already trashed when its create uploads.
  const trashedLocal = makeBookmark({
    id: 'local-abc',
    deleted_at: '2026-06-24T00:00:00.000Z',
    sync_status: 'pending',
  });

  // Pass 1: the create. The create payload omits deleted_at, so the freshly
  // minted cloud row is ACTIVE — this is the bug's starting condition.
  const created = await syncQueueEntry(api, repository, makeCreateEntry(), () => trashedLocal);
  const persisted = created.bookmarkUpdate;
  assert.ok(persisted);
  assert.equal(persisted.deleted_at, '2026-06-24T00:00:00.000Z');
  assert.equal('deleted_at' in (createReceived[0] as object), true);

  // The store's reconcile decides a follow-up update is needed (the fix), and
  // enqueues makeMutationEntry(persisted.id, 'update').
  assert.equal(createNeedsReconcileUpdate(persisted, created.uploadedPayload), true);
  const followUp = makeMutationEntry(persisted.id, 'update');

  // Pass 2: process that update against the (still trashed) row, under its
  // own stable id.
  const remoteRow = makeBookmark({ id: persisted.id, deleted_at: '2026-06-24T00:00:00.000Z' });
  await syncQueueEntry(api, repository, followUp, () => remoteRow);

  // The cloud row is now trashed: api.updateBookmark received deleted_at for it.
  assert.equal(updateReceived.length, 1);
  assert.equal(updateReceived[0]?.[0], persisted.id);
  assert.equal(updateReceived[0]?.[1]?.deleted_at, '2026-06-24T00:00:00.000Z');
});

test('hasRemoteIdentity accepts only Supabase UUIDs', () => {
  assert.equal(hasRemoteIdentity('local-m1abc-xyz'), false);
  // Non-UUID IDs (device-local rows, never-synced samples) are not remote rows
  // and must never receive mutations.
  assert.equal(hasRemoteIdentity('bookmark-local-first'), false);
  assert.equal(hasRemoteIdentity('7e64cf1e-0000-4000-8000-000000000000'), true);
});

test('update success does not remove a delete entry that superseded it', async () => {
  const supersedingDelete = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'delete');
  const { calls, repository } = fakeRepository([supersedingDelete]);

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(fakeApi(), repository, entry, () =>
    makeBookmark({ id: '00000000-0000-4000-8000-000000000001', sync_status: 'synced' }),
  );

  assert.equal(result.removeEntry, true);
  // The durable delete row must survive so the deletion still happens
  // after a restart.
  assert.equal(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'), false);
});

test('update of a missing bookmark preserves a superseding delete entry', async () => {
  const supersedingDelete = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'delete');
  const { calls, repository } = fakeRepository([supersedingDelete]);

  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');
  const result = await syncQueueEntry(fakeApi(), repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.equal(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'), false);
});

const REMOTE_ID = '7e64cf1e-0000-4000-8000-000000000001';

test('reconcileOrphanedQueueEntries re-creates a stranded local bookmark', () => {
  const orphan = makeBookmark({
    id: 'local-abc',
    url: 'https://example.com/a',
    title: 'Stranded',
    notes: 'keep me',
    sync_status: 'pending',
  });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.local_id, 'local-abc');
  assert.equal(entries[0]?.operation, 'create');
  assert.equal(entries[0]?.sync_status, 'pending');
  assert.deepEqual(entries[0]?.payload, {
    id: 'local-abc',
    url: 'https://example.com/a',
    title: 'Stranded',
    notes: 'keep me',
    client_id: undefined,
  });
});

test('reconcileOrphanedQueueEntries re-queues an update for a stranded synced-id bookmark', () => {
  // ever_synced (not id shape) is what marks this row as previously synced —
  // see Bookmark.ever_synced.
  const orphan = makeBookmark({ id: REMOTE_ID, sync_status: 'pending', ever_synced: true });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.local_id, REMOTE_ID);
  assert.equal(entries[0]?.operation, 'update');
});

test('reconcileOrphanedQueueEntries skips a url-less local bookmark', () => {
  // A create with neither url nor shared_text is rejected by the server, so
  // re-enqueuing it would strand the row as failed instead of self-healing it.
  const orphan = makeBookmark({
    id: 'local-textonly',
    url: null,
    content_type: 'text',
    sync_status: 'pending',
  });

  assert.deepEqual(reconcileOrphanedQueueEntries([orphan], []), []);
});

test('reconcileOrphanedQueueEntries re-creates a stranded text note carrying its body as shared_text', () => {
  // A text note whose queue entry was lost (row written, enqueue failed) must
  // still self-heal: re-send the note body (stored in description) as shared_text
  // so the server accepts the create instead of rejecting a url-less, text-less one.
  const orphan = makeBookmark({
    id: 'local-note',
    url: null,
    content_type: 'text',
    description: '내일 3시에 회의 있습니다',
    title: 'Reminder',
    client_id: 'cid-note',
    sync_status: 'pending',
  });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.operation, 'create');
  // The rebuilt create carries the row's client_id so re-enqueuing a note that
  // actually reached the cloud resolves to a duplicate instead of a second row.
  assert.deepEqual(entries[0]?.payload, {
    id: 'local-note',
    title: 'Reminder',
    notes: undefined,
    shared_text: '내일 3시에 회의 있습니다',
    client_id: 'cid-note',
  });
});

test('reconcileOrphanedQueueEntries re-creates a stranded image bookmark not yet uploaded', () => {
  // The bookmark row landed but its enqueue step never persisted (a crash
  // between the two writes) — same class of gap as the text-note case above.
  // The rebuilt create carries content_type: 'image' (the signal
  // requirePayload needs) with no preview_image_url yet; syncQueueEntry
  // uploads the binary itself once this entry is actually picked up.
  const orphan = makeBookmark({
    id: 'local-img',
    url: null,
    content_type: 'image',
    preview_image_url: null,
    local_image_uri: 'file:///stash-images/local-img.jpg',
    title: 'Screenshot',
    client_id: 'cid-img',
    sync_status: 'pending',
  });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.operation, 'create');
  assert.deepEqual(entries[0]?.payload, {
    id: 'local-img',
    content_type: 'image',
    title: 'Screenshot',
    notes: undefined,
    preview_image_url: undefined,
    client_id: 'cid-img',
  });
});

test('reconcileOrphanedQueueEntries re-creates a stranded image bookmark whose upload already succeeded', () => {
  // The upload landed (preview_image_url is set) but the create call or its
  // queue-entry write never completed — the rebuilt payload carries the
  // already-uploaded URL through so the row uploads without re-uploading the
  // binary.
  const orphan = makeBookmark({
    id: 'local-img2',
    url: null,
    content_type: 'image',
    preview_image_url: 'https://storage.example.com/bookmark-images/u1/local-img2',
    local_image_uri: 'file:///stash-images/local-img2.jpg',
    sync_status: 'pending',
  });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(
    entries[0]?.payload.preview_image_url,
    'https://storage.example.com/bookmark-images/u1/local-img2',
  );
});

test('reconcileOrphanedQueueEntries leaves synced and already-queued bookmarks alone', () => {
  const synced = makeBookmark({ id: 'local-synced', sync_status: 'synced' });
  const alreadyQueued = makeBookmark({ id: 'local-queued', sync_status: 'pending' });
  const orphan = makeBookmark({ id: 'local-orphan', sync_status: 'failed' });

  const entries = reconcileOrphanedQueueEntries(
    [synced, alreadyQueued, orphan],
    [makeCreateEntry({ local_id: 'local-queued' })],
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.local_id, 'local-orphan');
});

test('makeMutationEntry targets the bookmark with a pending status', () => {
  const entry = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'delete');
  assert.equal(entry.local_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(entry.remote_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(entry.operation, 'delete');
  assert.equal(entry.sync_status, 'pending');
});

test('isSyncable excludes a create that already failed with the permanent url_hash btree error (Sentry STASH-2J)', () => {
  // Reproduces an entry stuck from BEFORE the client-side length guard shipped
  // (a pre-fix build could still queue a too-long URL): last_error already
  // carries this exact Postgres message from its last failed attempt, so it
  // must stop being retried without needing a fresh failure to relabel it.
  const stuck = makeCreateEntry({
    sync_status: 'failed',
    last_error:
      'index row size 2888 exceeds btree version 4 maximum 2704 for index "bookmarks_user_url_hash_active_idx"',
  });
  assert.equal(isSyncable(stuck), false);
});

test('isSyncable excludes a create that failed because the image exceeds the upload size limit', () => {
  // uploadBookmarkImage (store/bookmarks.tsx) checks the file's size BEFORE
  // ever attempting the network call and throws with IMAGE_TOO_LARGE_ERROR_TEXT
  // when it's over the bucket's own file_size_limit — the file can't shrink
  // between retries, so this is exactly as permanent as a too-long URL.
  const stuck = makeCreateEntry({
    sync_status: 'failed',
    last_error: 'Image is 22.4MB, which exceeds the maximum upload size of 15MB.',
  });
  assert.equal(isSyncable(stuck), false);
});

test('isSyncable still retries an ordinary failure (e.g. a network blip)', () => {
  const transient = makeCreateEntry({ sync_status: 'failed', last_error: 'network down' });
  assert.equal(isSyncable(transient), true);
});

test('isSyncable still retries a pending/syncing entry regardless of a stale last_error', () => {
  assert.equal(
    isSyncable(
      makeCreateEntry({
        sync_status: 'pending',
        last_error: 'index row size 2888 exceeds btree version 4 maximum 2704 for index "x"',
      }),
    ),
    true,
  );
});

test('isSyncable excludes a synced entry as before', () => {
  assert.equal(isSyncable(makeCreateEntry({ sync_status: 'synced' })), false);
});

test('uploadRetryBackoffMs follows the exponential schedule and caps at the last entry', () => {
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 0 })), 0);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 1 })), UPLOAD_RETRY_BACKOFF_MS[0]);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 2 })), UPLOAD_RETRY_BACKOFF_MS[1]);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 3 })), UPLOAD_RETRY_BACKOFF_MS[2]);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 4 })), UPLOAD_RETRY_BACKOFF_MS[3]);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 5 })), UPLOAD_RETRY_BACKOFF_MS[4]);
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 6 })), UPLOAD_RETRY_BACKOFF_MS[5]);
  // Beyond the schedule's length, it stays capped at the last entry rather
  // than growing unbounded or throwing on an out-of-range index.
  assert.equal(uploadRetryBackoffMs(makeCreateEntry({ retry_count: 40 })), UPLOAD_RETRY_BACKOFF_MS[5]);
});

test('uploadRetryBackoffMs waits longer for a transient network failure (DNS/offline) than an ordinary one', () => {
  const ordinary = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 2,
    last_error: '500 Internal Server Error',
    last_error_kind: 'other',
  });
  const dnsFailure = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 2,
    last_error: 'UnknownHostException: stzutoejnhzxzhjsjtsi.supabase.co',
    last_error_kind: 'transient_network',
  });
  assert.ok(uploadRetryBackoffMs(dnsFailure) > uploadRetryBackoffMs(ordinary));
});

test('isSyncable excludes a failed entry still inside its backoff window', () => {
  const failedNow = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 1,
    last_attempt_at: '2026-06-12T00:00:00.000Z',
  });
  const justAfterFailure = new Date('2026-06-12T00:00:00.000Z').getTime() + 1_000; // 1s later, well within the 5s backoff
  assert.equal(isSyncable(failedNow, { now: justAfterFailure }), false);
});

test('isSyncable includes a failed entry again once its backoff window has elapsed', () => {
  const failedNow = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 1,
    last_attempt_at: '2026-06-12T00:00:00.000Z',
  });
  const afterBackoff =
    new Date('2026-06-12T00:00:00.000Z').getTime() + UPLOAD_RETRY_BACKOFF_MS[0]!;
  assert.equal(isSyncable(failedNow, { now: afterBackoff }), true);
});

test('isSyncable treats a pre-backoff queue entry (no last_attempt_at) as immediately retryable', () => {
  // Backward compatibility: a queue entry already on a device's local storage
  // before this field existed loads with last_attempt_at undefined, not null.
  // It must not get stuck excluded forever for lack of a timestamp.
  const legacyFailed = makeCreateEntry({ sync_status: 'failed', retry_count: 4 });
  assert.equal('last_attempt_at' in legacyFailed, false);
  assert.equal(isSyncable(legacyFailed), true);
});

test('isSyncable: a syncNow triggered for an unrelated reason does not sweep up a backed-off failed entry', () => {
  // Simulates the queue.filter(isSyncable) call sites in store/bookmarks.tsx:
  // a fresh save (pending) sits alongside an entry that JUST failed.
  const now = new Date('2026-06-12T00:00:10.000Z').getTime();
  const freshSave = makeCreateEntry({ local_id: 'local-fresh', sync_status: 'pending' });
  const justFailed = makeCreateEntry({
    local_id: 'local-failed',
    sync_status: 'failed',
    retry_count: 1,
    last_attempt_at: '2026-06-12T00:00:09.000Z', // 1s ago, inside the 5s backoff
  });

  const syncable = [freshSave, justFailed].filter((entry) => isSyncable(entry, { now }));

  assert.deepEqual(
    syncable.map((entry) => entry.local_id),
    ['local-fresh'],
  );
});

test('isSyncable: ignoreBackoff lets an explicit manual retry (Settings "Sync now") through immediately', () => {
  // The escape hatch for syncNow({ force: true }) — a deliberate user tap
  // must not be silently swallowed by a backoff window it knows nothing
  // about (unlike the automatic paths, which must never set this).
  const now = new Date('2026-06-12T00:00:00.500Z').getTime(); // 0.5s after failure
  const justFailed = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 1,
    last_attempt_at: '2026-06-12T00:00:00.000Z',
  });

  assert.equal(isSyncable(justFailed, { now }), false);
  assert.equal(isSyncable(justFailed, { now, ignoreBackoff: true }), true);
});

test('isSyncable: ignoreBackoff still excludes a permanently-unsyncable URL', () => {
  const stuck = makeCreateEntry({
    sync_status: 'failed',
    last_error:
      'index row size 2888 exceeds btree version 4 maximum 2704 for index "bookmarks_user_url_hash_active_idx"',
  });
  assert.equal(isSyncable(stuck, { ignoreBackoff: true }), false);
});

const HEALTH_ESCALATED_AT = '2026-08-11T12:00:00.000Z';

test('applySyncQueueHealthEscalation marks an ordinary failure at 2 -> 3', () => {
  const previous = makeCreateEntry({ sync_status: 'failed', retry_count: 2, last_error_kind: 'other' });
  const next = makeCreateEntry({ sync_status: 'failed', retry_count: 3, last_error_kind: 'other' });
  const marked = applySyncQueueHealthEscalation(previous, next, HEALTH_ESCALATED_AT);
  assert.equal(marked.health_escalated_at, HEALTH_ESCALATED_AT);
  assert.equal(didSyncQueueHealthEscalate(previous, marked), true);
});

test('applySyncQueueHealthEscalation does not mark before the ordinary threshold', () => {
  const previous = makeCreateEntry({ sync_status: 'failed', retry_count: 1, last_error_kind: 'other' });
  const next = makeCreateEntry({ sync_status: 'failed', retry_count: 2, last_error_kind: 'other' });
  const unchanged = applySyncQueueHealthEscalation(previous, next, HEALTH_ESCALATED_AT);
  assert.equal(unchanged.health_escalated_at, undefined);
  assert.equal(didSyncQueueHealthEscalate(previous, unchanged), false);
});

test('applySyncQueueHealthEscalation does not mark an unattempted bulk row', () => {
  const previous = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 3,
    last_error_kind: 'transient_network',
  });
  const unattempted = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 3,
    last_error_kind: 'other',
  });
  const unchanged = applySyncQueueHealthEscalation(previous, unattempted, HEALTH_ESCALATED_AT);
  assert.equal(unchanged.health_escalated_at, undefined);
  assert.equal(didSyncQueueHealthEscalate(previous, unchanged), false);
});

test('applySyncQueueHealthEscalation does not mark a non-failed result', () => {
  const previous = makeCreateEntry({ sync_status: 'failed', retry_count: 5 });
  const next = makeCreateEntry({ sync_status: 'failed', retry_count: 6, last_error_kind: 'other' });
  next.sync_status = 'synced';
  const unchanged = applySyncQueueHealthEscalation(previous, next, HEALTH_ESCALATED_AT);
  assert.equal(unchanged.health_escalated_at, undefined);
});

test('applySyncQueueHealthEscalation delays transient network escalation until retry 6', () => {
  const atTwo = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 2,
    last_error_kind: 'transient_network',
  });
  const atThree = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 3,
    last_error_kind: 'transient_network',
  });
  const atFive = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 5,
    last_error_kind: 'transient_network',
  });
  const atSix = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 6,
    last_error_kind: 'transient_network',
  });
  const atThreeResult = applySyncQueueHealthEscalation(atTwo, atThree, HEALTH_ESCALATED_AT);
  const atSixResult = applySyncQueueHealthEscalation(atFive, atSix, HEALTH_ESCALATED_AT);
  assert.equal(atThreeResult.health_escalated_at, undefined);
  assert.equal(atSixResult.health_escalated_at, HEALTH_ESCALATED_AT);
});

test('a persisted marker prevents duplicate alerts when failure kinds change', () => {
  const previous = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 3,
    last_error_kind: 'transient_network',
  });
  const ordinaryAtFour = applySyncQueueHealthEscalation(
    previous,
    makeCreateEntry({ sync_status: 'failed', retry_count: 4, last_error_kind: 'other' }),
    HEALTH_ESCALATED_AT,
  );
  assert.equal(didSyncQueueHealthEscalate(previous, ordinaryAtFour), true);

  const transientAtFive = applySyncQueueHealthEscalation(
    ordinaryAtFour,
    { ...ordinaryAtFour, retry_count: 5, last_error_kind: 'transient_network' },
    '2026-08-11T12:01:00.000Z',
  );
  const transientAtSix = applySyncQueueHealthEscalation(
    transientAtFive,
    { ...transientAtFive, retry_count: 6 },
    '2026-08-11T12:02:00.000Z',
  );
  assert.equal(transientAtSix.health_escalated_at, HEALTH_ESCALATED_AT);
  assert.equal(didSyncQueueHealthEscalate(transientAtFive, transientAtSix), false);
});

test('a marker loaded after restart prevents another health escalation', () => {
  const persisted = makeCreateEntry({
    sync_status: 'failed',
    retry_count: 6,
    last_error_kind: 'transient_network',
    health_escalated_at: HEALTH_ESCALATED_AT,
  });
  const next = { ...persisted, retry_count: 7, last_error_kind: 'other' as const };
  const unchanged = applySyncQueueHealthEscalation(
    persisted,
    next,
    '2026-08-11T12:03:00.000Z',
  );
  assert.equal(unchanged.health_escalated_at, HEALTH_ESCALATED_AT);
  assert.equal(didSyncQueueHealthEscalate(persisted, unchanged), false);
});

test('findStaleQueueEntries: empty when nothing is left queued', () => {
  const stale = findStaleQueueEntries(['a', 'b'], new Set(), []);
  assert.deepEqual(stale, []);
});

test('findStaleQueueEntries: flags a completed id still sitting in the queue (STASH-3Y)', () => {
  const stale = findStaleQueueEntries(['a', 'b'], new Set(), ['a']);
  assert.deepEqual(stale, ['a']);
});

test('findStaleQueueEntries: does not flag an id this chunk legitimately re-queued (mid-flight delete / reconcile)', () => {
  const stale = findStaleQueueEntries(['a', 'b'], new Set(['a']), ['a']);
  assert.deepEqual(stale, []);
});

test('findStaleQueueEntries: ignores queue entries outside this chunk\'s completed ids (e.g. an unrelated concurrent capture)', () => {
  const stale = findStaleQueueEntries(['a'], new Set(), ['a', 'unrelated-concurrent-id']);
  assert.deepEqual(stale, ['a']);
});

test('findStaleQueueEntries: a duplicate-swap re-queue under the NEW id does not mask a leftover under the OLD id', () => {
  // STASH-3Q: a duplicate-swap re-queues under the resolved row's id, not the
  // original local id — reenqueuedLocalIds correctly contains the new id, but
  // that must not accidentally suppress a real leftover under the old one.
  const stale = findStaleQueueEntries(
    ['original-id'],
    new Set(['new-resolved-id']),
    ['original-id'],
  );
  assert.deepEqual(stale, ['original-id']);
});
