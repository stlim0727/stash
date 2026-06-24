import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SUGGESTION_FOLDERS_SHOWN,
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

test('the Phase-2 query seam is accepted and ignored in Phase 1', () => {
  // Passing a query must not change the Phase-1 output (the shelf only shows on
  // an empty query). The arg exists so Phase 2 can swap the data source.
  const base = { recents: ['design'], tagCounts: [], folders: [] };
  assert.deepEqual(
    buildSearchSuggestions({ ...base, query: 'des' }),
    buildSearchSuggestions(base),
  );
});
