import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ENRICHMENT_ATTEMPTS, chunk, nextAttemptState } from './batch-worker.ts';

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
