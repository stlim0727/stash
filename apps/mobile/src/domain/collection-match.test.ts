import assert from 'node:assert/strict';
import test from 'node:test';

import { collectionMatchKey } from './collection-match.ts';

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
