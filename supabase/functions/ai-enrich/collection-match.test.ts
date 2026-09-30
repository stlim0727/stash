import assert from 'node:assert/strict';
import test from 'node:test';

import { collectionMatchKey, matchSuggestedCollection } from './collection-match.ts';

const collections = [
  { id: 'c1', name: 'Watch Later' },
  { id: 'c2', name: 'Development' },
  { id: 'c3', name: '연구 자료' },
];

test('matches an exact existing name (case-insensitive)', () => {
  assert.deepEqual(matchSuggestedCollection(collections, 'development'), {
    id: 'c2',
    name: 'Development',
  });
});

test('matches across spacing and punctuation differences', () => {
  for (const name of ['watch-later', 'WatchLater', '  Watch   Later  ', 'watch_later']) {
    assert.equal(matchSuggestedCollection(collections, name)?.id, 'c1', name);
  }
});

test('matches non-ASCII names', () => {
  assert.equal(matchSuggestedCollection(collections, '연구 자료')?.id, 'c3');
});

test('returns null when nothing fits (the create-it signal)', () => {
  assert.equal(matchSuggestedCollection(collections, 'Recipes'), null);
});

test('returns null for a blank or symbol-only name', () => {
  assert.equal(matchSuggestedCollection(collections, ''), null);
  assert.equal(matchSuggestedCollection(collections, null), null);
  assert.equal(matchSuggestedCollection(collections, '  '), null);
  assert.equal(matchSuggestedCollection(collections, '—'), null);
});

test('collectionMatchKey folds to a stable comparison key', () => {
  assert.equal(collectionMatchKey('Watch Later'), 'watchlater');
  assert.equal(collectionMatchKey('Read-it-Later!'), 'readitlater');
  assert.equal(collectionMatchKey('   '), '');
});

test('prefers incumbent collection when duplicate collections share the same match key', () => {
  const duplicates = [
    { id: 'c1', name: 'Food' },
    { id: 'c2', name: 'Food' },
  ];
  // Without incumbent hint, matches the first matching element
  assert.equal(matchSuggestedCollection(duplicates, 'Food')?.id, 'c1');
  // With incumbent hint matching c2, returns c2 rather than c1
  assert.equal(matchSuggestedCollection(duplicates, 'Food', 'c2')?.id, 'c2');
  // With incumbent hint matching c1, returns c1
  assert.equal(matchSuggestedCollection(duplicates, 'Food', 'c1')?.id, 'c1');
  // With unrelated incumbent hint, falls back to first match
  assert.equal(matchSuggestedCollection(duplicates, 'Food', 'other')?.id, 'c1');
});
