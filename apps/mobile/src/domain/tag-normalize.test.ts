import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeText, slugify } from './tag-normalize.ts';

test('normalizeText trims and collapses whitespace', () => {
  assert.equal(normalizeText('  hello   world  '), 'hello world');
  assert.equal(normalizeText('local-first'), 'local-first');
});

test('slugify keeps Latin words, lowercased and hyphenated', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('local-first'), 'local-first');
  assert.equal(slugify('  React  Native  '), 'react-native');
});

test('slugify preserves non-Latin scripts instead of collapsing to empty', () => {
  // The original [a-z0-9] slug produced '' here, so the tag was dropped.
  assert.equal(slugify('요리'), '요리');
  assert.equal(slugify('베이킹'), '베이킹');
  assert.equal(slugify('한식 요리'), '한식-요리');
});

test('slugify strips leading/trailing separators', () => {
  assert.equal(slugify('!!!hello!!!'), 'hello');
  assert.equal(slugify('---'), '');
});
