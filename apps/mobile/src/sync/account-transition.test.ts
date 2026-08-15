import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyAccountTransition,
  planAccountTransition,
  planLogoutCacheClear,
} from './account-transition.ts';
import {
  dropPendingTagOpsForBookmarks,
  rekeyPendingTagOps,
  type PendingTagOp,
} from '@/domain/pending-tags';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';

const REMOTE_A = '7e64cf1e-0000-4000-8000-00000000000a';
const REMOTE_B = '7e64cf1e-0000-4000-8000-00000000000b';

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-16T00:00:00.000Z';
  return {
    id: REMOTE_A,
    user_id: 'u',
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

test('first sync has nothing to reconcile', () => {
  const plan = planAccountTransition(null, { id: 'anon', isAnonymous: true }, [bookmark()]);
  assert.equal(plan.kind, 'first');
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, []);
  assert.equal(plan.resetWatermark, false);
});

test('same user is a no-op', () => {
  const plan = planAccountTransition(
    { id: 'u1', isAnonymous: false },
    { id: 'u1', isAnonymous: false },
    [bookmark()],
  );
  assert.equal(plan.kind, 'none');
  assert.deepEqual(plan.drop, []);
});

test('anonymous -> real account carries the synced rows over (re-home)', () => {
  const rows = [bookmark({ id: REMOTE_A }), bookmark({ id: REMOTE_B })];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'google-user', isAnonymous: false },
    rows,
  );
  assert.equal(plan.kind, 'carry-over');
  assert.deepEqual(
    plan.rehome.map((b) => b.id),
    [REMOTE_A, REMOTE_B],
  );
  assert.deepEqual(plan.drop, []);
  assert.equal(plan.resetWatermark, true);
});

test('real account A -> real account B drops A’s local cache (no merge)', () => {
  const plan = planAccountTransition(
    { id: 'A', isAnonymous: false },
    { id: 'B', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );
  assert.equal(plan.kind, 'switch');
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, [REMOTE_A]);
  assert.deepEqual(plan.dropQueue, [REMOTE_A]);
  assert.equal(plan.resetWatermark, true);
});

test('real account -> anonymous PRESERVES the cache (never drops) — session-expiry guard', () => {
  // A real session that fails to restore can leave the app minting a throwaway
  // anonymous user. That is never a deliberate "different person" switch, so it
  // must NOT be treated like real A -> real B: dropping the cache here produced
  // the silent empty-Inbox "logged out" screen. Every row is preserved; the
  // user's data is still theirs and reappears when they re-sign-in.
  const plan = planAccountTransition(
    { id: 'real-A', isAnonymous: false },
    { id: 'anon-B', isAnonymous: true },
    [
      bookmark({ id: REMOTE_A, sync_status: 'synced' }),
      bookmark({ id: REMOTE_B, sync_status: 'pending' }),
      bookmark({ id: 'local-keep', sync_status: 'pending' }),
    ],
  );
  assert.equal(plan.kind, 'none');
  assert.deepEqual(plan.drop, []);
  assert.deepEqual(plan.dropQueue, []);
  assert.deepEqual(plan.rehome, []);
});

test('real A→real B also drops pending-edit cloud rows (and their queued ops)', () => {
  // A row A synced then edited flips to `pending` with an update op keyed to A's
  // UUID. The old synced-only filter KEPT it, so it would fire under B and 404.
  const plan = planAccountTransition(
    { id: 'A', isAnonymous: false },
    { id: 'B', isAnonymous: false },
    [
      bookmark({ id: REMOTE_A, sync_status: 'synced' }),
      bookmark({ id: REMOTE_B, sync_status: 'pending', ever_synced: true }), // edited-after-sync
      bookmark({ id: 'local-keep', sync_status: 'pending' }), // never-synced local create
    ],
  );
  assert.deepEqual(plan.drop, [REMOTE_A, REMOTE_B]);
  assert.deepEqual(plan.dropQueue, [REMOTE_A, REMOTE_B]);
});

