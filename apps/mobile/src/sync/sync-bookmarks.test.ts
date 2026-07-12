import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createNeedsReconcileUpdate,
  hasRemoteIdentity,
  makeMutationEntry,
  reconcileOrphanedQueueEntries,
  syncQueueEntry,
} from './sync-bookmarks.ts';
import { rekeyPendingTagOps, type PendingTagOp } from '@/domain/pending-tags';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';

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
    updateBookmark: async () => makeBookmark({ id: '00000000-0000-4000-8000-000000000001', sync_status: 'synced' }),
    deleteBookmark: async () => undefined,
    ...overrides,
  } as unknown as BookmarkApi;
}

test('create: bookmark adopts the remote ID and synced status', async () => {
  const { calls, repository } = fakeRepository();
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(fakeApi(), repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.entry.sync_status, 'synced');
  assert.equal(result.entry.remote_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(result.bookmarkReplacement?.previousId, 'local-abc');
  assert.equal(result.bookmarkReplacement?.bookmark.id, '00000000-0000-4000-8000-000000000001');
  assert.ok(calls.includes('replaceBookmark:local-abc->00000000-0000-4000-8000-000000000001'));
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
  assert.equal(result.bookmarkReplacement?.bookmark.sync_status, 'failed');
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
  assert.equal(result.bookmarkReplacement?.bookmark.sync_status, 'synced');
  assert.ok(calls.includes('removeQueueEntry:00000000-0000-4000-8000-000000000001'));
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

// A `hasPendingCreate` predicate that says "yes, a create for this id is still
// queued" — the reconcilable case. The default (omitted) predicate is "no".
const createPending = () => true;

test('update: a local-id target with a pending create is DEFERRED, never sent (issue #237)', async () => {
  // A follow-up update enqueued for a bookmark whose `create` has NOT yet
  // completed its local→remote id swap. Sending `local-…` to the Postgres `uuid`
  // column 400s ("invalid input syntax for type uuid") and wedges the entry. With
  // a create still queued to re-key it, defer (left pending, untouched).
  const { calls, repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    updateBookmark: async () => {
      apiCalled = true;
      return makeBookmark();
    },
  });
  const localId = 'local-mquc351g-wzpsqbby';
  const entry = makeMutationEntry(localId, 'update');

  const result = await syncQueueEntry(
    api,
    repository,
    entry,
    () => makeBookmark({ id: localId }),
    createPending,
  );

  assert.equal(apiCalled, false, 'the local id must never reach the server');
  assert.equal(result.removeEntry, undefined, 'entry stays queued to retry later');
  assert.equal(result.entry.sync_status, 'pending', 'deferred, not failed');
  assert.equal(result.entry.retry_count, 0, 'a deferral is not a failure');
  assert.equal(result.entry.last_error, null);
  assert.deepEqual(calls, [], 'no queue/bookmark writes on a deferral');
});

test('delete: a local-id target with a pending create is DEFERRED, never sent (issue #237)', async () => {
  const { calls, repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    deleteBookmark: async () => {
      apiCalled = true;
    },
  });
  const localId = 'local-mquc351g-wzpsqbby';
  // remote_id falls back to local_id when the create never swapped it.
  const entry: LocalPendingBookmark = { ...makeMutationEntry(localId, 'delete'), remote_id: localId };

  const result = await syncQueueEntry(api, repository, entry, () => undefined, createPending);

  assert.equal(apiCalled, false, 'the local id must never reach the server');
  assert.equal(result.removeEntry, undefined, 'entry stays queued to retry later');
  assert.equal(result.entry.sync_status, 'pending', 'deferred, not failed');
  assert.deepEqual(calls, []);
});

test('update: a seeded (bookmark-…) target with a pending create is DEFERRED too', async () => {
  const { repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    updateBookmark: async () => {
      apiCalled = true;
      return makeBookmark();
    },
  });
  const entry = makeMutationEntry('bookmark-seed-1', 'update');

  const result = await syncQueueEntry(
    api,
    repository,
    entry,
    () => makeBookmark({ id: 'bookmark-seed-1' }),
    createPending,
  );

  assert.equal(apiCalled, false);
  assert.equal(result.entry.sync_status, 'pending');
});

