import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterBookmarks } from './search.ts';
import type { Bookmark } from './types.ts';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u1',
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

const corpus = [
  makeBookmark({ id: 'b1', title: 'Local-first software', notes: 'sync design' }),
  makeBookmark({ id: 'b2', title: 'Raindrop review', description: 'bookmark manager' }),
  makeBookmark({ id: 'b3', url: 'https://docs.expo.dev/router/' }),
];

test('empty query returns everything', () => {
  assert.equal(filterBookmarks(corpus, '').length, 3);
  assert.equal(filterBookmarks(corpus, '   ').length, 3);
});

test('matches are case-insensitive across title, description, notes, and URL', () => {
  assert.deepEqual(
    filterBookmarks(corpus, 'LOCAL-FIRST').map((b) => b.id),
    ['b1'],
  );
  assert.deepEqual(
    filterBookmarks(corpus, 'manager').map((b) => b.id),
    ['b2'],
  );
  assert.deepEqual(
    filterBookmarks(corpus, 'expo.dev').map((b) => b.id),
    ['b3'],
  );
});

test('multiple terms AND together across fields', () => {
  assert.deepEqual(
    filterBookmarks(corpus, 'local sync').map((b) => b.id),
    ['b1'],
  );
  assert.equal(filterBookmarks(corpus, 'local manager').length, 0);
});
