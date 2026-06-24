import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SUGGESTION_FOLDERS_SHOWN,
  SUGGESTION_RECENTS_TYPING,
  SUGGESTION_TAGS_SHOWN,
  buildSearchSuggestions,
  type SearchSuggestion,
} from './search-suggestions.ts';
import { RECENT_SEARCHES_SHOWN } from './recent-searches.ts';

function kinds(list: SearchSuggestion[]): string[] {
  return list.map((s) => s.kind);
}

function labels(list: SearchSuggestion[]): string[] {
  return list.map((s) => s.label);
}

test('orders recents → tags → folders', () => {
  const result = buildSearchSuggestions({
    recents: ['local-first'],
    tagCounts: [{ id: 't1', name: 'design', count: 3 }],
    folders: [{ id: 'c1', name: 'Work', count: 2 }],
  });
  assert.deepEqual(kinds(result), ['recent', 'tag', 'folder']);
  assert.deepEqual(labels(result), ['local-first', '#design', 'Work']);
});

test('recents keep their caller-supplied recency order (no re-sort)', () => {
  const result = buildSearchSuggestions({
    recents: ['zebra', 'apple', 'mango'],
    tagCounts: [],
    folders: [],
  });
  assert.deepEqual(labels(result), ['zebra', 'apple', 'mango']);
});

test('tags sort by frequency desc, ties alphabetical', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [
      { id: 't-low', name: 'low', count: 1 },
      { id: 't-zoo', name: 'zoo', count: 5 },
      { id: 't-art', name: 'art', count: 5 },
    ],
    folders: [],
  });
  // art and zoo tie at 5 → alpha (art before zoo); low (1) last.
  assert.deepEqual(labels(result), ['#art', '#zoo', '#low']);
});

test('folders sort by bookmark count desc, ties alphabetical', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [],
    folders: [
      { id: 'c-a', name: 'Alpha', count: 1 },
      { id: 'c-b', name: 'Beta', count: 4 },
      { id: 'c-c', name: 'Charlie', count: 4 },
    ],
  });
  assert.deepEqual(labels(result), ['Beta', 'Charlie', 'Alpha']);
});

test('caps recents at 6, tags at 8, folders at 8', () => {
  const recents = Array.from({ length: 10 }, (_, i) => `q${i}`);
  const tagCounts = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    name: `tag${i}`,
    count: 100 - i,
  }));
  const folders = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    name: `Folder${i}`,
    count: 100 - i,
  }));
  const result = buildSearchSuggestions({ recents, tagCounts, folders });
  assert.equal(result.filter((s) => s.kind === 'recent').length, RECENT_SEARCHES_SHOWN);
  assert.equal(result.filter((s) => s.kind === 'tag').length, SUGGESTION_TAGS_SHOWN);
  assert.equal(result.filter((s) => s.kind === 'folder').length, SUGGESTION_FOLDERS_SHOWN);
  assert.equal(RECENT_SEARCHES_SHOWN, 6);
});

test('recent keys de-dupe case-insensitively (stable React keys)', () => {
  // A recents list is already deduped upstream, but guard the key derivation.
  const result = buildSearchSuggestions({
    recents: ['Design'],
    tagCounts: [],
    folders: [],
  });
  assert.equal(result[0]!.key, 'recent:design');
  assert.equal(result[0]!.label, 'Design'); // display casing preserved
});

test('drops blank-named tags and folders so no empty pills render', () => {
  const result = buildSearchSuggestions({
    recents: ['  ', ''],
    tagCounts: [
      { id: 't-blank', name: '   ', count: 2 },
      { id: 't-real', name: 'cooking', count: 1 },
    ],
    folders: [{ id: 'c-blank', name: '  ', count: 1 }],
  });
  assert.deepEqual(labels(result), ['#cooking']);
});

test('zero-count tags/folders are dropped', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [{ id: 't', name: 'orphan', count: 0 }],
    folders: [{ id: 'c', name: 'Empty', count: 0 }],
  });
  assert.deepEqual(result, []);
});