test('update: an ORPHANED local-id target (no pending create) is PROMOTED to a create and uploaded', async () => {
  // No create will ever re-key this entry, so a bare `update` can never target a
  // remote row — it would just re-fail every pass, stranding the bookmark as
  // "sync failed" forever. The row still exists locally, so promote to a create:
  // upload it (idempotent on URL), adopt the remote id, and leave the queue.
  const { calls, repository } = fakeRepository();
  let updateCalled = false;
  let createdPayload: unknown = null;
  const api = fakeApi({
    updateBookmark: async () => {
      updateCalled = true;
      return makeBookmark();
    },
    createBookmark: async (payload: unknown) => {
      createdPayload = payload;
      return {
        bookmark_id: '00000000-0000-4000-8000-000000000099',
        status: 'created',
        metadata_status: 'pending',
      };
    },
  });
  const localId = 'local-mquc351g-wzpsqbby';
  const entry = makeMutationEntry(localId, 'update');

  // Default predicate => no pending create => orphaned.
  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: localId, url: 'https://example.com/a' }),
  );

  assert.equal(updateCalled, false, 'a local id must never be sent as an update');
  assert.equal(result.entry.sync_status, 'synced', 'promoted create settled the entry');
  assert.equal(result.entry.operation, 'create', 'the entry was promoted to a create');
  assert.equal(result.entry.remote_id, '00000000-0000-4000-8000-000000000099');
  assert.equal(
    result.bookmarkReplacement?.bookmark.id,
    '00000000-0000-4000-8000-000000000099',
    'the local row is re-keyed onto the remote id',
  );
  assert.ok(result.uploadedPayload, 'uploadedPayload signals a create ran, so the caller reconciles');
  assert.equal((createdPayload as { url?: string })?.url, 'https://example.com/a');
  assert.ok(
    calls.includes('replaceBookmark:local-mquc351g-wzpsqbby->00000000-0000-4000-8000-000000000099'),
  );
});

test('update: an ORPHANED local-id target with no URL or text SETTLES failed (cannot become a create)', async () => {
  // A row a create can't carry (no URL, no body) can never reach the server, so
  // promotion is impossible. Settle `failed` (does NOT re-fire the auto-sync
  // loop) so it stops hot-looping while still retrying on a later save / Sync.
  const { repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    createBookmark: async () => {
      apiCalled = true;
      throw new Error('should not be called');
    },
  });
  const localId = 'local-mquc351g-wzpsqbby';
  const entry = makeMutationEntry(localId, 'update');

  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: localId, url: null, description: null, content_type: 'text' }),
  );

  assert.equal(apiCalled, false, 'nothing uploadable, so no create is attempted');
  assert.equal(result.entry.sync_status, 'failed', 'settled failed, NOT pending');
  assert.equal(result.entry.retry_count, 1);
  assert.match(result.entry.last_error ?? '', /no remote identity/i);
});

