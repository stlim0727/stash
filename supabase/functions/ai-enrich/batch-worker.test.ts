import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_ENRICHMENT_ATTEMPTS,
  chunk,
  nextAttemptState,
  pickDrainedUsers,
  pushBodyForLocale,
  staleTokenIndexes,
  tallyProcessedByUser,
} from './batch-worker.ts';

test('chunk splits into groups of the given size, last group smaller', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk returns one group when size >= length', () => {
  assert.deepEqual(chunk([1, 2], 8), [[1, 2]]);
});

test('chunk returns no groups for an empty input', () => {
  assert.deepEqual(chunk([], 8), []);
});

test('chunk rejects a non-positive size', () => {
  assert.throws(() => chunk([1, 2], 0));
  assert.throws(() => chunk([1, 2], -1));
});

test('nextAttemptState increments attempts and stays pending under the cap', () => {
  assert.deepEqual(nextAttemptState(0), { attempts: 1, status: 'pending' });
  assert.deepEqual(nextAttemptState(3), { attempts: 4, status: 'pending' });
});

test('nextAttemptState marks failed once attempts reach the cap', () => {
  assert.deepEqual(nextAttemptState(MAX_ENRICHMENT_ATTEMPTS - 1), {
    attempts: MAX_ENRICHMENT_ATTEMPTS,
    status: 'failed',
  });
});

test('nextAttemptState never reverts a past-cap row back to pending', () => {
  assert.deepEqual(nextAttemptState(MAX_ENRICHMENT_ATTEMPTS + 5), {
    attempts: MAX_ENRICHMENT_ATTEMPTS + 6,
    status: 'failed',
  });
});

// ── Drained-queue push notification (STASH #579) ────────────────────────────

test('tallyProcessedByUser counts rows per user and keeps the last-seen locale', () => {
  const tally = tallyProcessedByUser([
    { user_id: 'u1', locale: 'en' },
    { user_id: 'u2', locale: null },
    { user_id: 'u1', locale: 'ko' },
    { user_id: 'u1', locale: null },
  ]);
  assert.deepEqual(tally.get('u1'), { count: 3, locale: 'ko' });
  assert.deepEqual(tally.get('u2'), { count: 1, locale: null });
  assert.equal(tally.size, 2);
});

test('tallyProcessedByUser does not overwrite a locale with a later null', () => {
  const tally = tallyProcessedByUser([
    { user_id: 'u1', locale: 'ko' },
    { user_id: 'u1', locale: null },
  ]);
  assert.deepEqual(tally.get('u1'), { count: 2, locale: 'ko' });
});

test('tallyProcessedByUser returns an empty map for no rows', () => {
  assert.equal(tallyProcessedByUser([]).size, 0);
});

test('pickDrainedUsers keeps only users with nothing still pending/processing', () => {
  const drained = pickDrainedUsers(['u1', 'u2', 'u3'], new Set(['u2']));
  assert.deepEqual(drained, ['u1', 'u3']);
});

test('pickDrainedUsers returns empty when every affected user still has work queued', () => {
  assert.deepEqual(pickDrainedUsers(['u1', 'u2'], new Set(['u1', 'u2'])), []);
});

test('pickDrainedUsers returns everyone when nothing is still pending', () => {
  assert.deepEqual(pickDrainedUsers(['u1', 'u2'], new Set()), ['u1', 'u2']);
});

test('pushBodyForLocale singularizes English at count 1', () => {
  assert.equal(pushBodyForLocale('en', 1), '1 bookmark summarized & tagged');
});

test('pushBodyForLocale pluralizes English above 1', () => {
  assert.equal(pushBodyForLocale('en', 3), '3 bookmarks summarized & tagged');
});

test('pushBodyForLocale formats Korean regardless of count', () => {
  assert.equal(pushBodyForLocale('ko', 5), '북마크 5개가 요약 및 태그 정리되었어요');
});

test('pushBodyForLocale falls back to English for an unset locale', () => {
  assert.equal(pushBodyForLocale(null, 2), '2 bookmarks summarized & tagged');
  assert.equal(pushBodyForLocale(undefined, 2), '2 bookmarks summarized & tagged');
});

test('pushBodyForLocale falls back to English for an unsupported locale', () => {
  assert.equal(pushBodyForLocale('fr', 2), '2 bookmarks summarized & tagged');
});

test('staleTokenIndexes finds only DeviceNotRegistered error tickets, by index', () => {
  const indexes = staleTokenIndexes([
    { status: 'ok' },
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', details: { error: 'MessageTooBig' } },
    { status: 'error' },
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
  ]);
  assert.deepEqual(indexes, [1, 4]);
});

test('staleTokenIndexes returns empty for all-ok tickets', () => {
  assert.deepEqual(staleTokenIndexes([{ status: 'ok' }, { status: 'ok' }]), []);
});
