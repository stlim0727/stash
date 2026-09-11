import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getSyncStatusDiagnostics,
  noteSyncEntryStatus,
  resetSyncStatusDiagnostics,
} from './sync-status-diagnostics.ts';

test('getSyncStatusDiagnostics returns undefined before anything is recorded', () => {
  resetSyncStatusDiagnostics();
  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('a bookmark that syncs cleanly (no failed status ever seen) counts as syncedWithoutFailure', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'synced');

  const snapshot = getSyncStatusDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.syncedWithoutFailure, 1);
  assert.deepEqual(snapshot!.syncedAfterFailureByKind, {});
});

test('a bookmark that fails then syncs counts under syncedAfterFailureByKind, not syncedWithoutFailure (Sentry STASH-69)', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'transient_network');
  noteSyncEntryStatus('local-1', 'synced');

  const snapshot = getSyncStatusDiagnostics();
  assert.ok(snapshot);
  assert.deepEqual(snapshot!.syncedAfterFailureByKind, { transient_network: 1 });
  assert.equal(snapshot!.syncedWithoutFailure, 0);
});

test('a missing error kind is tallied as unknown rather than dropped', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed');
  noteSyncEntryStatus('local-1', 'synced');

  assert.deepEqual(getSyncStatusDiagnostics()!.syncedAfterFailureByKind, { unknown: 1 });
});

test('repeated failed calls for the same entry (retries) keep the FIRST failure timestamp/kind, not the latest', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'transient_network');
  // A later retry surfaces a different kind — the episode should still be
  // attributed to the kind that first made this bookmark look failed.
  noteSyncEntryStatus('local-1', 'failed', 'transient_dns');
  noteSyncEntryStatus('local-1', 'synced');

  assert.deepEqual(getSyncStatusDiagnostics()!.syncedAfterFailureByKind, {
    transient_network: 1,
  });
});

test('maxFailureToSyncedMs tracks the longest observed failure-to-synced span', async () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'transient_network');
  await new Promise((resolve) => setTimeout(resolve, 20));
  noteSyncEntryStatus('local-1', 'synced');

  const firstSpan = getSyncStatusDiagnostics()!.maxFailureToSyncedMs;
  assert.ok(firstSpan >= 20);

  // A later, much shorter episode must not shrink the recorded maximum.
  noteSyncEntryStatus('local-2', 'failed', 'transient_network');
  noteSyncEntryStatus('local-2', 'synced');

  assert.equal(getSyncStatusDiagnostics()!.maxFailureToSyncedMs, firstSpan);
});

test('independent bookmarks are tracked separately — one failing does not taint another syncing cleanly', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'transient_network');
  noteSyncEntryStatus('local-2', 'synced');
  noteSyncEntryStatus('local-1', 'synced');

  const snapshot = getSyncStatusDiagnostics()!;
  assert.equal(snapshot.syncedWithoutFailure, 1);
  assert.deepEqual(snapshot.syncedAfterFailureByKind, { transient_network: 1 });
});

test('a status other than failed/synced (e.g. the transient "syncing" set before an attempt) is a no-op', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'syncing');
  noteSyncEntryStatus('local-1', 'pending');

  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('a synced entry that never appeared as failed multiple times just tallies each independently', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'synced');
  noteSyncEntryStatus('local-2', 'synced');
  noteSyncEntryStatus('local-3', 'synced');

  assert.equal(getSyncStatusDiagnostics()!.syncedWithoutFailure, 3);
});
