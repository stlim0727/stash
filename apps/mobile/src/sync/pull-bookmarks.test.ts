import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LAST_PULLED_AT_KEY,
  SYNCED_USER_ID_KEY,
  pullRemoteChanges,
} from './pull-bookmarks.ts';
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
    degraded: false,
    degraded_reason: null,
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
    listTagData: async () => ({ tags: [], bookmarkTags: [], collections: [] }),
    replaceTagData: async (data) => {
      calls.push(`replaceTagData:${data.tags.length}:${data.collections.length}`);
    },
  };
  return { calls, meta, repository };
}

function fakeApi(overrides: Partial<PullApi> = {}): PullApi {
  return {
    listBookmarksUpdatedSince: async () => [],
    listBookmarkIds: async () => [],
    listEnrichmentsUpdatedSince: async () => [],
    listTags: async () => [],
    listBookmarkTags: async () => [],
    listCollections: async () => [],
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

test('pull replaces the tag-data snapshot wholesale', async () => {
  const { calls, repository } = fakeRepository();
  const api = fakeApi({
    listTags: async () => [
      {
        id: 'tag-1',
        user_id: 'user-test',
        name: 'design',
        slug: 'design',
        source: 'user',
        created_at: '2026-06-12T00:00:00.000Z',
      },
    ],
    listCollections: async () => [
      {
        id: 'col-1',
        user_id: 'user-test',
        name: 'Research',
        description: null,
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      },
    ],
  });

  const result = await pullRemoteChanges(api, repository, () => [], () => false);

  assert.equal(result.tagData.tags.length, 1);
  assert.equal(result.tagData.collections.length, 1);
  assert.ok(calls.includes('replaceTagData:1:1'));
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

test('records the synced user id and reports no change on first sync', async () => {
  const { meta, repository } = fakeRepository();
  const api = fakeApi();

  const result = await pullRemoteChanges(api, repository, () => [], () => false, {
    id: 'user-1',
    isAnonymous: true,
  });

  assert.equal(result.userChanged, false);
  assert.equal(meta[SYNCED_USER_ID_KEY], 'user-1');
});

test('account switch skips deletions and resets the watermark', async () => {
  const { calls, repository } = fakeRepository({
    [SYNCED_USER_ID_KEY]: 'anon-user',
    [LAST_PULLED_AT_KEY]: '2026-06-12T10:00:00.000Z',
  });
  // A bookmark synced under the previous account, absent from the new account.
  const previousAccountRow = makeBookmark({ id: REMOTE_ID_B });
  let receivedSince: string | null = 'unset';
  const api = fakeApi({
    listBookmarkIds: async () => [], // new account is empty
    listBookmarksUpdatedSince: async (since) => {
      receivedSince = since;
      return [];
    },
  });

  const result = await pullRemoteChanges(
    api,
    repository,
    () => [previousAccountRow],
    () => false,
    { id: 'google-user', isAnonymous: false },
  );

  // The catastrophic wipe is prevented: no deletions despite the empty account.
  assert.equal(result.userChanged, true);
  assert.deepEqual(result.deletions, []);
  assert.equal(calls.includes(`deleteBookmark:${REMOTE_ID_B}`), false);
  // Full refresh: the previous account's watermark is not reused.
  assert.equal(receivedSince, null);
});

test('same user still reconciles genuine remote deletions', async () => {
  const { calls, repository } = fakeRepository({ [SYNCED_USER_ID_KEY]: 'user-1' });
  const goneRemotely = makeBookmark({ id: REMOTE_ID_B });
  const api = fakeApi({ listBookmarkIds: async () => [] });

  const result = await pullRemoteChanges(api, repository, () => [goneRemotely], () => false, {
    id: 'user-1',
    isAnonymous: false,
  });

  assert.equal(result.userChanged, false);
  assert.deepEqual(result.deletions, [REMOTE_ID_B]);
  assert.ok(calls.includes(`deleteBookmark:${REMOTE_ID_B}`));
});
