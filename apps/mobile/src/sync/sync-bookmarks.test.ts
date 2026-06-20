import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasRemoteIdentity,
  makeMutationEntry,
  reconcileOrphanedQueueEntries,
  syncQueueEntry,
} from './sync-bookmarks.ts';
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
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    sync_status: 'pending',
    ...overrides,
  };
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
    listTagData: async () => ({ tags: [], bookmarkTags: [], collections: [] }),
    replaceTagData: async () => {},
  };
  return { calls, repository };
}

function fakeApi(overrides: Partial<Record<keyof BookmarkApi, unknown>> = {}): BookmarkApi {
  return {
    createBookmark: async () => ({
      bookmark_id: 'remote-1',
      status: 'created',
      metadata_status: 'pending',
    }),
    updateBookmark: async () => makeBookmark({ id: 'remote-1', sync_status: 'synced' }),
    deleteBookmark: async () => undefined,
    ...overrides,
  } as unknown as BookmarkApi;
}

test('create: bookmark adopts the remote ID and synced status', async () => {
  const { calls, repository } = fakeRepository();
  const bookmark = makeBookmark();

  const result = await syncQueueEntry(fakeApi(), repository, makeCreateEntry(), () => bookmark);

  assert.equal(result.entry.sync_status, 'synced');
  assert.equal(result.entry.remote_id, 'remote-1');
  assert.equal(result.bookmarkReplacement?.previousId, 'local-abc');
  assert.equal(result.bookmarkReplacement?.bookmark.id, 'remote-1');
  assert.ok(calls.includes('replaceBookmark:local-abc->remote-1'));
});

test('create: uploads the LATEST title/notes, not the payload captured at save', async () => {
  const { repository } = fakeRepository();
  const sent: unknown[] = [];
  const api = fakeApi({
    createBookmark: async (input: unknown) => {
      sent.push(input);
      return { bookmark_id: 'remote-1', status: 'created', metadata_status: 'pending' };
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
    id: 'remote-1',
    sync_status: 'pending',
    is_archived: true,
    notes: 'edited after enqueue',
    site_name: 'example.com',
    favicon_url: 'https://example.com/favicon.ico',
    metadata_status: 'complete',
  });

  const entry = makeMutationEntry('remote-1', 'update');
  const result = await syncQueueEntry(api, repository, entry, () => latest);

  assert.equal(result.removeEntry, true);
  assert.deepEqual(sent[0], [
    'remote-1',
    {
      title: null,
      description: null,
      notes: 'edited after enqueue',
      collection_id: null,
      is_archived: true,
      // Generated metadata rides along so enrichment reaches the cloud.
      site_name: 'example.com',
      favicon_url: 'https://example.com/favicon.ico',
      preview_image_url: null,
      metadata_status: 'complete',
    },
  ]);
  assert.equal(result.bookmarkReplacement?.bookmark.sync_status, 'synced');
  assert.ok(calls.includes('removeQueueEntry:remote-1'));
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

  const entry = makeMutationEntry('remote-1', 'update');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.equal(apiCalled, false);
  assert.ok(calls.includes('removeQueueEntry:remote-1'));
});

test('update: failure stays retryable', async () => {
  const { repository } = fakeRepository();
  const api = fakeApi({
    updateBookmark: async () => {
      throw new Error('500');
    },
  });

  const entry = makeMutationEntry('remote-1', 'update');
  const result = await syncQueueEntry(api, repository, entry, () =>
    makeBookmark({ id: 'remote-1' }),
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

  const entry = makeMutationEntry('remote-1', 'delete');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.deepEqual(sent[0], ['remote-1', true]);
  assert.ok(calls.includes('removeQueueEntry:remote-1'));
});

test('delete: failure stays retryable', async () => {
  const { repository } = fakeRepository();
  const api = fakeApi({
    deleteBookmark: async () => {
      throw new Error('timeout');
    },
  });

  const entry = makeMutationEntry('remote-1', 'delete');
  const result = await syncQueueEntry(api, repository, entry, () => undefined);

  assert.equal(result.removeEntry, undefined);
  assert.equal(result.entry.sync_status, 'failed');
  assert.equal(result.entry.last_error, 'timeout');
});

test('hasRemoteIdentity accepts only Supabase UUIDs', () => {
  assert.equal(hasRemoteIdentity('local-m1abc-xyz'), false);
  // Non-UUID IDs (device-local rows, never-synced samples) are not remote rows
  // and must never receive mutations.
  assert.equal(hasRemoteIdentity('bookmark-local-first'), false);
  assert.equal(hasRemoteIdentity('7e64cf1e-0000-4000-8000-000000000000'), true);
});

test('update success does not remove a delete entry that superseded it', async () => {
  const supersedingDelete = makeMutationEntry('remote-1', 'delete');
  const { calls, repository } = fakeRepository([supersedingDelete]);

  const entry = makeMutationEntry('remote-1', 'update');
  const result = await syncQueueEntry(fakeApi(), repository, entry, () =>
    makeBookmark({ id: 'remote-1', sync_status: 'synced' }),
  );

  assert.equal(result.removeEntry, true);
  // The durable delete row must survive so the deletion still happens
  // after a restart.
  assert.equal(calls.includes('removeQueueEntry:remote-1'), false);
});

test('update of a missing bookmark preserves a superseding delete entry', async () => {
  const supersedingDelete = makeMutationEntry('remote-1', 'delete');
  const { calls, repository } = fakeRepository([supersedingDelete]);

  const entry = makeMutationEntry('remote-1', 'update');
  const result = await syncQueueEntry(fakeApi(), repository, entry, () => undefined);

  assert.equal(result.removeEntry, true);
  assert.equal(calls.includes('removeQueueEntry:remote-1'), false);
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
    sync_status: 'pending',
  });

  const entries = reconcileOrphanedQueueEntries([orphan], []);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.operation, 'create');
  assert.deepEqual(entries[0]?.payload, {
    title: 'Reminder',
    notes: undefined,
    shared_text: '내일 3시에 회의 있습니다',
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
  const entry = makeMutationEntry('remote-1', 'delete');
  assert.equal(entry.local_id, 'remote-1');
  assert.equal(entry.remote_id, 'remote-1');
  assert.equal(entry.operation, 'delete');
  assert.equal(entry.sync_status, 'pending');
});
