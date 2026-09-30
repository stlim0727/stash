import assert from 'node:assert/strict';
import test from 'node:test';

import { collectionMatchKey, isGenericCollection } from './collection-match.ts';

test('folds case, spacing, and punctuation to a stable key', () => {
  // The whole point: an AI suggestion and a user-made folder that differ only in
  // case/spacing/punctuation share a key, so the client files in (not creates).
  for (const variant of ['Watch Later', 'watch-later', 'WatchLater', '  watch   later  ', 'watch_later']) {
    assert.equal(collectionMatchKey(variant), 'watchlater', variant);
  }
});

test('keeps non-ASCII letters and digits', () => {
  assert.equal(collectionMatchKey('연구 자료'), '연구자료');
  assert.equal(collectionMatchKey('Q1 2026'), 'q12026');
});

test('returns empty for blank or symbol-only names', () => {
  assert.equal(collectionMatchKey(''), '');
  assert.equal(collectionMatchKey('   '), '');
  assert.equal(collectionMatchKey('—!'), '');
});

test('identifies generic holding collections vs substantive topical collections', () => {
  assert.equal(isGenericCollection('Watch Later'), true);
  assert.equal(isGenericCollection('watch-later'), true);
  assert.equal(isGenericCollection('Saved'), true);
  assert.equal(isGenericCollection('Bookmarks'), true);
  assert.equal(isGenericCollection('나중에 보기'), true);
  assert.equal(isGenericCollection('동영상'), true);
  assert.equal(isGenericCollection('Articles'), true);

  assert.equal(isGenericCollection('Recipes'), false);
  assert.equal(isGenericCollection('Food'), false);
  assert.equal(isGenericCollection('음식 및 요리'), false);
  assert.equal(isGenericCollection('요리 레시피'), false);
  assert.equal(isGenericCollection('수영'), false);
  assert.equal(isGenericCollection('스포츠 및 건강'), false);
  assert.equal(isGenericCollection(null), false);
  assert.equal(isGenericCollection(undefined), false);
  assert.equal(isGenericCollection(''), false);
});
