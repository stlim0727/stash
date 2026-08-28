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

test('a single DNS failure still reads as waiting for connection (STASH-4Z)', () => {
  const dnsFailure = {
    sync_status: 'failed' as const,
    last_error_kind: 'transient_dns' as const,
  };
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', dnsFailure),
    'sync waiting for connection',
  );
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', dnsFailure, false),
    'sync waiting for connection',
  );
});

test('a repeated DNS failure surfaces the check-connection copy (STASH-4Z)', () => {
  const dnsFailure = {
    sync_status: 'failed' as const,
    last_error_kind: 'transient_dns' as const,
  };
  assert.equal(
    syncStatusLabel(createT('en'), 'failed', dnsFailure, true),
    'sync check connection',
  );
  assert.equal(
    syncStatusLabel(createT('ko'), 'failed', dnsFailure, true),
    '동기화 연결 확인 필요',
  );
});

test('an actively-retrying entry ignores stale DNS provenance even when other entries are repeating (STASH-4Z review)', () => {
  // The retry loop flips sync_status to 'syncing' while spreading the rest
  // of the entry unchanged, so last_error_kind can still read 'transient_dns'
  // from the PREVIOUS failed attempt while this one is actively in flight.
  assert.equal(
    syncStatusLabel(
      createT('en'),
      'syncing',
      { sync_status: 'syncing', last_error_kind: 'transient_dns' },
      true,
    ),
    'sync syncing',
  );
});

test('repeatedDnsFailure does not affect a non-DNS transient failure', () => {
  assert.equal(
    syncStatusLabel(
      createT('en'),
      'failed',
      { sync_status: 'failed', last_error_kind: 'transient_network' },
      true,
    ),
    'sync waiting for connection',
  );
});
