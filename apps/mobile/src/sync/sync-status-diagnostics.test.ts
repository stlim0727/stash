import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  excludeFromSyncStatusDiagnostics,
  getSyncStatusDiagnostics,
  noteSyncEntryStatus,
  remapSyncStatusIdentity,
  resetSyncStatusDiagnostics,
} from './sync-status-diagnostics.ts';

test('getSyncStatusDiagnostics returns undefined before anything is recorded', () => {
  resetSyncStatusDiagnostics();
  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('a bookmark that syncs cleanly (no failed status ever seen) counts as syncedWithoutFailure', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'synced', 'create');

  const snapshot = getSyncStatusDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.syncedWithoutFailure, 1);
  assert.deepEqual(snapshot!.syncedAfterFailureByKind, {});
});

test('a bookmark that fails then syncs counts under syncedAfterFailureByKind, not syncedWithoutFailure (Sentry STASH-69)', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('local-1', 'synced', 'create');

  const snapshot = getSyncStatusDiagnostics();
  assert.ok(snapshot);
  assert.deepEqual(snapshot!.syncedAfterFailureByKind, { transient_network: 1 });
  assert.equal(snapshot!.syncedWithoutFailure, 0);
});

test('a missing error kind is tallied as unknown rather than dropped', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create');
  noteSyncEntryStatus('local-1', 'synced', 'create');

  assert.deepEqual(getSyncStatusDiagnostics()!.syncedAfterFailureByKind, { unknown: 1 });
});

test('repeated failed calls for the same entry (retries) keep the FIRST failure timestamp/kind, not the latest', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  // A later retry surfaces a different kind — the episode should still be
  // attributed to the kind that first made this bookmark look failed.
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_dns');
  noteSyncEntryStatus('local-1', 'synced', 'create');

  assert.deepEqual(getSyncStatusDiagnostics()!.syncedAfterFailureByKind, {
    transient_network: 1,
  });
});

test('maxFailureToSyncedMs tracks the longest observed failure-to-synced span', async () => {
  // A loose lower bound (> 0, not >= a fixed ms count) — a CI runner's clock
  // resolution/jitter made a fixed-threshold assertion here flaky (the delay
  // is real wall-clock time via setTimeout, but exactly how much elapses is
  // not guaranteed down to the millisecond on a loaded shared runner).
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  await new Promise((resolve) => setTimeout(resolve, 20));
  noteSyncEntryStatus('local-1', 'synced', 'create');

  const firstSpan = getSyncStatusDiagnostics()!.maxFailureToSyncedMs;
  assert.ok(firstSpan > 0);

  // A later, near-instant (no delay) episode must not shrink the recorded
  // maximum — this is the actual invariant under test, independent of
  // firstSpan's exact magnitude.
  noteSyncEntryStatus('local-2', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('local-2', 'synced', 'create');

  assert.equal(getSyncStatusDiagnostics()!.maxFailureToSyncedMs, firstSpan);
});

test('independent bookmarks are tracked separately — one failing does not taint another syncing cleanly', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('local-2', 'synced', 'create');
  noteSyncEntryStatus('local-1', 'synced', 'create');

  const snapshot = getSyncStatusDiagnostics()!;
  assert.equal(snapshot.syncedWithoutFailure, 1);
  assert.deepEqual(snapshot.syncedAfterFailureByKind, { transient_network: 1 });
});

test('a status other than failed/synced (e.g. the transient "syncing" set before an attempt) is a no-op', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'syncing', 'create');
  noteSyncEntryStatus('local-1', 'pending', 'create');

  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('a synced entry that never appeared as failed multiple times just tallies each independently', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'synced', 'create');
  noteSyncEntryStatus('local-2', 'synced', 'create');
  noteSyncEntryStatus('local-3', 'synced', 'create');

  assert.equal(getSyncStatusDiagnostics()!.syncedWithoutFailure, 3);
});

test('update/delete operations are ignored entirely — only create is evidence for "saved bookmarks" (Codex review on #765)', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'update', 'transient_network');
  noteSyncEntryStatus('local-1', 'synced', 'update');
  noteSyncEntryStatus('local-2', 'failed', 'delete', 'transient_network');
  noteSyncEntryStatus('local-2', 'synced', 'delete');

  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('remapSyncStatusIdentity moves an in-flight failure episode to the new id (account rehoming, Codex review on #765)', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('old-local-1', 'failed', 'create', 'transient_network');

  remapSyncStatusIdentity(new Map([['old-local-1', 'new-local-1']]));

  // The old id no longer has an open episode...
  noteSyncEntryStatus('old-local-1', 'synced', 'create');
  assert.equal(getSyncStatusDiagnostics()!.syncedWithoutFailure, 1);

  // ...but the new id's eventual success correctly closes the moved episode
  // instead of being miscounted as a clean sync.
  noteSyncEntryStatus('new-local-1', 'synced', 'create');
  const snapshot = getSyncStatusDiagnostics()!;
  assert.deepEqual(snapshot.syncedAfterFailureByKind, { transient_network: 1 });
  assert.equal(snapshot.syncedWithoutFailure, 1);
});

