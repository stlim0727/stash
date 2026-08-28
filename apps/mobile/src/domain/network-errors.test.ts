import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasRepeatedDnsFailures,
  isDnsResolutionFailure,
  isTransientNetworkError,
  isTransientSyncFailure,
  REPEATED_DNS_FAILURE_THRESHOLD,
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

test('hasRepeatedDnsFailures requires several independently-timed failures with the same DNS kind', () => {
  assert.equal(REPEATED_DNS_FAILURE_THRESHOLD, 2);

  const oneDnsFailure = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-28T00:00:00.000Z',
    }),
    makeQueueEntry({
      local_id: 'b',
      sync_status: 'failed',
      last_error_kind: 'other',
      last_attempt_at: '2026-08-28T00:01:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(oneDnsFailure), false);

  const twoDnsFailures = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-28T00:00:00.000Z',
    }),
    makeQueueEntry({
      local_id: 'b',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-21T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(twoDnsFailures), true);

  const oneRecovered = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'synced',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-28T00:00:00.000Z',
    }),
    makeQueueEntry({
      local_id: 'b',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-21T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(oneRecovered), false);
});

test('a single failed bulk-create request does not count as repeated (review finding)', () => {
  // syncCreateQueueEntryBatch's one rejected call stamps the SAME
  // last_attempt_at onto every entry in the attempted chunk, and the SAME
  // last_error_kind (with no last_attempt_at bump) onto every later,
  // unattempted entry in the same import — one real network failure, not N.
  const sameAttempt = '2026-08-28T00:00:00.000Z';
  const oneBulkFailure = [
    makeQueueEntry({
      local_id: 'a',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: sameAttempt,
    }),
    makeQueueEntry({
      local_id: 'b',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: sameAttempt,
    }),
    makeQueueEntry({
      local_id: 'c',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: null,
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(oneBulkFailure), false);

  const twoBulkFailures = [
    ...oneBulkFailure,
    makeQueueEntry({
      local_id: 'd',
      sync_status: 'failed',
      last_error_kind: 'transient_dns',
      last_attempt_at: '2026-08-21T00:00:00.000Z',
    }),
  ];
  assert.equal(hasRepeatedDnsFailures(twoBulkFailures), true);
});