test('a recent equal to a tag/folder name still shows both (different actions)', () => {
  const result = buildSearchSuggestions({
    recents: ['design'],
    tagCounts: [{ id: 't-design', name: 'design', count: 1 }],
    folders: [{ id: 'c-design', name: 'design', count: 1 }],
  });
  // Three chips: the recent re-runs a text search; the tag/folder apply facets.
  assert.deepEqual(kinds(result), ['recent', 'tag', 'folder']);
  const recent = result.find((s) => s.kind === 'recent')!;
  assert.equal(recent.query, 'design');
  assert.equal(recent.filter, undefined);
  assert.deepEqual(result.find((s) => s.kind === 'tag')!.filter, { kind: 'tag', id: 't-design' });
  assert.deepEqual(result.find((s) => s.kind === 'folder')!.filter, {
    kind: 'collection',
    id: 'c-design',
  });
});

test('no-recents-yet: leads with tags/folders, omits the recents segment', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [{ id: 't', name: 'design', count: 2 }],
    folders: [{ id: 'c', name: 'Work', count: 1 }],
  });
  assert.deepEqual(kinds(result), ['tag', 'folder']);
});

test('empty library yields no suggestions at all', () => {
  assert.deepEqual(buildSearchSuggestions({ recents: [], tagCounts: [], folders: [] }), []);
});

test('an empty/whitespace query yields the Phase-1 (unfiltered) output', () => {
  // The empty-state behavior must be byte-for-byte the Phase-1 shelf — Phase 2
  // only changes the NON-empty-query branch.
  const base = { recents: ['design', 'recipes'], tagCounts: [], folders: [] };
  assert.deepEqual(buildSearchSuggestions({ ...base, query: '' }), buildSearchSuggestions(base));
  assert.deepEqual(buildSearchSuggestions({ ...base, query: '   ' }), buildSearchSuggestions(base));
});

// ── Phase 2: live filter as you type (§13.3) ──────────────────────────────

test('typing filters each family to matches via the shared matcher', () => {
  const result = buildSearchSuggestions({
    recents: ['design system', 'recipes'],
    tagCounts: [
      { id: 't-design', name: 'design', count: 3 },
      { id: 't-db', name: 'databases', count: 5 },
    ],
    folders: [
      { id: 'c-design', name: 'Design', count: 2 },
      { id: 'c-work', name: 'Work', count: 4 },
    ],
    query: 'des',
  });
  // "des" matches the recent "design system", #design, and the Design folder;
  // "recipes", "databases", and "Work" are dropped.
  assert.deepEqual(kinds(result), ['recent', 'tag', 'folder']);
  assert.deepEqual(labels(result), ['design system', '#design', 'Design']);
});

test('typing-no-match yields an empty array (shelf hides)', () => {
  const result = buildSearchSuggestions({
    recents: ['design system'],
    tagCounts: [{ id: 't', name: 'design', count: 1 }],
    folders: [{ id: 'c', name: 'Design', count: 1 }],
    query: 'zzz',
  });
  assert.deepEqual(result, []);
});

test('typing ranks prefix before substring within a family', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [
      // Both contain "sign"; "signal" is a PREFIX match, "design" a substring.
      { id: 't-design', name: 'design', count: 10 },
      { id: 't-signal', name: 'signal', count: 1 },
    ],
    folders: [],
    query: 'sign',
  });
  // Prefix (signal) ranks ahead of substring (design) despite far lower count.
  assert.deepEqual(labels(result), ['#signal', '#design']);
});

test('typing breaks a same-rank tie by frequency desc then alpha', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [
      // All three are prefix matches of "de"; rank ties → frequency desc, alpha.
      { id: 't-design', name: 'design', count: 2 },
      { id: 't-dev', name: 'dev', count: 5 },
      { id: 't-deck', name: 'deck', count: 2 },
    ],
    folders: [],
    query: 'de',
  });
  // dev (count 5) first; design & deck tie at 2 → alpha (deck before design).
  assert.deepEqual(labels(result), ['#dev', '#deck', '#design']);
});

test('typing drops a recent that exactly equals the query, keeps other matches', () => {
  const result = buildSearchSuggestions({
    recents: ['design', 'design system'],
    tagCounts: [],
    folders: [],
    query: 'design',
  });
  // "design" equals the query (already typed) → dropped; "design system" stays.
  assert.deepEqual(labels(result), ['design system']);
});