test('remapSyncStatusIdentity is a no-op for an id with no in-flight episode', () => {
  resetSyncStatusDiagnostics();
  remapSyncStatusIdentity(new Map([['no-such-id', 'new-id']]));
  noteSyncEntryStatus('new-id', 'synced', 'create');

  assert.equal(getSyncStatusDiagnostics()!.syncedWithoutFailure, 1);
});

test('a failure-only session (nothing has synced yet) still produces a snapshot with activeFailures set (Codex review on #765)', () => {
  // The case this exists for: a report filed during a total outage, where
  // every create has failed and none has ever succeeded. Before this fix,
  // getSyncStatusDiagnostics() returned undefined here — making the whole
  // diagnostic look unpopulated instead of showing the exact "always fails"
  // pattern STASH-69 describes.
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');

  const snapshot = getSyncStatusDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.activeFailures, 1);
  assert.equal(snapshot!.syncedWithoutFailure, 0);
  assert.deepEqual(snapshot!.syncedAfterFailureByKind, {});
});

test('activeFailures reflects only currently-unresolved episodes, live off the in-flight map', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('local-2', 'failed', 'create', 'transient_network');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 2);

  noteSyncEntryStatus('local-1', 'synced', 'create');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 1);

  noteSyncEntryStatus('local-2', 'synced', 'create');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 0);
});

test('excludeFromSyncStatusDiagnostics silently ignores an id — account rehome creates are not "saved bookmarks" (Codex review on #765)', () => {
  // account-transition.ts mints operation:'create' entries to re-home an
  // entire already-synced library onto a new account id; none of that is a
  // new user save, so it must never feed this diagnostic even though it
  // will report as a normal 'create' sync outcome.
  resetSyncStatusDiagnostics();
  excludeFromSyncStatusDiagnostics(['rehomed-1', 'rehomed-2']);

  noteSyncEntryStatus('rehomed-1', 'synced', 'create');
  noteSyncEntryStatus('rehomed-2', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('rehomed-2', 'synced', 'create');

  assert.equal(getSyncStatusDiagnostics(), undefined);
});

test('excludeFromSyncStatusDiagnostics also clears an already-open episode for that id', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 1);

  excludeFromSyncStatusDiagnostics(['local-1']);
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 0);

  // Its eventual sync is now silently ignored too — neither recovered-from-
  // failure nor a clean sync, since it was never real evidence to begin with.
  noteSyncEntryStatus('local-1', 'synced', 'create');
  const snapshot = getSyncStatusDiagnostics()!;
  assert.equal(snapshot.syncedWithoutFailure, 0);
  assert.deepEqual(snapshot.syncedAfterFailureByKind, {});
});

test('updatedAt refreshes on a repeated failure for an already-open episode (Codex review on #765)', async () => {
  // A retry that keeps failing is fresh evidence too, even though the
  // episode's own failedAt/errorKind deliberately don't reset — a report
  // filed right after that retry must not look hours-stale.
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  const firstUpdatedAt = getSyncStatusDiagnostics()!.updatedAt;

  await new Promise((resolve) => setTimeout(resolve, 5));
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_dns');
  const secondUpdatedAt = getSyncStatusDiagnostics()!.updatedAt;

  assert.notEqual(secondUpdatedAt, firstUpdatedAt);
});

test('getSyncStatusDiagnostics prunes a failure episode whose local_id is no longer in the live queue (discarded bookmark, Codex review on #765)', () => {
  // A permanent delete, an emptied Trash, or a library reset removes the
  // queue entry without ever calling noteSyncEntryStatus('synced'/excluded)
  // for it — this is the general-purpose cleanup for all of those, rather
  // than hooking into every call site that can discard queued create work.
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  noteSyncEntryStatus('local-2', 'failed', 'create', 'transient_network');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 2);

  // local-1's bookmark was discarded — only local-2 remains in the queue.
  assert.equal(
    getSyncStatusDiagnostics(new Set(['local-2']))!.activeFailures,
    1,
  );

  // The prune is durable, not just filtered on read — a later call without
  // a live set still reflects it, and local-2's eventual sync still closes
  // correctly (it was never pruned).
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 1);
  noteSyncEntryStatus('local-2', 'synced', 'create');
  assert.deepEqual(getSyncStatusDiagnostics()!.syncedAfterFailureByKind, {
    transient_network: 1,
  });
});

test('getSyncStatusDiagnostics without a live set reflects the raw in-flight map (test-isolation default)', () => {
  resetSyncStatusDiagnostics();
  noteSyncEntryStatus('local-1', 'failed', 'create', 'transient_network');
  assert.equal(getSyncStatusDiagnostics()!.activeFailures, 1);
});
