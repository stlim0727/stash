import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSyncDisplay, buildLibrarySyncFlow, INITIAL_SYNC_DISPLAY, nextSyncDisplayAt, type LibrarySyncFlow } from '@/domain/library-sync-status';
import type { LocalPendingBookmark } from './types';

const working: LibrarySyncFlow = { phase: 'working', remaining: 2 };
const retrying: LibrarySyncFlow = { phase: 'retrying', remaining: 1 };
const idle: LibrarySyncFlow = { phase: 'idle', remaining: 0 };
const entry = (patch: Partial<LocalPendingBookmark> = {}): LocalPendingBookmark => ({
  local_id: 'a', remote_id: null, operation: 'create', payload: {}, sync_status: 'pending',
  retry_count: 0, last_error: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...patch,
});
const input = { authStatus: 'authenticated', paused: false, offline: false, syncing: false, queue: [] as LocalPendingBookmark[] };

test('short bursts stay hidden; a visible multi-item run completes once and holds its place', () => {
  let state = advanceSyncDisplay(INITIAL_SYNC_DISPLAY, working, 0);
  assert.equal(nextSyncDisplayAt(state, working), 1500);
  assert.equal(advanceSyncDisplay(state, idle, 500).phase, 'hidden');
  state = advanceSyncDisplay(state, working, 1500);
  assert.equal(state.phase, 'syncing');
  state = advanceSyncDisplay(state, { phase: 'working', remaining: 1 }, 2000);
  assert.equal(state.phase, 'syncing');
  state = advanceSyncDisplay(state, idle, 2500);
  assert.equal(state.phase, 'complete');
  assert.equal(advanceSyncDisplay(state, idle, 4999).phase, 'complete');
  assert.equal(advanceSyncDisplay(state, idle, 5000).phase, 'hidden');
});

test('new work replaces completion immediately; brief inter-pass gaps do not hide the status', () => {
  let state = advanceSyncDisplay(INITIAL_SYNC_DISPLAY, working, 0);
  state = advanceSyncDisplay(state, working, 1500);
  state = advanceSyncDisplay(state, idle, 2000);
  state = advanceSyncDisplay(state, working, 2050);
  assert.equal(state.phase, 'syncing');
  assert.equal(state.completeUntil, null);
  state = advanceSyncDisplay(state, retrying, 3000);
  assert.equal(state.phase, 'syncing');
  state = advanceSyncDisplay(state, retrying, 17050);
  assert.equal(state.phase, 'delayed');
  assert.equal(advanceSyncDisplay(state, working, 17100).phase, 'syncing');
});

test('fresh transient failures stay quiet until prolonged, and retries cannot produce completion', () => {
  let state = advanceSyncDisplay(INITIAL_SYNC_DISPLAY, retrying, 0);
  assert.equal(nextSyncDisplayAt(state, retrying), 15000);
  state = advanceSyncDisplay(state, retrying, 14999);
  assert.equal(state.phase, 'hidden');
  state = advanceSyncDisplay(state, retrying, 15000);
  assert.equal(state.phase, 'delayed');
  assert.equal(advanceSyncDisplay(state, retrying, 100000).phase, 'delayed');
  // Defensive against a bad caller that says idle while work remains.
  assert.notEqual(advanceSyncDisplay(state, { phase: 'idle', remaining: 1 }, 100001).phase, 'complete');
});

test('offline, pause and sign-in override every display timer without delayed completion leaks', () => {
  for (const phase of ['offline', 'paused', 'sign_in', 'permission', 'attention'] as const) {
    for (const prior of [INITIAL_SYNC_DISPLAY,
      { phase: 'complete' as const, busySince: null, completeUntil: 99999 },
      { phase: 'syncing' as const, busySince: 0, completeUntil: null }]) {
      const state = advanceSyncDisplay(prior, { phase, remaining: 1 }, 2000);
      assert.equal(state.phase, phase);
      assert.equal(state.completeUntil, null);
      assert.equal(advanceSyncDisplay(state, idle, 2001).phase, 'hidden');
    }
  }
});

test('all cloud channels, including confirmed tag tombstones and restore failures, prevent completion', () => {
  assert.deepEqual(buildLibrarySyncFlow(input), idle);
  for (const extra of [
    { queue: [entry({ operation: 'delete' })] },
    { tagOps: [{ confirmed: true }] },
    { importCollections: [{ status: 'pending' as const }] },
    { enrichmentRestores: [{ status: 'pending' as const }] },
  ]) assert.deepEqual(buildLibrarySyncFlow({ ...input, ...extra }), { phase: 'working', remaining: 1 });
  assert.deepEqual(buildLibrarySyncFlow({ ...input, enrichmentRestores: [{ status: 'failed' }] }), retrying);
  assert.equal(buildLibrarySyncFlow({ ...input, importCollections: [{ status: 'failed', last_error_kind: 'permission' }] }).phase, 'permission');
  assert.equal(buildLibrarySyncFlow({ ...input, enrichmentRestores: [{ status: 'failed', last_error_kind: 'auth' }] }).phase, 'sign_in');
  assert.deepEqual(buildLibrarySyncFlow({ ...input, runFailure: { kind: 'transient_network' } }), { phase: 'retrying', remaining: 0 });
});

test('request provenance determines action; transient errors never become terminal from retry count alone', () => {
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'transient_dns', retry_count: 100 })] }).phase, 'retrying');
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'retryable_http', retry_count: 100 })] }).phase, 'retrying');
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'other', retry_count: 1 })] }).phase, 'retrying');
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'other', retry_count: 3 })] }).phase, 'attention');
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'permission' })] }).phase, 'permission');
  assert.equal(buildLibrarySyncFlow({ ...input, queue: [entry({ sync_status: 'failed', last_error_kind: 'auth' })], offline: true }).phase, 'sign_in');
  assert.equal(buildLibrarySyncFlow({ ...input, authStatus: 'session_expired', paused: true }).phase, 'sign_in');
  assert.equal(buildLibrarySyncFlow({ ...input, tagOps: [{ retry_count: 3 }] }).phase, 'attention');
  assert.equal(buildLibrarySyncFlow({ ...input, paused: true, offline: true }).phase, 'paused');
});


test('permanently unsyncable entries do not claim an automatic retry or block completion', () => {
  const excluded = entry({ sync_status: 'failed', retry_count: 1 });
  assert.deepEqual(buildLibrarySyncFlow({ ...input, queue: [excluded], permanentlyUnsyncableIds: new Set(['a']) }), idle);
  assert.deepEqual(buildLibrarySyncFlow({ ...input, queue: [excluded, entry({ local_id: 'b' })], permanentlyUnsyncableIds: new Set(['a']) }), { phase: 'working', remaining: 1 });
});


test('provider errors with failed pulls are actionable even when every outbox is empty', () => {
  assert.equal(buildLibrarySyncFlow({ ...input, authStatus: 'error', runFailure: { kind: 'transient_network', attempts: 1 } }).phase, 'sign_in');
  assert.equal(buildLibrarySyncFlow({ ...input, authStatus: 'error' }).phase, 'idle');
});