test('typing caps matching recents at 3 (lower than the empty-state 6)', () => {
  const recents = Array.from({ length: 6 }, (_, i) => `design ${i}`);
  const result = buildSearchSuggestions({ recents, tagCounts: [], folders: [], query: 'design' });
  assert.equal(result.filter((s) => s.kind === 'recent').length, SUGGESTION_RECENTS_TYPING);
  assert.equal(SUGGESTION_RECENTS_TYPING, 3);
});

test('typing keeps tag/folder caps at 8', () => {
  const tagCounts = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`,
    name: `design${i}`,
    count: 100 - i,
  }));
  const folders = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    name: `Design${i}`,
    count: 100 - i,
  }));
  const result = buildSearchSuggestions({ recents: [], tagCounts, folders, query: 'design' });
  assert.equal(result.filter((s) => s.kind === 'tag').length, SUGGESTION_TAGS_SHOWN);
  assert.equal(result.filter((s) => s.kind === 'folder').length, SUGGESTION_FOLDERS_SHOWN);
});

test('typing keeps cross-family order recents → tags → folders (no score interleave)', () => {
  const result = buildSearchSuggestions({
    // A substring-only recent vs. an exact-match folder: even though the folder
    // is a "better" match, families stay grouped (recents lead).
    recents: ['my design notes'],
    tagCounts: [{ id: 't', name: 'design', count: 1 }],
    folders: [{ id: 'c', name: 'design', count: 1 }],
    query: 'design',
  });
  assert.deepEqual(kinds(result), ['recent', 'tag', 'folder']);
});

test('a two-token query ANDs across tokens (both must hit the candidate)', () => {
  const result = buildSearchSuggestions({
    recents: [],
    tagCounts: [],
    folders: [
      { id: 'c-ds', name: 'Design System', count: 1 },
      { id: 'c-d', name: 'Design', count: 1 },
    ],
    query: 'design sys',
  });
  // "design sys" — both tokens must match; only "Design System" qualifies.
  assert.deepEqual(labels(result), ['Design System']);
});

test('a query with uncomposed jamo falls back to the full focus-empty shelf', () => {
  // iOS/Android Korean IME sends partial jamo (e.g. "ㄱ" U+3131) while the user
  // is mid-syllable. NFKC does NOT decompose composed syllables to jamo, so no
  // candidate can match — the correct UX is to show the browse shelf unfiltered,
  // not an empty rail that confuses the user.
  const result = buildSearchSuggestions({
    recents: ['가나다'],
    tagCounts: [{ id: 't', name: '가나', count: 1 }],
    folders: [{ id: 'c', name: '나다', count: 1 }],
    query: 'ㄱ', // jamo — still mid-composition
  });
  // Jamo detected → falls back to the focus-empty (browse) set: all recents +
  // tags + folders, no filtering.
  assert.equal(result.length, 3);
  assert.deepEqual(kinds(result), ['recent', 'tag', 'folder']);
});

test('typing drops a recent whose NFKC-normalized form equals the query (fullwidth dedup)', () => {
  // Grumpy bug #2: the old dedup used `.toLowerCase()` which disagrees with
  // `collectionMatchKey` for NFKC-variant input. "ＤｅｓｉｇＮ" (fullwidth)
  // lowercases to "ｄｅｓｉｇｎ" ≠ "design", so the exact-match guard missed it.
  const result = buildSearchSuggestions({
    recents: ['design', 'design system'],
    tagCounts: [],
    folders: [],
    query: 'ＤｅｓｉｇＮ', // fullwidth — NFKC normalizes to "design"
  });
  // "design" NFKC-normalizes to the same key as the query → drop it.
  assert.deepEqual(labels(result), ['design system']);
});

test('typing still emits only user-authored values (input contract holds)', () => {
  // The builder takes ONLY user inputs; filtering can never introduce a non-user
  // value. Every chip's label traces back to a supplied recent/tag/folder name.
  const result = buildSearchSuggestions({
    recents: ['design system'],
    tagCounts: [{ id: 't', name: 'design', count: 1 }],
    folders: [{ id: 'c', name: 'Design', count: 1 }],
    query: 'des',
  });
  for (const chip of result) {
    if (chip.kind === 'recent') {
      assert.equal(chip.query, 'design system');
    }
    if (chip.kind === 'tag') {
      assert.deepEqual(chip.filter, { kind: 'tag', id: 't' });
    }
    if (chip.kind === 'folder') {
      assert.deepEqual(chip.filter, { kind: 'collection', id: 'c' });
    }
  }
});