test('only cloud-owned rows are touched — local/seed rows are left alone', () => {
  const rows = [
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: 'local-abc', sync_status: 'pending' }), // device-local
    bookmark({ id: 'bookmark-seed-1', sync_status: 'synced' }), // seeded sample
    bookmark({ id: REMOTE_B, sync_status: 'pending' }), // synced id but not yet synced
  ];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    rows,
  );
  // Only the genuinely cloud-owned row (UUID id + synced) is carried over.
  assert.deepEqual(
    plan.rehome.map((b) => b.id),
    [REMOTE_A],
  );
});

test('carry-over never re-homes a local-only image bookmark (Sentry STASH-65)', () => {
  // Image bookmarks get a real UUID id and sync_status: 'synced' even though
  // the binary was never uploaded (cloud upload of images is deferred). If
  // carried over as a genuine cloud row, it would be re-queued as a `create`
  // under the new account via createPayloadFromBookmark, which has no
  // image-upload support.
  const rows = [
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: REMOTE_B, sync_status: 'synced', content_type: 'image' }),
  ];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    rows,
  );
  assert.deepEqual(
    plan.rehome.map((b) => b.id),
    [REMOTE_A],
  );
});

test('planLogoutCacheClear drops the logged-out account’s cloud rows', () => {
  const plan = planLogoutCacheClear([bookmark({ id: REMOTE_A }), bookmark({ id: REMOTE_B })]);
  assert.equal(plan.kind, 'logout');
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, [REMOTE_A, REMOTE_B]);
  // Their queued ops (keyed by local_id === remote UUID) drop in lockstep.
  assert.deepEqual(plan.dropQueue, [REMOTE_A, REMOTE_B]);
  assert.equal(plan.resetWatermark, true);
});

test('planLogoutCacheClear leaves never-synced LOCAL captures in place but drops pending EDITS to cloud rows', () => {
  const plan = planLogoutCacheClear([
    bookmark({ id: REMOTE_A, sync_status: 'synced' }), // cloud-owned — drop
    bookmark({ id: 'local-pending-1', sync_status: 'pending' }), // local create — keep
    // A previously-synced cloud row the account then EDITED: now `pending` with a
    // remote UUID and an update op keyed to the departing account. Must be dropped
    // (op would 404 under the next identity), even though it isn't `synced`.
    bookmark({ id: REMOTE_B, sync_status: 'pending', ever_synced: true }),
    bookmark({ id: 'bookmark-seed-1', sync_status: 'synced' }), // seed (no remote identity) — keep
  ]);
  // Both cloud-identity rows drop; the local create and the seed survive.
  assert.deepEqual(plan.drop, [REMOTE_A, REMOTE_B]);
  assert.deepEqual(plan.dropQueue, [REMOTE_A, REMOTE_B]);
});

test('planLogoutCacheClear never drops a local-only image bookmark (Sentry STASH-65)', () => {
  // Without excluding local-only rows, a logout (or a real A->real B switch,
  // same cloudRemoteRows filter) would DELETE a never-uploaded image bookmark
  // as if it were the departing account's confirmed cloud row.
  const plan = planLogoutCacheClear([
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: REMOTE_B, sync_status: 'synced', content_type: 'image' }),
  ]);
  assert.deepEqual(plan.drop, [REMOTE_A]);
  assert.deepEqual(plan.dropQueue, [REMOTE_A]);
});

test('applyAccountTransition (logout drop) removes only the dropped synced rows', async () => {
  const plan = planLogoutCacheClear([
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: 'local-pending-1', sync_status: 'pending' }),
  ]);

  let bookmarks: Bookmark[] | null = [
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: 'local-pending-1', sync_status: 'pending' }),
  ];
  const deleted: string[] = [];
  const repo = fakeRepository();
  repo.deleteBookmark = async (id: string) => {
    deleted.push(id);
  };

  await applyAccountTransition(
    plan,
    repo,
    (updater) => {
      bookmarks = updater(bookmarks);
    },
    () => {},
    () => 'local-x',
    async () => {},
    { drop: () => {} },
  );

  // The synced cloud row is gone from the cache + repository…
  assert.deepEqual(
    bookmarks?.map((b) => b.id),
    ['local-pending-1'],
  );
  assert.deepEqual(deleted, [REMOTE_A]);
});

