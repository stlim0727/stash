import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LAST_PULLED_AT_KEY, pullRemoteChanges } from './pull-bookmarks.ts';
import type { PullApi } from './pull-bookmarks.ts';
import type { AIEnrichment, Bookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';

const REMOTE_ID_A = '7e64cf1e-0000-4000-8000-00000000000a';
const REMOTE_ID_B = '7e64cf1e-0000-4000-8000-00000000000b';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: REMOTE_ID_A,
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
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}

function makeEnrichment(overrides: Partial<AIEnrichment> = {}): AIEnrichment {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'enr-1',
    bookmark_id: REMOTE_ID_A,
    user_id: 'user-test',
    summary: 'Cloud summary',
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    model: 'cloud-pipeline',
    status: 'complete',
    confidence: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function fakeRepository(meta: Record<string, string> = {}) {
  const calls: string[] = [];
  const repository: BookmarkRepository = {
    init: async () => {},
    listBookmarks: async () => [],
    insertBookmark: async (bookmark) => {
      calls.push(`insertBookmark:${bookmark.id}`);
    },
    updateBookmark: async () => {},
    replaceBookmark: async () => {},
    deleteBookmark: async (id) => {
      calls.push(`deleteBookmark:${id}`);
    },
    listQueue: async () => [],
    enqueue: async () => {},
    updateQueueEntry: async () => {},
    removeQueueEntry: async () => {},
    getMeta: async (key) => meta[key] ?? null,
    setMeta: async (key, value) => {
      meta[key] = value;
      calls.push(`setMeta:${key}`);
    },
    listEnrichments: async () => [],
    upsertEnrichments: async (enrichments) => {
      calls.push(`upsertEnrichments:${enrichments.length}`);
    },
  };
  return { calls, meta, repository };
}

function fakeApi(overrides: Partial<PullApi> = {}): PullApi {
  return {
    listBookmarksUpdatedSince: async () => [],
    listBookmarkIds: async () => [],
    listEnrichmentsUpdatedSince: async () => [],
    ...overrides,
  };
}

test('pull inserts new remote rows and persists them', async () => {
  const { calls, repository } = fakeRepository();
  const remote = makeBookmark();
  const api = fakeApi({
    listBookmarksUpdatedSince: async () => [remote],
    listBookmarkIds: async () => [remote.id],
  });

  const result = await pullRemoteChanges(api, repository, () => [], () => false);

  assert.deepEqual(
    result.upserts.map((bookmark) => bookmark.id),
    [remote.id],
  );
  assert.ok(calls.includes(`insertBookmark:${remote.id}`));
  assert.ok(calls.includes(`setMeta:${LAST_PULLED_AT_KEY}`));
});

test('pull applies last-write-wins by updated_at', async () => {
  const { repository } = fakeRepository();
  const older = makeBookmark({ updated_at: '2026-06-12T00:00:00.000Z', title: 'Old' });
  const newerRemote = makeBookmark({ updated_at: '2026-06-12T01:00:00.000Z', title: 'New' });
  const api = fakeApi({
    listBookmarksUpdatedSince: async () => [newerRemote],
    listBookmarkIds: async () => [newerRemote.id],
  });

  const wins = await pullRemoteChanges(api, repository, () => [older], () => false);
  assert.equal(wins.upserts[0]?.title, 'New');

  const newerLocal = makeBookmark({ updated_at: '2026-06-12T02:00:00.000Z' });
  const loses = await pullRemoteChanges(api, repository, () => [newerLocal], () => false);
  assert.equal(loses.upserts.length, 0);
});

test('pull never overwrites or deletes rows with queued local work', async () => {
  const { calls, repository } = fakeRepository();
  const local = makeBookmark({ updated_at: '2026-06-12T00:00:00.000Z' });
  const remote = makeBookmark({ updated_at: '2026-06-12T05:00:00.000Z' });
  const api = fakeApi({
    listBookmarksUpdatedSince: async () => [remote],
    // The row is also missing remotely — even so, queued work protects it.
    listBookmarkIds: async () => [],
  });

  const result = await pullRemoteChanges(api, repository, () => [local], () => true);

  assert.equal(result.upserts.length, 0);
  assert.equal(result.deletions.length, 0);
  assert.equal(calls.includes(`deleteBookmark:${local.id}`), false);
});

test('pull removes synced rows deleted remotely, keeps local-only rows', async () => {
  const { calls, repository } = fakeRepository();
  const goneRemotely = makeBookmark({ id: REMOTE_ID_B });
  const localOnly = makeBookmark({ id: 'local-abc123', sync_status: 'pending' });
  const api = fakeApi({ listBookmarkIds: async () => [] });

  const result = await pullRemoteChanges(
    api,
    repository,
    () => [goneRemotely, localOnly],
    () => false,
  );

  assert.deepEqual(result.deletions, [REMOTE_ID_B]);
  assert.ok(calls.includes(`deleteBookmark:${REMOTE_ID_B}`));
  assert.equal(calls.includes('deleteBookmark:local-abc123'), false);
});

test('pull refreshes the enrichment cache', async () => {
  const { calls, repository } = fakeRepository();
  const enrichment = makeEnrichment();
  const api = fakeApi({ listEnrichmentsUpdatedSince: async () => [enrichment] });

  const result = await pullRemoteChanges(api, repository, () => [], () => false);

  assert.deepEqual(result.enrichments, [enrichment]);
  assert.ok(calls.includes('upsertEnrichments:1'));
});

test('pull overlaps the stored watermark for clock skew', async () => {
  const { repository } = fakeRepository({
    [LAST_PULLED_AT_KEY]: '2026-06-12T10:00:00.000Z',
  });
  let receivedSince: string | null = 'unset';
  const api = fakeApi({
    listBookmarksUpdatedSince: async (since) => {
      receivedSince = since;
      return [];
    },
  });

  await pullRemoteChanges(api, repository, () => [], () => false);

  assert.equal(receivedSince, '2026-06-12T09:55:00.000Z');
});

test('first pull fetches everything (null watermark)', async () => {
  const { repository } = fakeRepository();
  let receivedSince: string | null = 'unset';
  const api = fakeApi({
    listBookmarksUpdatedSince: async (since) => {
      receivedSince = since;
      return [];
    },
  });

  await pullRemoteChanges(api, repository, () => [], () => false);

  assert.equal(receivedSince, null);
});
