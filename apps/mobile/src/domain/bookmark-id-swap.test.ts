import assert from 'node:assert/strict';
import { test } from 'node:test';

import { swapBookmarkId } from './bookmark-id-swap.ts';
import type { Bookmark } from './types.ts';

function bm(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    user_id: 'user-1',
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
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    last_saved_at: '2026-06-01T00:00:00.000Z',
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}

test('renames the row in place, preserving order', () => {
  const list = [bm('a'), bm('local-x', { title: 'mine' }), bm('b')];
  const result = swapBookmarkId(list, 'local-x', bm('uuid-x', { title: 'mine' }));
  assert.deepEqual(
    result.map((b) => b.id),
    ['a', 'uuid-x', 'b'],
  );
  assert.equal(result[1].title, 'mine');
});

test('collapses a remote twin already present under the destination id', () => {
  // The pull inserted uuid-x; the lingering local-x then swaps onto it. Without
  // collapsing this yields two entries with id uuid-x — the reported duplicate.
  const list = [bm('uuid-x', { title: 'pulled' }), bm('local-x', { title: 'local' })];
  const result = swapBookmarkId(list, 'local-x', bm('uuid-x', { title: 'local' }));
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'uuid-x');
  assert.equal(result[0].title, 'local');
});

test('collapses a twin that appears after the swapped row too', () => {
  const list = [bm('local-x', { title: 'local' }), bm('a'), bm('uuid-x', { title: 'pulled' })];
  const result = swapBookmarkId(list, 'local-x', bm('uuid-x', { title: 'local' }));
  assert.deepEqual(
    result.map((b) => b.id),
    ['uuid-x', 'a'],
  );
  // Exactly one row carries the destination id.
  assert.equal(result.filter((b) => b.id === 'uuid-x').length, 1);
});

test('is a no-op when the source id is absent (swap already happened)', () => {
  const list = [bm('a'), bm('uuid-x')];
  const result = swapBookmarkId(list, 'local-x', bm('uuid-x'));
  // Same reference back: nothing changed, and the existing uuid-x is NOT dropped.
  assert.equal(result, list);
});

test('handles a same-id replacement (no rename) without dropping the row', () => {
  const list = [bm('a'), bm('x', { title: 'old' })];
  const result = swapBookmarkId(list, 'x', bm('x', { title: 'new' }));
  assert.deepEqual(
    result.map((b) => b.id),
    ['a', 'x'],
  );
  assert.equal(result[1].title, 'new');
});
