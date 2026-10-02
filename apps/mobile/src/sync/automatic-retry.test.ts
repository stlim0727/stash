import assert from 'node:assert/strict';
import test from 'node:test';
import { isFollowupReady, isPullReady, nextAutomaticSyncRetryAt } from '@/sync/automatic-retry';
import type { LocalPendingBookmark } from '@/domain/types';
const failed = (patch: Partial<LocalPendingBookmark> = {}): LocalPendingBookmark => ({
  local_id: 'a', remote_id: 'a', operation: 'update', payload: {}, sync_status: 'failed',
  retry_count: 1, last_error: 'Failed', last_error_kind: 'other', created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z', last_attempt_at: '2026-10-01T00:00:00Z', ...patch,
});
const now = Date.parse('2026-10-01T00:00:00Z');
const input = { queue: [] as LocalPendingBookmark[], runFailure: null, now };

test('retries use the existing upload backoff, network multiplier, and earliest eligible deadline', () => {
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed()] }), now + 5000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed({ last_error_kind: 'transient_dns' })] }), now + 15000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed({ retry_count: 2 }), failed()] }), now + 5000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed({ retry_count: 100, last_error_kind: 'transient_network' })] }), now + 900000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed({ retry_count: 100, last_error_kind: 'retryable_http' })] }), now + 300000);
});

test('login, permission, exhausted ordinary attempts and permanent exclusions do not auto-retry', () => {
  for (const entry of [failed({ last_error_kind: 'auth' }), failed({ last_error_kind: 'permission' }),
    failed({ retry_count: 3 }), failed({ last_error: 'index row size exceeds btree version 4 maximum' }),
    failed({ sync_status: 'synced' })]) {
    assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [entry] }), null);
  }
});

test('pull failures and legacy followup outboxes have bounded quiet retries', () => {
  assert.equal(nextAutomaticSyncRetryAt({ ...input, runFailure: { kind: 'transient_network', at: now, attempts: 2 } }), now + 45000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, followups: [{ status: 'failed' }] }), now + 30000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, followups: [{ status: 'failed', last_error_kind: 'permission' }] }), null);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, followups: [{ status: 'failed', last_error_kind: 'transient_network', retry_count: 2, last_attempt_at: new Date(now).toISOString() }] }), now + 45000);
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed({ retry_count: 0, last_attempt_at: undefined })] }), now + 5000);
  assert.equal(nextAutomaticSyncRetryAt(input), null);
});


test('each followup enforces its own kind and deadline while manual force can recover it', () => {
  const at = new Date(now).toISOString();
  const early = { status: 'failed' as const, retry_count: 1, last_error_kind: 'retryable_http' as const, last_attempt_at: at };
  const later = { ...early, retry_count: 2 };
  assert.equal(isFollowupReady(early, now + 5000, now), true);
  assert.equal(isFollowupReady(later, now + 5000, now), false);
  assert.equal(isFollowupReady(later, now + 15000, now), true);
  for (const blocked of [{ ...early, last_error_kind: 'auth' as const }, { ...early, last_error_kind: 'permission' as const }, { ...early, last_error_kind: 'other' as const, retry_count: 3 }]) {
    assert.equal(isFollowupReady(blocked, now + 900000, now), false);
    assert.equal(isFollowupReady(blocked, now, now, true), true);
  }
  assert.equal(isFollowupReady({ status: 'failed' }, now + 29999, now), false);
  assert.equal(isFollowupReady({ status: 'failed' }, now + 30000, now), true);
  assert.equal(isFollowupReady({ status: 'pending' }, now, now), true);
});


test("pull readiness is independent from another channel's earlier deadline", () => {
  const failure = { kind: 'transient_network' as const, at: now, attempts: 1 };
  assert.equal(nextAutomaticSyncRetryAt({ ...input, queue: [failed()], runFailure: failure }), now + 5000);
  assert.equal(isPullReady(failure, now + 5000), false);
  assert.equal(isPullReady(failure, now + 15000), true);
  assert.equal(isPullReady(failure, now, true), true);
  for (const blocked of [{ ...failure, kind: 'auth' as const }, { ...failure, kind: 'permission' as const }, { ...failure, kind: 'other' as const, attempts: 3 }]) {
    assert.equal(isPullReady(blocked, now + 900000), false);
    assert.equal(isPullReady(blocked, now, true), true);
  }
});

test('legacy queue retry deadlines retain a stable hydration anchor across renders', () => {
  const queue = [failed({ last_attempt_at: undefined })];
  for (const elapsed of [0, 1000, 6000, 30000]) {
    assert.equal(nextAutomaticSyncRetryAt({ ...input, queue, now: now + elapsed, legacyQueueAttemptAt: now }), now + 5000);
  }
});
