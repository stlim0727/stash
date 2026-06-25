import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightSegments } from '@/domain/highlight';

/** Compact view of segments for assertions: matched runs wrapped in [brackets]. */
function marked(text: string, query: string): string {
  return highlightSegments(text, query)
    .map((segment) => (segment.match ? `[${segment.text}]` : segment.text))
    .join('');
}

test('an empty or whitespace-only query yields a single plain segment', () => {
  assert.deepEqual(highlightSegments('Design system', ''), [
    { text: 'Design system', match: false },
  ]);
  assert.deepEqual(highlightSegments('Design system', '   '), [
    { text: 'Design system', match: false },
  ]);
});

test('highlights a case-insensitive substring match', () => {
  assert.equal(marked('Design System', 'design'), '[Design] System');
  assert.equal(marked('A DESIGN doc', 'design'), 'A [DESIGN] doc');
});

test('highlights each whitespace-separated token independently', () => {
  assert.equal(marked('Design system notes', 'design notes'), '[Design] system [notes]');
});

test('merges adjacent/overlapping matches into one run', () => {
  // "design" and "designs" overlap from index 0; the longer wins the merge.
  assert.equal(marked('designs', 'design designs'), '[designs]');
});

test('a non-matching query leaves the text plain', () => {
  assert.deepEqual(highlightSegments('Design system', 'recipes'), [
    { text: 'Design system', match: false },
  ]);
});

test('symbol-bearing tokens highlight literally', () => {
  assert.equal(marked('Learning C++ basics', 'c++'), 'Learning [C++] basics');
  assert.equal(marked('A .NET guide', '.net'), 'A [.NET] guide');
});

test('matches inside a URL', () => {
  assert.equal(
    marked('https://naver.me/abc', 'naver'),
    'https://[naver].me/abc',
  );
});

test('folds fullwidth/width differences (NFKC) like the matcher', () => {
  // Fullwidth "design" should still match the ASCII query token.
  assert.equal(marked('Ｄｅｓｉｇｎ doc', 'design'), '[Ｄｅｓｉｇｎ] doc');
});

test('does not highlight the separator-collapse-only case (best-effort)', () => {
  // Search would match "Watch Later" for the query "watchlater" via its collapse
  // fallback, but the literal token isn't present, so nothing is highlighted —
  // the row still shows; highlighting just stays quiet rather than guessing.
  assert.deepEqual(highlightSegments('Watch Later', 'watchlater'), [
    { text: 'Watch Later', match: false },
  ]);
});

test('a punctuation-only query is treated as no search', () => {
  assert.deepEqual(highlightSegments('Design...', '...'), [
    { text: 'Design...', match: false },
  ]);
});

test('preserves the original text exactly across segments', () => {
  const text = 'Café Design — Naver';
  for (const query of ['design', 'naver café', 'zzz', '']) {
    const joined = highlightSegments(text, query)
      .map((segment) => segment.text)
      .join('');
    assert.equal(joined, text);
  }
});
