import assert from 'node:assert/strict';
import test from 'node:test';

import { syncStatusLabel } from './status.ts';
import { createT } from './translate.ts';

test('describes a transient sync failure as waiting for connection', () => {
  const transientFailure = {
    sync_status: 'failed' as const,
    last_error_kind: 'transient_network' as const,
  };
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', transientFailure),
    'sync waiting for connection',
  );
  assert.equal(
    syncStatusLabel(createT('ko'), 'failed', transientFailure),
    '동기화 연결 대기 중',
  );
});

test('uses a failed queue entry when the bookmark still has pending status', () => {
  assert.equal(
    syncStatusLabel(createT('en'), 'pending', {
      sync_status: 'failed',
      last_error_kind: 'transient_network',
    }),
    'sync waiting for connection',
  );
});

test('keeps genuine sync failures labeled as failed', () => {
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', {
      sync_status: 'failed',
      last_error_kind: 'other',
    }),
    'sync failed',
  );
});

test('does not reuse stale transient provenance while a queue entry is pending', () => {
  assert.equal(
    syncStatusLabel(createT('en'), 'pending', {
      sync_status: 'pending',
      last_error_kind: 'transient_network',
    }),
    'sync pending',
  );
});
