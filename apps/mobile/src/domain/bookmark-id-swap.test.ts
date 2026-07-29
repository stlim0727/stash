import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAliasedId } from './bookmark-id-swap.ts';

test('resolveAliasedId returns the id unchanged when there is no alias', () => {
  assert.equal(resolveAliasedId('local-1', new Map()), 'local-1');
});

test('resolveAliasedId follows a rehome alias to the new id', () => {
  // The account-carry-over case: a background enrichment started under the
  // old id must resolve to the new id the row was re-keyed onto, so its
  // result is not dropped.
  const aliases = new Map([['local-1', 'uuid-remote']]);
  assert.equal(resolveAliasedId('local-1', aliases), 'uuid-remote');
});

test('resolveAliasedId walks a multi-hop chain to its end', () => {
  const aliases = new Map([
    ['local-1', 'uuid-a'],
    ['uuid-a', 'uuid-b'],
  ]);
  assert.equal(resolveAliasedId('local-1', aliases), 'uuid-b');
});

test('resolveAliasedId is cycle-safe', () => {
  const aliases = new Map([
    ['a', 'b'],
    ['b', 'a'],
  ]);
  // Stops at the first repeat rather than looping forever.
  assert.equal(resolveAliasedId('a', aliases), 'b');
});
