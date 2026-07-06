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
  } as Bookmark;
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
    suggested_collection_name: null,
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

test('a winning remote upsert preserves device-only fields from the local row', async () => {
  const { repository } = fakeRepository();
  // Local row was opened on this device (last_accessed_at) and the remote copy
  // was edited elsewhere (newer updated_at) — the remote has no notion of either
  // device-only field, so the upsert must carry them over rather than erase them.
  const local = makeBookmark({
    updated_at: '2026-06-12T00:00:00.000Z',
    last_accessed_at: '2026-06-13T09:00:00.000Z',
    local_image_uri: 'file:///stash-images/x.jpg',
  });
  const remote = makeBookmark({
    updated_at: '2026-06-12T01:00:00.000Z',
    last_accessed_at: undefined,
    local_image_uri: undefined,
    title: 'Edited elsewhere',
  });
  const api = fakeApi({
    listBookmarksUpdatedSince: async () => [remote],
    listBookmarkIds: async () => [remote.id],
  });

  const result = await pullRemoteChanges(api, repository, () => [local], () => false);

  assert.equal(result.upserts.length, 1);
  assert.equal(result.upserts[0]?.title, 'Edited elsewhere');
  assert.equal(result.upserts[0]?.last_accessed_at, '2026-06-13T09:00:00.000Z');
  assert.equal(result.upserts[0]?.local_image_uri, 'file:///stash-images/x.jpg');
});

test('pull propagates a remote trash (deleted_at) onto the local row', async () => {
  // Another device trashed an already-synced bookmark: its update pushed
  // deleted_at to the cloud, the row's updated_at advanced, so this device must
  // pull the trash down and upsert it (deleted_at carries through the mapper).
  const { calls, repository } = fakeRepository();
  const local = makeBookmark({ updated_at: '2026-06-12T00:00:00.000Z', deleted_at: null });
  const remoteTrashed = makeBookmark({
    updated_at: '2026-06-12T05:00:00.000Z',
    deleted_at: '2026-06-12T05:00:00.000Z',
  });
  const api = fakeApi({
    listBookmarksUpdatedSince: async () => [remoteTrashed],
    // The trashed row is a soft delete — it still exists server-side, so it is
    // still in the id list and must NOT be treated as a hard remote deletion.
    listBookmarkIds: async () => [remoteTrashed.id],
  });

  const result = await pullRemoteChanges(api, repository, () => [local], () => false);

  assert.equal(result.upserts.length, 1);
  assert.equal(result.upserts[0]?.deleted_at, '2026-06-12T05:00:00.000Z');
  assert.deepEqual(result.deletions, []);
  assert.ok(calls.includes(`insertBookmark:${remoteTrashed.id}`));
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

test('an anonymous session never runs the deletion diff, even after re-stamping (real→anon mint)', async () => {
  // Incident repro: a failed real-session restore minted a throwaway anonymous
  // user while the local cache still held a real account's 136 synced rows. The
  // anon account's remote set is empty. Two consecutive pulls happen.
  const { calls, meta, repository } = fakeRepository({
    // The cache was last synced against the REAL account.
    [SYNCED_USER_ID_KEY]: 'real-user',
    [LAST_PULLED_AT_KEY]: '2026-07-06T02:55:12.000Z',
  });
  const syncedRealRow = makeBookmark({ id: REMOTE_ID_B, sync_status: 'synced' });
  const anonUser = { id: 'anon-mint', isAnonymous: true };
  const api = fakeApi({ listBookmarkIds: async () => [] }); // anon account is empty

  // Pull #1: userChanged (real-user → anon-mint) already skips deletions, but it
  // re-stamps SYNCED_USER_ID to the anon id at the end.
  const first = await pullRemoteChanges(api, repository, () => [syncedRealRow], () => false, anonUser);
  assert.equal(first.userChanged, true);
  assert.deepEqual(first.deletions, []);
  assert.equal(meta[SYNCED_USER_ID_KEY], 'anon-mint');

  // Pull #2: previousUserId === currentUser.id, so userChanged is now FALSE.
  // Without the anonymous guard this pass wipes the still-owned synced row as a
  // phantom "deleted on another device" — the local data-loss incident.
  const second = await pullRemoteChanges(api, repository, () => [syncedRealRow], () => false, anonUser);
  assert.equal(second.userChanged, false);
  assert.deepEqual(second.deletions, []);
  assert.equal(calls.includes(`deleteBookmark:${REMOTE_ID_B}`), false);
});

test('an anonymous pull with an empty remote does not wipe the durable tag cache', async () => {
  // Companion to the row-wipe: replaceTagData is a wholesale destructive replace.
  // An anonymous session with an empty remote snapshot must not nuke a real
  // account's tags still cached durably after a failed session restore.
  const { calls, repository } = fakeRepository({ [SYNCED_USER_ID_KEY]: 'anon-mint' });
  const api = fakeApi({ listBookmarkIds: async () => [] }); // empty tags/collections/links

  await pullRemoteChanges(api, repository, () => [], () => false, {
    id: 'anon-mint',
    isAnonymous: true,
  });

  assert.equal(calls.includes('replaceTagData:0:0'), false);
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