function queueEntry(overrides: Partial<LocalPendingBookmark> = {}): LocalPendingBookmark {
  const now = '2026-06-16T00:00:00.000Z';
  return {
    local_id: REMOTE_A,
    remote_id: REMOTE_A,
    operation: 'update',
    payload: { url: 'https://example.com/a' } as LocalPendingBookmark['payload'],
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test('applyAccountTransition (logout) drops a pending EDIT row AND its update queue entry, preserving a never-synced local create', async () => {
  // REMOTE_B was synced then edited → now `pending` with an update op keyed to
  // the departing account's UUID. local-create has never reached any cloud.
  const rows = [
    bookmark({ id: REMOTE_A, sync_status: 'synced' }),
    bookmark({ id: REMOTE_B, sync_status: 'pending', ever_synced: true }),
    bookmark({ id: 'local-create-1', sync_status: 'pending' }),
  ];
  const plan = planLogoutCacheClear(rows);
  assert.deepEqual(plan.drop, [REMOTE_A, REMOTE_B]);
  assert.deepEqual(plan.dropQueue, [REMOTE_A, REMOTE_B]);

  let bookmarks: Bookmark[] | null = rows;
  let queue: LocalPendingBookmark[] = [
    queueEntry({ local_id: REMOTE_A, operation: 'update' }),
    queueEntry({ local_id: REMOTE_B, operation: 'update' }),
    // Never-synced local create — must survive (capture is sacred).
    queueEntry({ local_id: 'local-create-1', remote_id: null, operation: 'create' }),
  ];
  const deleted: string[] = [];
  const queueRemoved: string[] = [];
  const repo = fakeRepository();
  repo.deleteBookmark = async (id: string) => {
    deleted.push(id);
  };
  repo.removeQueueEntry = async (localId: string) => {
    queueRemoved.push(localId);
  };

  await applyAccountTransition(
    plan,
    repo,
    (updater) => {
      bookmarks = updater(bookmarks);
    },
    (updater) => {
      queue = updater(queue);
    },
    () => 'local-x',
    async () => {},
    { drop: () => {} },
  );

  // Both cloud rows gone; the never-synced local create survives.
  assert.deepEqual(
    bookmarks?.map((b) => b.id),
    ['local-create-1'],
  );
  assert.deepEqual(deleted, [REMOTE_A, REMOTE_B]);
  // The update ops are dropped from the in-memory queue AND the repository;
  // only the local create's entry remains.
  assert.deepEqual(
    queue.map((e) => e.local_id),
    ['local-create-1'],
  );
  assert.deepEqual(queueRemoved.sort(), [REMOTE_A, REMOTE_B].sort());
});

function fakeRepository(): BookmarkRepository {
  return {
    init: async () => {},
    listBookmarks: async () => [],
    getBookmark: async () => null,
    insertBookmark: async () => {},
    updateBookmark: async () => {},
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
}

test('applyAccountTransition re-keys pending tag ops from the old id to the new local id', async () => {
  // Carry-over re-homes REMOTE_A to a fresh local id. A tag op queued against
  // the OLD id would fire addTags against a bookmark the new account never had,
  // silently dropping the carried-over tag. The re-home must re-key it.
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );

  let queue: LocalPendingBookmark[] = [];
  let bookmarks: Bookmark[] | null = [bookmark({ id: REMOTE_A })];
  let pendingTagOps: PendingTagOp[] = [
    {
      id: 'op-1',
      bookmark_id: REMOTE_A,
      tag_name: 'design',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: '2026-06-16T00:00:00.000Z',
    },
  ];

  let counter = 0;
  const makeLocalId = () => `local-rehomed-${(counter += 1)}`;

  await applyAccountTransition(
    plan,
    fakeRepository(),
    (updater) => {
      bookmarks = updater(bookmarks);
    },
    (updater) => {
      queue = updater(queue);
    },
    makeLocalId,
    async () => {},
    {
      rehome: (idMap) => {
        pendingTagOps = rekeyPendingTagOps(pendingTagOps, idMap);
      },
    },
  );

  // The re-homed bookmark's new local id…
  const newId = bookmarks?.[0]?.id;
  assert.ok(newId?.startsWith('local-rehomed-'));
  assert.notEqual(newId, REMOTE_A);
  // …is now what the carried-over tag op targets (not the orphaned old id).
  assert.equal(pendingTagOps.length, 1);
  assert.equal(pendingTagOps[0]?.bookmark_id, newId);
  // And a fresh create entry was queued for the re-homed row.
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.local_id, newId);
  assert.equal(queue[0]?.operation, 'create');
});

test('applyAccountTransition commits rehomed rows and organization state through one repository call', async () => {
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );
  const base = fakeRepository();
  let batchCalls = 0;
  let replacementCount = 0;
  let entryCount = 0;
  let persistedBookmarkId = '';
  let persistedMeta = '';
  base.replaceBookmarkIdentities = async (replacements, entries, state) => {
    batchCalls += 1;
    replacementCount = replacements.length;
    entryCount = entries.length;
    persistedBookmarkId = replacements[0]?.bookmark.id ?? '';
    persistedMeta = state.metaUpdates.pending_import_collections ?? '';
  };

  await applyAccountTransition(
    plan,
    base,
    () => {},
    () => {},
    () => 'local-rehomed-atomic',
    async () => {},
    {
      rehome: (idMap) => ({
        metaUpdates: {
          pending_import_collections: JSON.stringify([
            { bookmark_id: idMap.get(REMOTE_A) },
          ]),
        },
        tagData: { tags: [], bookmarkTags: [], collections: [] },
      }),
    },
  );

  assert.equal(batchCalls, 1);
  assert.equal(replacementCount, 1);
  assert.equal(entryCount, 1);
  assert.equal(persistedBookmarkId, 'local-rehomed-atomic');
  assert.match(persistedMeta, /local-rehomed-atomic/);
});

