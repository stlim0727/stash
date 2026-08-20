import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendPullAttemptDiagnostics,
  buildPullAttemptDiagnostics,
  MAX_PULL_ATTEMPTS,
  parsePullDiagnosticsHistory,
  serializePullDiagnosticsHistory,
} from '@/domain/pull-diagnostics';

test('build normalizes since/fullRefreshReason/counts and stamps a timestamp', () => {
  const record = buildPullAttemptDiagnostics({
    since: '2026-08-01T00:00:00.000Z',
    fullRefreshReason: null,
    remoteRowCount: 12.9,
    outcome: 'success',
    durationMs: 340.4,
  });

  assert.equal(record.since, '2026-08-01T00:00:00.000Z');
  assert.equal(record.fullRefreshReason, null);
  assert.equal(record.remoteRowCount, 12);
  assert.equal(record.outcome, 'success');
  assert.equal(record.durationMs, 340);
  assert.equal(record.errorMessage, undefined);
  assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('build treats a null/empty since as a full refresh watermark', () => {
  const record = buildPullAttemptDiagnostics({
    since: null,
    fullRefreshReason: 'user_changed',
    remoteRowCount: 0,
    outcome: 'success',
    durationMs: 10,
  });
  assert.equal(record.since, null);
  assert.equal(record.fullRefreshReason, 'user_changed');
});

test('build drops a negative remoteRowCount to 0 and rejects an unrecognized fullRefreshReason', () => {
  const record = buildPullAttemptDiagnostics({
    since: null,
    fullRefreshReason: 'bogus' as never,
    remoteRowCount: -5,
    outcome: 'success',
    durationMs: 0,
  });
  assert.equal(record.remoteRowCount, 0);
  assert.equal(record.fullRefreshReason, null);
});

test('build only keeps errorMessage for a failure outcome', () => {
  const successWithMessage = buildPullAttemptDiagnostics({
    since: null,
    fullRefreshReason: null,
    remoteRowCount: 0,
    outcome: 'success',
    errorMessage: 'should be dropped',
    durationMs: 5,
  });
  assert.equal(successWithMessage.errorMessage, undefined);

  const failure = buildPullAttemptDiagnostics({
    since: null,
    fullRefreshReason: null,
    remoteRowCount: 0,
    outcome: 'failure',
    errorMessage: 'network request failed',
    durationMs: 5,
  });
  assert.equal(failure.errorMessage, 'network request failed');
});

test('append prepends newest-first and caps history at MAX_PULL_ATTEMPTS', () => {
  let history: ReturnType<typeof buildPullAttemptDiagnostics>[] = [];
  for (let i = 0; i < MAX_PULL_ATTEMPTS + 3; i += 1) {
    const attempt = buildPullAttemptDiagnostics({
      since: null,
      fullRefreshReason: null,
      remoteRowCount: i,
      outcome: 'success',
      durationMs: i,
    });
    history = appendPullAttemptDiagnostics(history, attempt);
  }
  assert.equal(history.length, MAX_PULL_ATTEMPTS);
  // Newest (highest remoteRowCount) first.
  assert.equal(history[0]?.remoteRowCount, MAX_PULL_ATTEMPTS + 2);
});

test('parse returns [] for missing, empty, or malformed input', () => {
  assert.deepEqual(parsePullDiagnosticsHistory(null), []);
  assert.deepEqual(parsePullDiagnosticsHistory(undefined), []);
  assert.deepEqual(parsePullDiagnosticsHistory(''), []);
  assert.deepEqual(parsePullDiagnosticsHistory('not json'), []);
  assert.deepEqual(parsePullDiagnosticsHistory(JSON.stringify({ not: 'an array' })), []);
});

test('parse drops individual malformed entries but keeps the rest', () => {
  const good = buildPullAttemptDiagnostics({
    since: '2026-08-01T00:00:00.000Z',
    fullRefreshReason: null,
    remoteRowCount: 3,
    outcome: 'success',
    durationMs: 100,
  });
  const raw = JSON.stringify([good, { bogus: true }, { outcome: 'not-a-real-outcome' }]);
  const parsed = parsePullDiagnosticsHistory(raw);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], good);
});

test('serialize round-trips through parse', () => {
  const history = [
    buildPullAttemptDiagnostics({
      since: '2026-08-01T00:00:00.000Z',
      fullRefreshReason: 'empty_real_cache_same_user',
      remoteRowCount: 7,
      outcome: 'success',
      durationMs: 220,
    }),
    buildPullAttemptDiagnostics({
      since: null,
      fullRefreshReason: null,
      remoteRowCount: 0,
      outcome: 'failure',
      errorMessage: 'Pull stopped because sync was paused.',
      durationMs: 15,
    }),
  ];
  assert.deepEqual(parsePullDiagnosticsHistory(serializePullDiagnosticsHistory(history)), history);
});
