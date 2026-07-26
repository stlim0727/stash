import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_FOLDER_SORT,
  FOLDER_SORT_PRESETS,
  describeFolderSort,
  parseFolderSort,
  sameFolderSort,
  serializeFolderSort,
  sortFolderTiles,
  type FolderSortable,
  type FolderSortOption,
} from './folder-sort.ts';

function tile(id: string, name: string, count: number): FolderSortable {
  return { id, name, count };
}

const work = tile('col-work', 'Work', 3);
const recipes = tile('col-recipes', 'recipes', 7);
const archive = tile('col-archive', 'Archive', 3);

function ids(sorted: FolderSortable[]): string[] {
  return sorted.map((x) => x.id);
}

test('default is name-ascending — the pre-existing hardcoded order', () => {
  assert.deepEqual(DEFAULT_FOLDER_SORT, { field: 'name', dir: 'asc' });
});

test('name sort is locale-aware / case-insensitive, both directions', () => {
  const items = [work, recipes, archive];
  assert.deepEqual(ids(sortFolderTiles(items, { field: 'name', dir: 'asc' })), [
    'col-archive',
    'col-recipes',
    'col-work',
  ]);
  assert.deepEqual(ids(sortFolderTiles(items, { field: 'name', dir: 'desc' })), [
    'col-work',
    'col-recipes',
    'col-archive',
  ]);
});

test('count sort orders by item count, both directions', () => {
  const items = [work, recipes, archive];
  // desc ("항목 많은 순"): recipes (7) before the two tied-at-3 (which then
  // break by name ascending: Archive before Work).
  assert.deepEqual(ids(sortFolderTiles(items, { field: 'count', dir: 'desc' })), [
    'col-recipes',
    'col-archive',
    'col-work',
  ]);
  // asc ("항목 적은 순"): the tied-at-3 pair first (name-ascending), then recipes.
  assert.deepEqual(ids(sortFolderTiles(items, { field: 'count', dir: 'asc' })), [
    'col-archive',
    'col-work',
    'col-recipes',
  ]);
});

test('count ties always break by name-ascending regardless of direction', () => {
  const a = tile('a', 'Zebra', 5);
  const b = tile('b', 'apple', 5);
  const c = tile('c', 'Mango', 5);
  assert.deepEqual(ids(sortFolderTiles([a, b, c], { field: 'count', dir: 'desc' })), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortFolderTiles([a, b, c], { field: 'count', dir: 'asc' })), ['b', 'c', 'a']);
});

test('name ties break by id for full determinism', () => {
  const a = tile('a', 'Same', 1);
  const b = tile('b', 'Same', 9);
  assert.deepEqual(ids(sortFolderTiles([b, a], { field: 'name', dir: 'asc' })), ['a', 'b']);
  assert.deepEqual(ids(sortFolderTiles([b, a], { field: 'name', dir: 'desc' })), ['a', 'b']);
});

test('does not mutate the input array', () => {
  const items = [work, recipes, archive];
  const snapshot = ids(items);
  sortFolderTiles(items, { field: 'count', dir: 'desc' });
  assert.deepEqual(ids(items), snapshot);
});

test('describeFolderSort labels each option', () => {
  assert.equal(describeFolderSort({ field: 'name', dir: 'asc' }), 'Name A–Z');
  assert.equal(describeFolderSort({ field: 'name', dir: 'desc' }), 'Name Z–A');
  assert.equal(describeFolderSort({ field: 'count', dir: 'desc' }), 'Most items');
  assert.equal(describeFolderSort({ field: 'count', dir: 'asc' }), 'Fewest items');
});

test('FOLDER_SORT_PRESETS are unique, the default is among them, and name-asc is first', () => {
  const seen = new Set(FOLDER_SORT_PRESETS.map(serializeFolderSort));
  assert.equal(seen.size, FOLDER_SORT_PRESETS.length);
  assert.ok(FOLDER_SORT_PRESETS.some((option) => sameFolderSort(option, DEFAULT_FOLDER_SORT)));
  assert.deepEqual(FOLDER_SORT_PRESETS[0], DEFAULT_FOLDER_SORT);
});

test('sameFolderSort compares field and direction', () => {
  assert.ok(sameFolderSort({ field: 'name', dir: 'asc' }, { field: 'name', dir: 'asc' }));
  assert.ok(!sameFolderSort({ field: 'name', dir: 'asc' }, { field: 'name', dir: 'desc' }));
  assert.ok(!sameFolderSort({ field: 'name', dir: 'asc' }, { field: 'count', dir: 'asc' }));
});

test('serialize/parse round-trips and falls back to default', () => {
  const opts: FolderSortOption[] = [
    { field: 'name', dir: 'asc' },
    { field: 'name', dir: 'desc' },
    { field: 'count', dir: 'desc' },
    { field: 'count', dir: 'asc' },
  ];
  for (const o of opts) {
    assert.deepEqual(parseFolderSort(serializeFolderSort(o)), o);
  }
  assert.deepEqual(parseFolderSort(null), DEFAULT_FOLDER_SORT);
  assert.deepEqual(parseFolderSort(''), DEFAULT_FOLDER_SORT);
  assert.deepEqual(parseFolderSort('garbage'), DEFAULT_FOLDER_SORT);
  assert.deepEqual(parseFolderSort('date:desc'), DEFAULT_FOLDER_SORT);
});
