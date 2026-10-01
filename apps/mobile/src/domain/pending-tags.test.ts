import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPendingTagOps,
  applyTagOp,
  carryOverTagOps,
  dequeueTagOp,
  dropPendingTagOpsForBookmarks,
  enqueueTagOp,
  reconcileSyncedAdd,
  retireConfirmedTagRemovals,
  rekeyPendingTagOps,
  type PendingTagOp,
} from './pending-tags.ts';
import type { Tag } from '@/domain/types';
import type { TagData } from '@/storage/types';

const EMPTY: TagData = { tags: [], bookmarkTags: [], collections: [] };

function op(overrides: Partial<PendingTagOp>): PendingTagOp {
  return {
    id: 'op-1',
    bookmark_id: 'bm-1',
    tag_name: 'food',
    op: 'add',
    source: 'user',
    confidence: null,
    created_at: '2026-06-16T00:00:00.000Z',
    ...overrides,
  };
}

test('rekeyPendingTagOps re-targets ops whose bookmark id was re-homed', () => {
  const ops = [
    op({ id: 'a', bookmark_id: 'old-1', tag_name: 'design' }),
    op({ id: 'b', bookmark_id: 'untouched', tag_name: 'food' }),
  ];
  const next = rekeyPendingTagOps(ops, new Map([['old-1', 'local-new-1']]));
  assert.equal(next[0]?.bookmark_id, 'local-new-1');
  // Other fields are preserved, and unmapped ops pass through unchanged.
  assert.equal(next[0]?.tag_name, 'design');
  assert.equal(next[1]?.bookmark_id, 'untouched');
});

test('rekeyPendingTagOps returns the same list when the id map is empty', () => {
  const ops = [op({ bookmark_id: 'old-1' })];
  assert.equal(rekeyPendingTagOps(ops, new Map()), ops);
});

test('dropPendingTagOpsForBookmarks removes only ops for the dropped bookmark ids', () => {
  const ops = [
    op({ id: 'a', bookmark_id: 'drop-1' }),
    op({ id: 'b', bookmark_id: 'keep-1' }),
    op({ id: 'c', bookmark_id: 'drop-2' }),
  ];
  const next = dropPendingTagOpsForBookmarks(ops, ['drop-1', 'drop-2']);
  assert.equal(next.length, 1);
  assert.equal(next[0]?.bookmark_id, 'keep-1');
});

test('dropPendingTagOpsForBookmarks returns the same list when nothing is dropped', () => {
  const ops = [op({ bookmark_id: 'keep-1' })];
  assert.equal(dropPendingTagOpsForBookmarks(ops, []), ops);
});

test('add creates an optimistic local tag and link', () => {
  const next = applyTagOp(EMPTY, op({ tag_name: 'Korean Food' }), 'u1');
  assert.equal(next.tags.length, 1);
  assert.equal(next.tags[0]!.id, 'local-tag-korean-food');
  assert.equal(next.tags[0]!.name, 'Korean Food');
  assert.deepEqual(
    next.bookmarkTags.map((link) => [link.bookmark_id, link.tag_id]),
    [['bm-1', 'local-tag-korean-food']],
  );
});

test('add reuses an existing tag (case-insensitive) instead of duplicating', () => {
  const existing: TagData = {
    tags: [{ id: 'srv-1', user_id: 'u1', name: 'Food', slug: 'food', source: 'user', created_at: 'x' }],
    bookmarkTags: [],
    collections: [],
  };
  const next = applyTagOp(existing, op({ tag_name: 'food' }), 'u1');
  assert.equal(next.tags.length, 1);
  assert.equal(next.bookmarkTags[0]!.tag_id, 'srv-1');
});

test('remove drops the link for that bookmark only', () => {
  const data: TagData = {
    tags: [{ id: 't', user_id: 'u1', name: 'food', slug: 'food', source: 'user', created_at: 'x' }],
    bookmarkTags: [
      { bookmark_id: 'bm-1', tag_id: 't', source: 'user', confidence: null, created_at: 'x' },
      { bookmark_id: 'bm-2', tag_id: 't', source: 'user', confidence: null, created_at: 'x' },
    ],
    collections: [],
  };
  const next = applyTagOp(data, op({ op: 'remove' }), 'u1');
  assert.deepEqual(
    next.bookmarkTags.map((link) => link.bookmark_id),
    ['bm-2'],
  );
});

test('enqueue: opposite edits retain the latest intent, same op de-dupes', () => {
  const add = op({ op: 'add' });
  const remove = op({ op: 'remove', id: 'op-2' });
  assert.deepEqual(enqueueTagOp([add], remove), [remove]);
  assert.deepEqual(enqueueTagOp([add], op({ op: 'add', id: 'op-3' })).length, 1);
  assert.deepEqual(enqueueTagOp([], add), [add]);
});

