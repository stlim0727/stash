import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Bookmark } from '@/domain/types';
import {
  DEFAULT_SORT,
  SORT_PRESETS,
  describeSort,
  parseSort,
  sameSort,
  serializeSort,
  sortBookmarks,
  type SortOption,
} from './sort.ts';

function make(
  id: string,
  title: string | null,
  created_at: string,
  url: string | null = null,
  last_accessed_at: string | null = null,
): Bookmark {
  return {
    id,
    user_id: 'u',
    url,
    canonical_url: null,
    url_hash: null,
    title,
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at,
    updated_at: created_at,
    last_saved_at: created_at,
    last_accessed_at,
    metadata_status: 'complete',
    sync_status: 'synced',
  };
}

const a = make('a', 'Banana', '2026-01-03T00:00:00.000Z');
const b = make('b', 'apple', '2026-01-01T00:00:00.000Z');
const c = make('c', 'Cherry', '2026-01-02T00:00:00.000Z');
const list = [b, a, c];

function ids(sorted: Bookmark[]): string[] {
  return sorted.map((x) => x.id);
}

test('default is newest-first by date', () => {
  assert.deepEqual(DEFAULT_SORT, { field: 'date', dir: 'desc' });
  assert.deepEqual(ids(sortBookmarks(list, DEFAULT_SORT)), ['a', 'c', 'b']);
});

test('date ascending is oldest-first', () => {
  assert.deepEqual(ids(sortBookmarks(list, { field: 'date', dir: 'asc' })), ['b', 'c', 'a']);
});

test('name sort is case-insensitive (A–Z and Z–A)', () => {
  assert.deepEqual(ids(sortBookmarks(list, { field: 'name', dir: 'asc' })), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortBookmarks(list, { field: 'name', dir: 'desc' })), ['c', 'a', 'b']);
});

test('name sort falls back to URL when there is no title', () => {
  const titled = make('p', 'Zebra', '2026-01-04T00:00:00.000Z');
  const noTitle = make('q', null, '2026-01-05T00:00:00.000Z', 'https://example.com');
  // The null-title row sorts by its URL key ("https://…" < "zebra"), not as an
  // empty string and not by its (newer) date.
  const sorted = sortBookmarks([titled, noTitle], { field: 'name', dir: 'asc' });
  assert.deepEqual(ids(sorted), ['q', 'p']);
});

test('does not mutate the input array', () => {
  const input = [b, a, c];
  const snapshot = ids(input);
  sortBookmarks(input, { field: 'name', dir: 'asc' });
  assert.deepEqual(ids(input), snapshot);
});

test('ties break deterministically (newest-first, then id)', () => {
  const t = '2026-02-01T00:00:00.000Z';
  const x = make('x', 'Same', t);
  const y = make('y', 'Same', t);
  // equal name + equal date → stable by id
  assert.deepEqual(ids(sortBookmarks([y, x], { field: 'name', dir: 'asc' })), ['x', 'y']);
});

test('accessed sort orders by last-opened time, newest-opened first', () => {
  // a (opened Jan 20) > c (opened Jan 10) > b (never opened → falls back to its
  // save date, Jan 1, so it sinks below the opened ones).
  const aa = make('a', 'A', '2026-01-03T00:00:00.000Z', null, '2026-01-20T00:00:00.000Z');
  const bb = make('b', 'B', '2026-01-01T00:00:00.000Z');
  const cc = make('c', 'C', '2026-01-02T00:00:00.000Z', null, '2026-01-10T00:00:00.000Z');
  assert.deepEqual(ids(sortBookmarks([bb, aa, cc], { field: 'accessed', dir: 'desc' })), ['a', 'c', 'b']);
  // Ascending = least-recently-opened first.
  assert.deepEqual(ids(sortBookmarks([bb, aa, cc], { field: 'accessed', dir: 'asc' })), ['b', 'c', 'a']);
});

test('accessed sort falls back to created_at when never opened', () => {
  // Neither opened → ordered purely by save date (newest-saved first on desc).
  const older = make('o', 'O', '2026-01-01T00:00:00.000Z');
  const newer = make('n', 'N', '2026-01-05T00:00:00.000Z');
  assert.deepEqual(ids(sortBookmarks([older, newer], { field: 'accessed', dir: 'desc' })), ['n', 'o']);
});

test('describeSort labels each option', () => {
  assert.equal(describeSort({ field: 'date', dir: 'desc' }), 'Newest');
  assert.equal(describeSort({ field: 'date', dir: 'asc' }), 'Oldest');
  assert.equal(describeSort({ field: 'accessed', dir: 'desc' }), 'Recently opened');
  assert.equal(describeSort({ field: 'accessed', dir: 'asc' }), 'Least recently opened');
  assert.equal(describeSort({ field: 'name', dir: 'asc' }), 'Name A–Z');
  assert.equal(describeSort({ field: 'name', dir: 'desc' }), 'Name Z–A');
});

test('SORT_PRESETS are unique and the default is among them', () => {
  const seen = new Set(SORT_PRESETS.map(serializeSort));
  assert.equal(seen.size, SORT_PRESETS.length);
  assert.ok(SORT_PRESETS.some((option) => sameSort(option, DEFAULT_SORT)));
});

test('sameSort compares field and direction', () => {
  assert.ok(sameSort({ field: 'date', dir: 'desc' }, { field: 'date', dir: 'desc' }));
  assert.ok(!sameSort({ field: 'date', dir: 'desc' }, { field: 'date', dir: 'asc' }));
  assert.ok(!sameSort({ field: 'date', dir: 'asc' }, { field: 'accessed', dir: 'asc' }));
});

test('serialize/parse round-trips and falls back to default', () => {
  const opts: SortOption[] = [
    { field: 'date', dir: 'desc' },
    { field: 'date', dir: 'asc' },
    { field: 'accessed', dir: 'desc' },
    { field: 'accessed', dir: 'asc' },
    { field: 'name', dir: 'asc' },
    { field: 'name', dir: 'desc' },
  ];
  for (const o of opts) {
    assert.deepEqual(parseSort(serializeSort(o)), o);
  }
  assert.deepEqual(parseSort(null), DEFAULT_SORT);
  assert.deepEqual(parseSort(''), DEFAULT_SORT);
  assert.deepEqual(parseSort('garbage'), DEFAULT_SORT);
  assert.deepEqual(parseSort('name:sideways'), DEFAULT_SORT);
});
