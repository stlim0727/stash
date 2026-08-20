import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendShareAttemptHistory,
  buildShareAttemptDiagnostics,
  markShareAttemptHistoryPersisted,
  MAX_SHARE_ATTEMPT_HISTORY,
  parseShareAttemptHistory,
  serializeShareAttemptHistory,
} from '@/domain/share-diagnostics';

test('build normalizes booleans, caps file counts/mime types, and stamps a timestamp', () => {
  const record = buildShareAttemptDiagnostics({
    hasUrl: false,
    hasText: true,
    hasImage: false,
    fileCount: -3,
    fileMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/bmp'],
    result: 'invalid',
  });

  assert.equal(record.hasUrl, false);
  assert.equal(record.hasText, true);
  assert.equal(record.fileCount, 0);
  assert.deepEqual(record.fileMimeTypes, ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']);
  assert.equal(record.result, 'invalid');
  assert.match(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('build falls back to "invalid" for an unrecognized result', () => {
  const record = buildShareAttemptDiagnostics({
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'bogus' as never,
  });
  assert.equal(record.result, 'invalid');
});

test('build keeps a valid loadWaitMs and rounds it, but drops a negative one', () => {
  const withWait = buildShareAttemptDiagnostics({
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
    loadWaitMs: 1234.7,
  });
  assert.equal(withWait.loadWaitMs, 1235);

  const negative = buildShareAttemptDiagnostics({
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
    loadWaitMs: -5,
  });
  assert.equal(negative.loadWaitMs, undefined);
});

test('parseShareAttemptHistory returns [] for missing, empty, or non-array input', () => {
  assert.deepEqual(parseShareAttemptHistory(null), []);
  assert.deepEqual(parseShareAttemptHistory(undefined), []);
  assert.deepEqual(parseShareAttemptHistory(''), []);
  assert.deepEqual(parseShareAttemptHistory('not json'), []);
  // The pre-history format this key used to hold: a single object, not an array.
  assert.deepEqual(
    parseShareAttemptHistory(JSON.stringify({ result: 'created', updatedAt: '2026-07-13T00:00:00.000Z' })),
    [],
  );
});

test('parseShareAttemptHistory drops malformed entries but keeps valid ones', () => {
  const valid = buildShareAttemptDiagnostics({
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
  });
  const raw = JSON.stringify([valid, { result: 'bogus' }, { hasUrl: true }]);
  assert.deepEqual(parseShareAttemptHistory(raw), [valid]);
});

test('history round-trips through serialize/parse', () => {
  const a = buildShareAttemptDiagnostics({
    attemptId: 'native-attempt-1',
    receivedAt: '2026-07-17T08:00:00.000Z',
    hasUrl: false,
    hasText: false,
    hasImage: true,
    fileCount: 2,
    fileMimeTypes: ['image/jpeg', 'video/mp4'],
    result: 'created',
    loadWaitMs: 4200,
  });
  const b = buildShareAttemptDiagnostics({
    attemptId: 'native-attempt-2',
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'invalid',
  });
  const history = [a, b];
  assert.deepEqual(parseShareAttemptHistory(serializeShareAttemptHistory(history)), history);
});

test('appendShareAttemptHistory caps the ring at MAX_SHARE_ATTEMPT_HISTORY, dropping the oldest', () => {
  let history: ReturnType<typeof buildShareAttemptDiagnostics>[] = [];
  for (let i = 0; i < MAX_SHARE_ATTEMPT_HISTORY + 3; i += 1) {
    history = appendShareAttemptHistory(
      history,
      buildShareAttemptDiagnostics({
        attemptId: `attempt-${i}`,
        hasUrl: true,
        hasText: false,
        hasImage: false,
        fileCount: 0,
        fileMimeTypes: [],
        result: 'created',
      }),
    );
  }
  assert.equal(history.length, MAX_SHARE_ATTEMPT_HISTORY);
  assert.equal(history[0].attemptId, 'attempt-3');
  assert.equal(history[history.length - 1].attemptId, `attempt-${MAX_SHARE_ATTEMPT_HISTORY + 2}`);
});

test('markShareAttemptHistoryPersisted updates only the matching attempt and returns null otherwise', () => {
  const first = buildShareAttemptDiagnostics({
    attemptId: 'attempt-1',
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
  });
  const second = buildShareAttemptDiagnostics({
    attemptId: 'attempt-2',
    hasUrl: true,
    hasText: false,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
  });
  const history = [first, second];

  assert.equal(markShareAttemptHistoryPersisted(history, 'other-attempt', true), null);

  const updated = markShareAttemptHistoryPersisted(history, 'attempt-1', true);
  assert.ok(updated);
  assert.equal(updated?.[0].durable, true);
  assert.match(updated?.[0].persistedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  // The other entry is untouched.
  assert.equal(updated?.[1].durable, undefined);
});