test('applyPendingTagOps layers ops over a server snapshot in order', () => {
  const server: TagData = {
    tags: [{ id: 'srv', user_id: 'u1', name: 'work', slug: 'work', source: 'user', created_at: 'x' }],
    bookmarkTags: [{ bookmark_id: 'bm-1', tag_id: 'srv', source: 'user', confidence: null, created_at: 'x' }],
    collections: [],
  };
  const merged = applyPendingTagOps(
    server,
    [op({ tag_name: 'food' }), op({ tag_name: 'work', op: 'remove', id: 'op-2' })],
    'u1',
  );
  // 'food' added optimistically, 'work' link removed.
  const linkedTags = merged.bookmarkTags.filter((l) => l.bookmark_id === 'bm-1').map((l) => l.tag_id);
  assert.ok(linkedTags.includes('local-tag-food'));
  assert.ok(!linkedTags.includes('srv'));
});

test('reconcileSyncedAdd swaps the local tag id for the server one', () => {
  const optimistic = applyTagOp(EMPTY, op({ tag_name: 'food' }), 'u1');
  const serverTag: Tag = {
    id: '7e64cf1e-0000-4000-8000-00000000000a',
    user_id: 'u1',
    name: 'food',
    slug: 'food',
    source: 'user',
    created_at: 'x',
  };
  const reconciled = reconcileSyncedAdd(optimistic, 'food', serverTag);
  assert.equal(reconciled.tags.length, 1);
  assert.equal(reconciled.tags[0]!.id, serverTag.id);
  assert.equal(reconciled.bookmarkTags[0]!.tag_id, serverTag.id);
});

test('dequeueTagOp clears the target after sync', () => {
  const ops = [op({ tag_name: 'food' }), op({ tag_name: 'work', id: 'op-2' })];
  assert.deepEqual(
    dequeueTagOp(ops, 'bm-1', 'food').map((o) => o.tag_name),
    ['work'],
  );
});


test('an old upload acknowledgement cannot clear a newer opposite edit', () => {
  const add = op({ id: 'add-request' });
  const remove = op({ id: 'remove-after-request', op: 'remove' });
  const queued = enqueueTagOp([add], remove);
  assert.deepEqual(dequeueTagOp(queued, add.bookmark_id, add.tag_name, add.id), [remove]);
  assert.deepEqual(dequeueTagOp(queued, remove.bookmark_id, remove.tag_name, remove.id), []);
});

test('remove then add survives an in-flight remove acknowledgement', () => {
  const remove = op({ id: 'remove-request', op: 'remove' });
  const add = op({ id: 'add-after-request' });
  const queued = enqueueTagOp([remove], add);
  assert.deepEqual(dequeueTagOp(queued, remove.bookmark_id, remove.tag_name, remove.id), [add]);
});


test('account carry-over queues already-synced links and rekeys pending removals without duplication', () => {
  const data = applyTagOp(EMPTY, op({}), 'guest');
  const ops = [op({ id: 'remove', op: 'remove', tag_name: 'other', confirmed: true, retry_count: 4 })];
  const result = carryOverTagOps(ops, data, new Map([['bm-1', 'new-bm']]), () => 'new-op', 'now');
  assert.equal(result.length, 2);
  assert.ok(result.every((op) => op.bookmark_id === 'new-bm'));
  assert.equal(result[0]?.confirmed, false);
  assert.equal(result[0]?.retry_count, 0);
  assert.equal(result[1]?.tag_name, 'food');
  assert.equal(result[1]?.op, 'add');
  assert.equal(carryOverTagOps([op({})], data, new Map([['bm-1', 'new-bm']]), () => 'new-op', 'now').length, 1);
});


test('confirmed removal survives stale pulls and cache-preserving pulls until remote absence', () => {
  const remove = op({ op: 'remove', confirmed: true });
  const stale = applyTagOp(EMPTY, op({}), 'user');
  assert.deepEqual(retireConfirmedTagRemovals([remove], stale, true), [remove]);
  assert.deepEqual(applyPendingTagOps(stale, [remove], 'user').bookmarkTags, []);
  assert.deepEqual(retireConfirmedTagRemovals([remove], EMPTY, false), [remove]);
  assert.deepEqual(retireConfirmedTagRemovals([remove], EMPTY, true), []);
  const unconfirmed = op({ op: 'remove' });
  assert.deepEqual(retireConfirmedTagRemovals([unconfirmed], EMPTY, true), [unconfirmed]);
});


test('duplicate adoption collapses pending operations that now share a target', () => {
  const source = op({ id: 'source', bookmark_id: 'old-id' });
  const destination = op({ id: 'destination', bookmark_id: 'canonical-id', op: 'remove' });
  assert.deepEqual(rekeyPendingTagOps([source, destination], new Map([['old-id', 'canonical-id']])), [destination]);
});
