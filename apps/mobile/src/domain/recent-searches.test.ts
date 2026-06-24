import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RECENT_SEARCHES_CAP,
  addRecent,
  parseRecents,
  removeRecent,
  serializeRecents,
} from './recent-searches.ts';

test('addRecent trims and prepends a new query', () => {
  assert.deepEqual(addRecent([], '  design  '), ['design']);
  assert.deepEqual(addRecent(['design'], 'recipes'), ['recipes', 'design']);
});

test('addRecent ignores an empty or whitespace-only query', () => {
  assert.deepEqual(addRecent(['design'], ''), ['design']);
  assert.deepEqual(addRecent(['design'], '   '), ['design']);
});

test('re-searching moves the entry to the front instead of duplicating', () => {
  assert.deepEqual(addRecent(['recipes', 'design'], 'design'), ['design', 'recipes']);
});

test('addRecent de-dupes case-insensitively and the new casing wins', () => {
  // "Design" matches the existing "design" → one entry, promoted, re-cased.
  assert.deepEqual(addRecent(['design', 'recipes'], 'Design'), ['Design', 'recipes']);
});

test('addRecent caps the stored list and drops the oldest', () => {
  const full = ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']; // 8 entries (the cap)
  assert.equal(full.length, RECENT_SEARCHES_CAP);
  const next = addRecent(full, 'i');
  assert.equal(next.length, RECENT_SEARCHES_CAP);
  assert.equal(next[0], 'i');
  // 'a' (the oldest) falls off the tail.
  assert.ok(!next.includes('a'));
});

test('addRecent does not mutate the input array', () => {
  const input = ['design'];
  addRecent(input, 'recipes');
  assert.deepEqual(input, ['design']);
});

test('removeRecent drops a single entry case-insensitively', () => {
  assert.deepEqual(removeRecent(['design', 'recipes'], 'DESIGN'), ['recipes']);
  // A no-match leaves the list untouched.
  assert.deepEqual(removeRecent(['design'], 'missing'), ['design']);
  assert.deepEqual(removeRecent(['design'], '  '), ['design']);
});

test('parse/serialize round-trips a clean list', () => {
  const list = ['design', 'recipes'];
  assert.deepEqual(parseRecents(serializeRecents(list)), list);
});

test('parseRecents tolerates a missing or malformed value', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents(''), []);
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('{"not":"an array"}'), []);
});

test('parseRecents cleans a hand-edited / legacy value', () => {
  // Non-strings dropped, blanks dropped, trimmed, case-insensitively deduped,
  // and capped — a corrupt pref can never exceed the contract.
  const raw = JSON.stringify(['  design ', 42, '', 'Design', 'recipes', null]);
  assert.deepEqual(parseRecents(raw), ['design', 'recipes']);
});

test('parseRecents enforces the cap on an over-long stored value', () => {
  const raw = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
  assert.equal(parseRecents(raw).length, RECENT_SEARCHES_CAP);
});