test('applyAccountTransition (real A→real B) purges the dropped account’s tag state', async () => {
  // The cross-account-leak fix: dropping account A's cached rows must also drop
  // A's pending tag ops + tag links, or syncTagOps (running next under B's auth)
  // uploads A's tags as B and surfaces them in B's UI.
  const plan = planAccountTransition(
    { id: 'A', isAnonymous: false },
    { id: 'B', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );
  assert.deepEqual(plan.drop, [REMOTE_A]); // sanity: REMOTE_A is account A's row

  let pendingTagOps: PendingTagOp[] = [
    {
      id: 'op-A',
      bookmark_id: REMOTE_A, // belongs to account A — must be purged
      tag_name: 'secret-A',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: '2026-06-16T00:00:00.000Z',
    },
    {
      id: 'op-keep',
      bookmark_id: 'local-unrelated', // not dropped — must survive
      tag_name: 'keep',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: '2026-06-16T00:00:00.000Z',
    },
  ];
  let rehomeCalled = false;
  let dropIds: string[] | null = null;

  await applyAccountTransition(
    plan,
    fakeRepository(),
    () => {},
    () => {},
    () => 'local-x',
    async () => {},
    {
      rehome: () => {
        rehomeCalled = true;
      },
      drop: (ids) => {
        dropIds = ids;
        pendingTagOps = dropPendingTagOpsForBookmarks(pendingTagOps, ids);
      },
    },
  );

  // A switch re-homes nothing, so the rehome callback never fires…
  assert.equal(rehomeCalled, false);
  // …but the drop callback gets account A's ids and purges only A's tag op.
  assert.deepEqual(dropIds, [REMOTE_A]);
  assert.equal(pendingTagOps.length, 1);
  assert.equal(pendingTagOps[0]?.bookmark_id, 'local-unrelated');
});

test('re-homed/dropped rows no longer match — transition is self-idempotent', () => {
  // After a carry-over the rows become local-pending; re-running plans nothing.
  const afterRehome = [bookmark({ id: 'local-xyz', sync_status: 'pending' })];
  const plan = planAccountTransition(
    { id: 'anon', isAnonymous: true },
    { id: 'real', isAnonymous: false },
    afterRehome,
  );
  assert.deepEqual(plan.rehome, []);
  assert.deepEqual(plan.drop, []);
});
