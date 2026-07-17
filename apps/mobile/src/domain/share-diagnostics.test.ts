import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildShareAttemptDiagnostics,
  markShareAttemptPersisted,
  parseShareAttemptDiagnostics,
  serializeShareAttemptDiagnostics,
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

test('parse returns null for missing or empty input', () => {
  assert.equal(parseShareAttemptDiagnostics(null), null);
  assert.equal(parseShareAttemptDiagnostics(undefined), null);
  assert.equal(parseShareAttemptDiagnostics(''), null);
});

test('parse returns null for malformed JSON or an unrecognized result', () => {
  assert.equal(parseShareAttemptDiagnostics('not json'), null);
  assert.equal(
    parseShareAttemptDiagnostics(JSON.stringify({ result: 'bogus', updatedAt: '2026-07-13T00:00:00.000Z' })),
    null,
  );
  assert.equal(parseShareAttemptDiagnostics(JSON.stringify({ hasUrl: true })), null);
});

test('serialize round-trips through parse', () => {
  const value = buildShareAttemptDiagnostics({
    attemptId: 'native-attempt-1',
    receivedAt: '2026-07-17T08:00:00.000Z',
    hasUrl: false,
    hasText: false,
    hasImage: true,
    fileCount: 2,
    fileMimeTypes: ['image/jpeg', 'video/mp4'],
    result: 'created',
  });
  assert.deepEqual(parseShareAttemptDiagnostics(serializeShareAttemptDiagnostics(value)), value);
});

test('persistence outcome only updates the matching attempt', () => {
  const value = buildShareAttemptDiagnostics({
    attemptId: 'native-attempt-1',
    receivedAt: '2026-07-17T08:00:00.000Z',
    hasUrl: true,
    hasText: true,
    hasImage: false,
    fileCount: 0,
    fileMimeTypes: [],
    result: 'created',
  });

  assert.equal(markShareAttemptPersisted(value, 'other-attempt', true), null);
  const persisted = markShareAttemptPersisted(value, 'native-attempt-1', true);
  assert.equal(persisted?.durable, true);
  assert.match(persisted?.persistedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
});
