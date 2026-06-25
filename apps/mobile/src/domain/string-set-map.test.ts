import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addToStringSet, parseStringSetMap, stringSetFor } from './string-set-map.ts';

test('parseStringSetMap tolerates missing and malformed values', () => {
  assert.deepEqual(parseStringSetMap(null), {});
  assert.deepEqual(parseStringSetMap('not json'), {});
  assert.deepEqual(parseStringSetMap('[]'), {});
  assert.deepEqual(parseStringSetMap('123'), {});
  // Non-string entries are dropped, the rest kept.
  assert.deepEqual(parseStringSetMap('{"a":["x",1,"y"],"b":"nope"}'), { a: ['x', 'y'] });
});

test('stringSetFor returns the raw values for a key (empty when absent)', () => {
  const map = { a: ['x', 'Y'] };
  assert.deepEqual(stringSetFor(map, 'a'), new Set(['x', 'Y']));
  assert.deepEqual(stringSetFor(map, 'missing'), new Set());
});

test('addToStringSet appends new values and dedupes, default identity normalize', () => {
  assert.deepEqual(addToStringSet({ a: ['x'] }, 'a', ['y', 'x']), { a: ['x', 'y'] });
  assert.deepEqual(addToStringSet({}, 'b', ['z']), { b: ['z'] });
});

test('addToStringSet returns the SAME reference when nothing changes', () => {
  const map = { a: ['x'] };
  // Already present → no change → same ref (lets callers skip a re-persist).
  assert.equal(addToStringSet(map, 'a', ['x']), map);
});

test('addToStringSet applies the normalizer and skips empties', () => {
  const lc = (v: string) => v.trim().toLowerCase();
  assert.deepEqual(addToStringSet({ a: ['x'] }, 'a', ['  Y ', 'x', ''], lc), { a: ['x', 'y'] });
  // All inputs normalize to an existing value or empty → no change → same ref.
  const unchanged = { a: ['x'] };
  assert.equal(addToStringSet(unchanged, 'a', ['X', '   '], lc), unchanged);
});
