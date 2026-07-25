import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectionColorKey } from './collection-color.ts';

test('the same collection id always yields the same color key', () => {
  const id = 'c0ffee00-0000-4000-8000-000000000001';
  const first = collectionColorKey(id);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(collectionColorKey(id), first);
  }
});

test('different ids are not all collapsed onto a single key', () => {
  const ids = ['col-a', 'col-b', 'col-c', 'col-d', 'col-e', 'col-f'];
  const keys = new Set(ids.map((id) => collectionColorKey(id)));
  assert.ok(keys.size > 1, `expected more than one distinct key, got ${[...keys]}`);
});

test('every returned key is one of the three fixed palette tokens', () => {
  const allowed = new Set(['accentSoft', 'successSoft', 'highlightSoft']);
  for (const id of ['a', 'b', 'c', 'collection-1', 'collection-2', '']) {
    assert.ok(allowed.has(collectionColorKey(id)));
  }
});

test('never returns mutedSurface — that token is reserved for the uncollected tile', () => {
  for (const id of ['a', 'b', 'c', 'collection-1', 'collection-2', '']) {
    assert.notEqual(collectionColorKey(id), 'mutedSurface');
  }
});
