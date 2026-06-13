import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bookmarkMatchesFilter, filterByFacet, sameFilter } from '@/domain/filter';
import type { Bookmark } from '@/domain/types';

function makeBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'b1',
    user_id: 'u1',
    url: 'https://example.com',
    canonical_url: null,
    url_hash: 'https://example.com',
    title: 'Example',
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

const tagIds: Record<string, string[]> = {
  b1: ['tag-design', 'tag-read-later'],
  b2: ['tag-design'],
  b3: [],
};
const tagIdsFor = (id: string) => tagIds[id] ?? [];

test('all matches every bookmark', () => {
  assert.equal(bookmarkMatchesFilter(makeBookmark(), { kind: 'all' }, tagIdsFor), true);
});

test('uncollected matches only bookmarks with no collection', () => {
  assert.equal(
    bookmarkMatchesFilter(makeBookmark({ collection_id: null }), { kind: 'uncollected' }, tagIdsFor),
    true,
  );
  assert.equal(
    bookmarkMatchesFilter(
      makeBookmark({ collection_id: 'collection-research' }),
      { kind: 'uncollected' },
      tagIdsFor,
    ),
    false,
  );
});

test('collection matches only its members', () => {
  const filter = { kind: 'collection', id: 'collection-research' } as const;
  assert.equal(
    bookmarkMatchesFilter(makeBookmark({ collection_id: 'collection-research' }), filter, tagIdsFor),
    true,
  );
  assert.equal(
    bookmarkMatchesFilter(makeBookmark({ collection_id: 'collection-work' }), filter, tagIdsFor),
    false,
  );
});

test('tag matches bookmarks linked to that tag', () => {
  const filter = { kind: 'tag', id: 'tag-design' } as const;
  assert.equal(bookmarkMatchesFilter(makeBookmark({ id: 'b1' }), filter, tagIdsFor), true);
  assert.equal(bookmarkMatchesFilter(makeBookmark({ id: 'b2' }), filter, tagIdsFor), true);
  assert.equal(bookmarkMatchesFilter(makeBookmark({ id: 'b3' }), filter, tagIdsFor), false);
});

test('filterByFacet narrows a list and "all" is a passthrough', () => {
  const list = [
    makeBookmark({ id: 'b1', collection_id: 'collection-research' }),
    makeBookmark({ id: 'b2', collection_id: null }),
    makeBookmark({ id: 'b3', collection_id: null }),
  ];
  assert.equal(filterByFacet(list, { kind: 'all' }, tagIdsFor).length, 3);
  assert.deepEqual(
    filterByFacet(list, { kind: 'tag', id: 'tag-design' }, tagIdsFor).map((b) => b.id),
    ['b1', 'b2'],
  );
  assert.deepEqual(
    filterByFacet(list, { kind: 'uncollected' }, tagIdsFor).map((b) => b.id),
    ['b2', 'b3'],
  );
});

test('sameFilter compares facet identity', () => {
  assert.equal(sameFilter({ kind: 'all' }, { kind: 'all' }), true);
  assert.equal(sameFilter({ kind: 'uncollected' }, { kind: 'all' }), false);
  assert.equal(
    sameFilter({ kind: 'collection', id: 'a' }, { kind: 'collection', id: 'a' }),
    true,
  );
  assert.equal(
    sameFilter({ kind: 'collection', id: 'a' }, { kind: 'collection', id: 'b' }),
    false,
  );
  assert.equal(sameFilter({ kind: 'tag', id: 'a' }, { kind: 'tag', id: 'a' }), true);
});
