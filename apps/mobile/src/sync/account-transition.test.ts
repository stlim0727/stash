import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyAccountTransition, planAccountTransition } from './account-transition.ts';
import { rekeyPendingTagOps, type PendingTagOp } from '@/domain/pending-tags';
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
  assert.equal(plan.resetWatermark, true);
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

function fakeRepository(): BookmarkRepository {
  return {
    init: async () => {},
    listBookmarks: async () => [],
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
    listTagData: async () => ({ tags: [], bookmarkTags: [], collections: [] }),
    replaceTagData: async () => {},
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
    (idMap) => {
      pendingTagOps = rekeyPendingTagOps(pendingTagOps, idMap);
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

test('applyAccountTransition leaves tag ops for non-re-homed bookmarks untouched', async () => {
  // A drop (real A → real B) re-homes nothing, so the callback gets an empty
  // map and ops pass through unchanged.
  const plan = planAccountTransition(
    { id: 'A', isAnonymous: false },
    { id: 'B', isAnonymous: false },
    [bookmark({ id: REMOTE_A })],
  );

  let pendingTagOps: PendingTagOp[] = [
    {
      id: 'op-1',
      bookmark_id: 'local-other',
      tag_name: 'design',
      op: 'add',
      source: 'user',
      confidence: null,
      created_at: '2026-06-16T00:00:00.000Z',
    },
  ];
  let rehomeCalled = false;

  await applyAccountTransition(
    plan,
    fakeRepository(),
    () => {},
    () => {},
    () => 'local-x',
    async () => {},
    (idMap) => {
      rehomeCalled = true;
      pendingTagOps = rekeyPendingTagOps(pendingTagOps, idMap);
    },
  );

  // No re-home happened, so the tag-state callback never fired and the op stays.
  assert.equal(rehomeCalled, false);
  assert.equal(pendingTagOps[0]?.bookmark_id, 'local-other');
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