test('update: an ORPHANED local-id target whose row is gone leaves the queue cleanly', async () => {
  // The local row was deleted, so there is nothing to update or create. Settle
  // by removing the queue entry rather than failing it forever.
  const { calls, repository } = fakeRepository();
  const localId = 'local-mquc351g-wzpsqbby';
  const entry = makeMutationEntry(localId, 'update');

  const result = await syncQueueEntry(fakeApi(), repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.equal(result.entry.sync_status, 'synced');
  assert.ok(calls.includes('removeQueueEntry:local-mquc351g-wzpsqbby'));
});

test('delete: an ORPHANED local-id target (no pending create) is REMOVED, no remote delete (issue #237)', async () => {
  // The row never reached the server (its id is still local) and the local
  // delete already happened — there is nothing to delete remotely, so the entry
  // settles cleanly by leaving the queue.
  const { calls, repository } = fakeRepository();
  let apiCalled = false;
  const api = fakeApi({
    deleteBookmark: async () => {
      apiCalled = true;
    },
  });
  const localId = 'local-mquc351g-wzpsqbby';
  const entry: LocalPendingBookmark = { ...makeMutationEntry(localId, 'delete'), remote_id: localId };

  // Default predicate => no pending create => orphaned.
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(apiCalled, false, 'no remote delete must be attempted');
  assert.equal(result.removeEntry, true, 'entry settles by leaving the queue');
  assert.equal(result.entry.sync_status, 'synced');
  assert.ok(calls.includes(`removeQueueEntry:${localId}`));
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
  const persisted = created.bookmarkReplacement?.bookmark;
  assert.ok(persisted);
  assert.equal(persisted.deleted_at, '2026-06-24T00:00:00.000Z');
  assert.equal('deleted_at' in (createReceived[0] as object), false);

  // The store's reconcile decides a follow-up update is needed (the fix), and
  // enqueues makeMutationEntry(persisted.id, 'update').
  assert.equal(createNeedsReconcileUpdate(persisted, created.uploadedPayload), true);
  const followUp = makeMutationEntry(persisted.id, 'update');

  // Pass 2: process that update against the (still trashed) remote-id row.
  const remoteRow = makeBookmark({ id: '00000000-0000-4000-8000-000000000001', deleted_at: '2026-06-24T00:00:00.000Z' });
  await syncQueueEntry(api, repository, followUp, () => remoteRow);

  // The cloud row is now trashed: api.updateBookmark received deleted_at for it.
  assert.equal(updateReceived.length, 1);
  assert.equal(updateReceived[0]?.[0], '00000000-0000-4000-8000-000000000001');
  assert.equal(updateReceived[0]?.[1]?.deleted_at, '2026-06-24T00:00:00.000Z');
});

test('create-sync tag re-key: a tag op parked on the local id moves to the remote id and becomes uploadable', async () => {
  // Models the store's post-create reconcile (#2 fix). A tag op (carried over
  // from account re-home, or added before the create synced) is queued against
  // the local id. syncTagOps skips non-remote ids via hasRemoteIdentity, so
  // without re-keying it would never upload. Drive the create, then apply the
  // exact {previousId -> remote id} re-key the store performs.
  const { repository } = fakeRepository();
  const local = makeBookmark({ id: 'local-abc', sync_status: 'pending' });
  // A real Supabase UUID so the re-keyed op passes the hasRemoteIdentity gate.
  const remoteUuid = '7e64cf1e-0000-4000-8000-000000000001';
  const api = fakeApi({
    createBookmark: async () => ({
      bookmark_id: remoteUuid,
      status: 'created',
      metadata_status: 'pending',
    }),
  });

  const result = await syncQueueEntry(api, repository, makeCreateEntry(), () => local);
  const previousId = result.bookmarkReplacement?.previousId;
  const remoteId = result.bookmarkReplacement?.bookmark.id;
  assert.equal(previousId, 'local-abc');
  assert.equal(remoteId, remoteUuid);

  // The tag op was queued against the local id — not yet uploadable.
  let tagOps: PendingTagOp[] = [
    {
      id: 'op-1',
      bookmark_id: 'local-abc',
      tag_name: 'design',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: '2026-06-12T00:00:00.000Z',
    },
  ];
  assert.equal(hasRemoteIdentity(tagOps[0]!.bookmark_id), false);

  // The reconcile re-keys it onto the new remote id…
  tagOps = rekeyPendingTagOps(tagOps, new Map([[previousId!, remoteId!]]));

  // …so it now targets a remote row and syncTagOps will actually upload it.
  assert.equal(tagOps[0]?.bookmark_id, remoteUuid);
  assert.equal(hasRemoteIdentity(tagOps[0]!.bookmark_id), true);
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
    url: 'https://example.com/a',
    title: 'Stranded',
    notes: 'keep me',
    client_id: undefined,
  });
});

test('reconcileOrphanedQueueEntries re-queues an update for a stranded synced-id bookmark', () => {
  const orphan = makeBookmark({ id: REMOTE_ID, sync_status: 'pending' });

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
