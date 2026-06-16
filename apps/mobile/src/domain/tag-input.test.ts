import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isDuplicateTag, normalizeTag, readTagInput } from './tag-input.ts';

test('typing without a separator keeps the text and commits nothing', () => {
  assert.deepEqual(readTagInput('kore'), { commit: null, rest: 'kore' });
});

test('a trailing space commits the token and clears the field', () => {
  assert.deepEqual(readTagInput('korean '), { commit: 'korean', rest: '' });
});

test('a trailing comma also commits', () => {
  assert.deepEqual(readTagInput('food,'), { commit: 'food', rest: '' });
});

test('a separator with no token commits nothing (no blank chips)', () => {
  assert.deepEqual(readTagInput('   '), { commit: null, rest: '' });
  assert.deepEqual(readTagInput(','), { commit: null, rest: '' });
});

test('normalizeTag lower-cases and trims', () => {
  assert.equal(normalizeTag('  Food '), 'food');
});

test('isDuplicateTag is case-insensitive', () => {
  assert.equal(isDuplicateTag('Food', ['food', 'recipe']), true);
  assert.equal(isDuplicateTag('dinner', ['food', 'recipe']), false);
});
