import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inFilter, isUuid, isValidCollectionId, sanitizeQuery } from './filters.ts';

test('sanitizeQuery: strips PostgREST structural characters', () => {
  // The injection payload from the review: the `)` (which would close the or()
  // group) and the `,` (which would start a new condition) are both stripped, so
  // the smuggled `is_archived.eq.false` collapses into the harmless search term.
  assert.equal(sanitizeQuery('foo),is_archived.eq.false'), 'foois_archived.eq.false');
  // All of % * , ( ) are removed; nothing else is touched.
  assert.equal(sanitizeQuery('a%b*c,d(e)f'), 'abcdef');
  assert.equal(sanitizeQuery('plain text 123'), 'plain text 123');
  assert.equal(sanitizeQuery(''), '');
});

test('sanitizeQuery: matches the mobile client regex /[%*,()]/g', () => {
  // Mirror apps/mobile/src/api/bookmarks.ts:719 so the two surfaces agree.
  const mobile = (q: string) => q.replace(/[%*,()]/g, '');
  for (const sample of ['a,b', 'x*y', '(z)', '50%', 'foo),bar', 'safe-slug_99']) {
    assert.equal(sanitizeQuery(sample), mobile(sample));
  }
});

test('isValidCollectionId: accepts "null" and well-formed UUIDs', () => {
  assert.equal(isValidCollectionId('null'), true);
  assert.equal(isValidCollectionId('123e4567-e89b-12d3-a456-426614174000'), true);
  // Case-insensitive.
  assert.equal(isValidCollectionId('123E4567-E89B-12D3-A456-426614174000'), true);
});

test('isValidCollectionId: rejects injection payloads and malformed ids', () => {
  // The injection shapes: an eq value that smuggles extra filter conditions.
  assert.equal(isValidCollectionId('123e4567-e89b-12d3-a456-426614174000,is_archived.eq.false'), false);
  assert.equal(isValidCollectionId('null)'), false);
  assert.equal(isValidCollectionId('is.null'), false);
  assert.equal(isValidCollectionId(''), false);
  assert.equal(isValidCollectionId('not-a-uuid'), false);
  // Right shape, wrong length.
  assert.equal(isValidCollectionId('123e4567-e89b-12d3-a456-42661417400'), false);
});

test('inFilter: double-quotes and escapes embedded quotes', () => {
  assert.equal(inFilter(['a', 'b']), '("a","b")');
  // A value containing a comma must not be parsed as two list members.
  assert.equal(inFilter(['a,b']), '("a,b")');
  // A value containing a closing paren must not end the group early.
  assert.equal(inFilter(['x)']), '("x)")');
  // Embedded double quotes are backslash-escaped.
  assert.equal(inFilter(['a"b']), '("a\\"b")');
});

test('inFilter: escapes backslashes first so a trailing \\ cannot break out of the quote', () => {
  // `a\"` — a quote-escaping payload. Backslash must be doubled, THEN the quote
  // escaped, yielding `"a\\\""` (value: a, backslash-backslash, backslash-quote).
  // Without backslash-first this would render `"a\""` and the value would close
  // its own quote. (Asserted via raw JS string literals to be unambiguous.)
  assert.equal(inFilter(['a\\"b']), '("a\\\\\\"b")');
  // A lone trailing backslash is doubled (not left to escape our closing quote).
  assert.equal(inFilter(['a\\']), '("a\\\\")');
});

test('inFilter: matches the hardened mobile copy (backslash-then-quote escaping)', () => {
  // Mirror apps/mobile/src/api/bookmarks.ts:180-182 (post-#3: escape \\ first).
  const mobile = (values: string[]) =>
    `(${values
      .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
      .join(',')})`;
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
  assert.equal(inFilter(ids), mobile(ids));
  // Also agree on the adversarial backslash/quote cases.
  for (const sample of [['a\\"b'], ['a\\'], ['x")']]) {
    assert.equal(inFilter(sample), mobile(sample));
  }
});

test('isUuid: accepts well-formed UUIDs, rejects injection payloads', () => {
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isUuid('123E4567-E89B-12D3-A456-426614174000'), true);
  // The path-injection shape the resourceId guard must reject.
  assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000&or=(is_archived.eq.false)'), false);
  assert.equal(isUuid('abc&select=*'), false);
  assert.equal(isUuid('abc'), false);
  assert.equal(isUuid(''), false);
  // "null" is NOT a valid bookmark id (only a collection filter sentinel).
  assert.equal(isUuid('null'), false);
});
