import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyPendingTagOps,
  applyTagOp,
  dequeueTagOp,
  enqueueTagOp,
  reconcileSyncedAdd,
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

test('enqueue: opposite ops cancel, same op de-dupes', () => {
  const add = op({ op: 'add' });
  const remove = op({ op: 'remove', id: 'op-2' });
  assert.deepEqual(enqueueTagOp([add], remove), []);
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
