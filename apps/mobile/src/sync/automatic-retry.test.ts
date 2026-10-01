import assert from 'node:assert/strict';
import test from 'node:test';
import { nextAutomaticSyncRetryAt } from '@/sync/automatic-retry';
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
