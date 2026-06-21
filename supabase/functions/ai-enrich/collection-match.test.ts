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
