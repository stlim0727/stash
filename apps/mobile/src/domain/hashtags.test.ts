import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractHashtags, hashtagSuggestions } from './hashtags.ts';

test('extracts hashtags and strips the leading #', () => {
  assert.deepEqual(extractHashtags('SNS에서 난리난 덮밥 #목살 #덮밥'), ['목살', '덮밥']);
});

test('handles ascii hashtags too', () => {
  assert.deepEqual(extractHashtags('Best #recipe for #dinner tonight'), ['recipe', 'dinner']);
});

test('de-duplicates case-insensitively, keeping first-seen casing', () => {
  assert.deepEqual(extractHashtags('#Food is great #food #FOOD'), ['Food']);
});

test('ignores purely-numeric tags but keeps alphanumeric ones', () => {
  assert.deepEqual(extractHashtags('#2024 #top10 #100'), ['top10']);
});

test('scans multiple fields in order', () => {
  assert.deepEqual(extractHashtags('#title', 'body #note #title'), ['title', 'note']);
});

test('returns an empty array when there are no hashtags', () => {
  assert.deepEqual(extractHashtags('plain text', null, undefined), []);
});

test('does not treat a bare # or # followed by punctuation as a tag', () => {
  assert.deepEqual(extractHashtags('a # b #!? c'), []);
});

test('caps the number of extracted hashtags', () => {
  const many = Array.from({ length: 30 }, (_, i) => `#tag${i}`).join(' ');
  assert.equal(extractHashtags(many).length, 12);
});

test('hashtagSuggestions drops tags already applied (case-insensitive)', () => {
  const applied = new Set(['목살']);
  assert.deepEqual(hashtagSuggestions(['#목살 #덮밥'], applied), ['덮밥']);
});

test('hashtagSuggestions returns all when none applied', () => {
  assert.deepEqual(hashtagSuggestions(['#a #b'], new Set()), ['a', 'b']);
});
