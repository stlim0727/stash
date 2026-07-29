import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getReconcileDiagnostics,
  recordBulkChunkStarted,
  recordCreateCompleted,
  recordReconcileNeeded,
  resetReconcileDiagnostics,
} from './reconcile-diagnostics.ts';

test('getReconcileDiagnostics returns undefined before anything is recorded', () => {
  resetReconcileDiagnostics();
  assert.equal(getReconcileDiagnostics(), undefined);
});

test('recordBulkChunkStarted counts a chunk and its entries, reconcile tracked separately per entry', () => {
  resetReconcileDiagnostics();
  recordBulkChunkStarted(50);
  recordReconcileNeeded({ metadata_status: 1, site_name: 1 });
  recordReconcileNeeded({ metadata_status: 1 });
  recordBulkChunkStarted(50);
  recordReconcileNeeded({ metadata_status: 1, title: 1 });

  const snapshot = getReconcileDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.chunksProcessed, 2);
  assert.equal(snapshot!.entriesCompleted, 100);
  assert.equal(snapshot!.entriesReconciled, 3);
  assert.deepEqual(snapshot!.reasonTally, { metadata_status: 3, site_name: 1, title: 1 });
});

test('recordBulkChunkStarted counts every entry the chunk started with, even if every one is later skipped by downstream branching', () => {
  // This is the whole point: a chunk where every result hits an early
  // `continue` (deleted-mid-flight etc.) must still count as completed —
  // recordBulkChunkStarted is called with results.length before any of
  // that branching runs, not derived from what survives it.
  resetReconcileDiagnostics();
  recordBulkChunkStarted(12);
  const snapshot = getReconcileDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.entriesCompleted, 12);
  assert.equal(snapshot!.entriesReconciled, 0);
});

test('recordCreateCompleted counts entries without counting as a bulk chunk', () => {
  resetReconcileDiagnostics();
  recordCreateCompleted();
  recordCreateCompleted();
  recordReconcileNeeded({ site_name: 1 });

  const snapshot = getReconcileDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.chunksProcessed, 0);
  assert.equal(snapshot!.entriesCompleted, 2);
  assert.equal(snapshot!.entriesReconciled, 1);
  assert.deepEqual(snapshot!.reasonTally, { site_name: 1 });
});

test('a pristine single create (no reconcile needed) still counts toward entriesCompleted', () => {
  resetReconcileDiagnostics();
  recordCreateCompleted();
  const snapshot = getReconcileDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.entriesCompleted, 1);
  assert.equal(snapshot!.entriesReconciled, 0);
});

test('recordReconcileNeeded can be recorded independently of recordCreateCompleted (the whole point: completion is knowable before reconcile-need is)', () => {
  resetReconcileDiagnostics();
  recordCreateCompleted(); // completion known immediately
  // ... later, once determined, separately:
  recordReconcileNeeded({ title: 1 });

  const snapshot = getReconcileDiagnostics()!;
  assert.equal(snapshot.entriesCompleted, 1);
  assert.equal(snapshot.entriesReconciled, 1);
});

test('getReconcileDiagnostics returns a fresh copy each call (no shared mutable reference)', () => {
  resetReconcileDiagnostics();
  recordBulkChunkStarted(1);
  recordReconcileNeeded({ title: 1 });
  const first = getReconcileDiagnostics()!;
  first.reasonTally.title = 999;
  const second = getReconcileDiagnostics()!;
  assert.equal(second.reasonTally.title, 1);
});

test('updatedAt reflects the last recorded event, not when the snapshot was read', async () => {
  resetReconcileDiagnostics();
  recordBulkChunkStarted(1);
  const recordedAt = getReconcileDiagnostics()!.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Reading again well after the event must not bump the timestamp.
  const readLater = getReconcileDiagnostics()!.updatedAt;
  assert.equal(readLater, recordedAt);
});
