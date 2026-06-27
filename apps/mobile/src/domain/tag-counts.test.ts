import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countTagsForBookmarks, type CountableTag } from './tag-counts.ts';

/** Build a getTags accessor from a plain bookmarkId -> tags map. */
function accessor(map: Record<string, CountableTag[]>) {
  return (id: string): readonly CountableTag[] => map[id] ?? [];
}

test('countTagsForBookmarks returns nothing for an empty set', () => {
  assert.deepEqual(countTagsForBookmarks([], accessor({})), []);
});

test('countTagsForBookmarks counts a single bookmark’s tags', () => {
  const counts = countTagsForBookmarks(
    ['b1'],
    accessor({ b1: [{ id: 't1', name: 'react' }, { id: 't2', name: 'design' }] }),
  );
  const byId = new Map(counts.map((c) => [c.id, c.count]));
  assert.equal(byId.get('t1'), 1);
  assert.equal(byId.get('t2'), 1);
});

test('countTagsForBookmarks sums the same tag across multiple bookmarks', () => {
  const counts = countTagsForBookmarks(
    ['b1', 'b2', 'b3'],
    accessor({
      b1: [{ id: 't1', name: 'react' }],
      b2: [{ id: 't1', name: 'react' }],
      b3: [{ id: 't1', name: 'react' }, { id: 't2', name: 'css' }],
    }),
  );
  const byId = new Map(counts.map((c) => [c.id, c.count]));
  assert.equal(byId.get('t1'), 3);
  assert.equal(byId.get('t2'), 1);
});

test('countTagsForBookmarks counts a repeated id within one bookmark once', () => {
  const counts = countTagsForBookmarks(
    ['b1'],
    accessor({ b1: [{ id: 't1', name: 'react' }, { id: 't1', name: 'react' }] }),
  );
  assert.deepEqual(counts, [{ id: 't1', name: 'react', count: 1 }]);
});

test('countTagsForBookmarks skips bookmarks with no tags / unknown ids', () => {
  const counts = countTagsForBookmarks(
    ['b1', 'missing', 'b2'],
    accessor({ b1: [], b2: [{ id: 't1', name: 'go' }] }),
  );
  assert.deepEqual(counts, [{ id: 't1', name: 'go', count: 1 }]);
});

test('countTagsForBookmarks carries the name from the first occurrence', () => {
  const counts = countTagsForBookmarks(
    ['b1', 'b2'],
    accessor({
      b1: [{ id: 't1', name: 'React' }],
      b2: [{ id: 't1', name: 'react' }],
    }),
  );
  assert.deepEqual(counts, [{ id: 't1', name: 'React', count: 2 }]);
});

test('countTagsForBookmarks keeps equal-count ties (no ranking applied)', () => {
  const counts = countTagsForBookmarks(
    ['b1', 'b2'],
    accessor({
      b1: [{ id: 't1', name: 'one' }],
      b2: [{ id: 't2', name: 'two' }],
    }),
  );
  assert.equal(counts.length, 2);
  assert.ok(counts.every((c) => c.count === 1));
});
