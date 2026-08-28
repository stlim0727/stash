import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasRepeatedDnsFailures,
  isDnsResolutionFailure,
  isTransientNetworkError,
  isTransientSyncFailure,
} from './network-errors.ts';
import type { LocalPendingBookmark } from './types.ts';

test('recognizes the Android offline/DNS failure (STASH-4)', () => {
  const error = new Error(
    'fetch failed: java.net.UnknownHostException: Unable to resolve host "example.supabase.co": No address associated with hostname',
  );
  assert.equal(isTransientNetworkError(error), true);
});

test('recognizes React Native and web transport failures', () => {
  assert.equal(isTransientNetworkError(new Error('Network request failed')), true);
  assert.equal(isTransientNetworkError(new Error('TypeError: Failed to fetch')), true);
  assert.equal(isTransientNetworkError(new Error('The request timed out.')), true);
});

test('does not flag a genuine server/application error', () => {
  assert.equal(isTransientNetworkError(new Error('HTTP 500: internal server error')), false);
  assert.equal(isTransientNetworkError(new Error('Cannot read property "x" of undefined')), false);
});

test('is null/undefined safe', () => {
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError(undefined), false);
  assert.equal(isTransientNetworkError(''), false);
});

test('isDnsResolutionFailure isolates the DNS-specific subset (STASH-4Z)', () => {
  assert.equal(
    isDnsResolutionFailure(
      new Error(
        'fetch failed: java.net.UnknownHostException: Unable to resolve host "example.supabase.co": No address associated with hostname',
      ),
    ),
    true,
  );
  assert.equal(isDnsResolutionFailure(new Error('The request timed out.')), false);
  assert.equal(isDnsResolutionFailure(new Error('Network request failed')), false);
  assert.equal(isDnsResolutionFailure(null), false);
});

function makeQueueEntry(overrides: Partial<LocalPendingBookmark>): LocalPendingBookmark {
  return {
    local_id: 'local-1',
    remote_id: null,
    operation: 'create',
    payload: {},
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

test('isTransientSyncFailure treats a DNS failure as transient too', () => {
  assert.equal(
    isTransientSyncFailure(
      makeQueueEntry({ sync_status: 'failed', last_error_kind: 'transient_dns' }),
    ),
    true,
  );
  assert.equal(
    isTransientSyncFailure(
      makeQueueEntry({ sync_status: 'failed', last_error_kind: 'transient_network' }),
    ),
    true,
  );
  assert.equal(
    isTransientSyncFailure(makeQueueEntry({ sync_status: 'failed', last_error_kind: 'other' })),
    false,
  );
});

test('hasRepeatedDnsFailures requires the DNS failure to have already earned its own health escalation', () => {
  const notYetEscalated = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      retry_count: 2,
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(notYetEscalated), false);

  const escalated = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      retry_count: 6,
      health_escalated_at: '2026-08-28T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(escalated), true);

  const escalatedButRecovered = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'synced',
      last_error_kind: 'transient_dns',
      health_escalated_at: '2026-08-28T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(escalatedButRecovered), false);

  const escalatedButWrongKind = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'other',
      health_escalated_at: '2026-08-28T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(escalatedButWrongKind), false);
});

test('a single failed bulk-create request does not count until it has actually earned escalation (review finding)', () => {
  // syncCreateQueueEntryBatch's one rejected call stamps the SAME
  // last_error_kind onto every entry in the attempted chunk and every later,
  // unattempted entry in the same import — one real network failure, not N —
  // but none of them have crossed their own retry threshold yet.
  const oneBulkFailure = [
    makeQueueEntry({ local_id: 'a', sync_status: 'failed', last_error_kind: 'transient_dns' }),
    makeQueueEntry({ local_id: 'b', sync_status: 'failed', last_error_kind: 'transient_dns' }),
    makeQueueEntry({ local_id: 'c', sync_status: 'failed', last_error_kind: 'transient_dns' }),
  ];
  assert.equal(hasRepeatedDnsFailures(oneBulkFailure), false);

  // Once ANY of them (a single stuck entry is enough) has genuinely retried
  // past the threshold and durably earned its escalation marker, it counts —
  // no second independent entry is required.
  const oneEntryFinallyEscalated = oneBulkFailure.map((entry) =>
    entry.local_id === 'a'
      ? { ...entry, retry_count: 6, health_escalated_at: '2026-08-28T00:00:00.000Z' }
      : entry,
  );
  assert.equal(hasRepeatedDnsFailures(oneEntryFinallyEscalated), true);
});
