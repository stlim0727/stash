import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  clearSlowSegments,
  describeRecentSegments,
  getSlowSegments,
  MAX_SLOW_SEGMENTS,
  measureSyncSegment,
  recordSlowSegment,
  SLOW_SEGMENT_THRESHOLD_MS,
  SLOW_SEGMENT_WINDOW_MS,
} from './slow-segment-log.ts';

beforeEach(() => {
  clearSlowSegments();
});

test('a segment below the threshold is dropped, one at or above it is kept', () => {
  recordSlowSegment('fast', SLOW_SEGMENT_THRESHOLD_MS - 1, 1_000);
  assert.deepEqual(getSlowSegments(), []);

  recordSlowSegment('slow', SLOW_SEGMENT_THRESHOLD_MS, 2_000);
  assert.deepEqual(getSlowSegments(), [
    { label: 'slow', durationMs: SLOW_SEGMENT_THRESHOLD_MS, endedAt: 2_000 },
  ]);
});

test('the buffer keeps the newest segments and drops the oldest', () => {
  for (let index = 0; index < MAX_SLOW_SEGMENTS + 3; index += 1) {
    recordSlowSegment(`seg-${index}`, 600, 1_000 + index);
  }
  const kept = getSlowSegments();
  assert.equal(kept.length, MAX_SLOW_SEGMENTS);
  assert.equal(kept[0]!.label, 'seg-3');
  assert.equal(kept.at(-1)!.label, `seg-${MAX_SLOW_SEGMENTS + 2}`);
});

test('describeRecentSegments renders duration and age, oldest first', () => {
  recordSlowSegment('pull-merge', 800, 9_000);
  recordSlowSegment('react-cycle', 2_900, 9_800);

  assert.equal(
    describeRecentSegments(10_000),
    'pull-merge 800ms 1000ms ago, react-cycle 2900ms 200ms ago',
  );
});

test('describeRecentSegments ignores segments older than the window', () => {
  recordSlowSegment('ancient', 4_000, 1_000);
  recordSlowSegment('recent', 3_100, 1_000 + SLOW_SEGMENT_WINDOW_MS);

  const now = 1_000 + SLOW_SEGMENT_WINDOW_MS + 1;
  assert.equal(describeRecentSegments(now), 'recent 3100ms 1ms ago');
});

test('describeRecentSegments is empty when nothing crossed the threshold', () => {
  recordSlowSegment('fast', 10, 1_000);
  assert.equal(describeRecentSegments(1_100), '');
});

test('measureSyncSegment returns the value and records the elapsed time', () => {
  let currentMs = 0;
  const now = () => currentMs;

  const value = measureSyncSegment(
    'bulk-chunk-merge',
    () => {
      currentMs = 3_100;
      return 'done';
    },
    now,
  );

  assert.equal(value, 'done');
  assert.deepEqual(getSlowSegments(), [
    { label: 'bulk-chunk-merge', durationMs: 3_100, endedAt: 3_100 },
  ]);
});

test('measureSyncSegment still records and rethrows when the region throws', () => {
  let currentMs = 0;
  const now = () => currentMs;

  assert.throws(
    () =>
      measureSyncSegment(
        'bulk-chunk-merge',
        () => {
          currentMs = 700;
          throw new Error('boom');
        },
        now,
      ),
    /boom/,
  );

  assert.deepEqual(getSlowSegments(), [
    { label: 'bulk-chunk-merge', durationMs: 700, endedAt: 700 },
  ]);
});
