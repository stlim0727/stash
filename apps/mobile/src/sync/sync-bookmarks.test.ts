import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNeedsReconcileUpdate,
  hasBulkCreateResultKey,
  hasRemoteIdentity,
  isSyncable,
  makeMutationEntry,
  reconcileOrphanedQueueEntries,
  syncCreateQueueEntryBatch,
  syncQueueEntry,
} from './sync-bookmarks.ts';
import { BOOKMARK_NOT_FOUND_ERROR_MESSAGE } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
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
    insertBookmark: async () => {},
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

test('bulk create: rejects non-create queue entries', async () => {
  const update = makeMutationEntry('00000000-0000-4000-8000-000000000001', 'update');

  await assert.rejects(
    () => syncCreateQueueEntryBatch(fakeApi(), [update], () => undefined),
    /only accepts create/,
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
  assert.equal(result.bookmarkUpdate?.sync_status, 'failed');
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
  assert.equal('deleted_at' in (createReceived[0] as object), false);

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
