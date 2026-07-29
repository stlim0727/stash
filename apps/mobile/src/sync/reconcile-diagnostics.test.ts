import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getReconcileDiagnostics,
  recordReconcileChunk,
  resetReconcileDiagnostics,
} from './reconcile-diagnostics.ts';

test('getReconcileDiagnostics returns undefined before any chunk is recorded', () => {
  resetReconcileDiagnostics();
  assert.equal(getReconcileDiagnostics(), undefined);
});

test('recordReconcileChunk accumulates counts and reason tallies across calls', () => {
  resetReconcileDiagnostics();
  recordReconcileChunk(50, 12, { metadata_status: 12, site_name: 3 });
  recordReconcileChunk(50, 5, { metadata_status: 5, title: 1 });

  const snapshot = getReconcileDiagnostics();
  assert.ok(snapshot);
  assert.equal(snapshot!.chunksProcessed, 2);
  assert.equal(snapshot!.entriesCompleted, 100);
  assert.equal(snapshot!.entriesReconciled, 17);
  assert.deepEqual(snapshot!.reasonTally, { metadata_status: 17, site_name: 3, title: 1 });
});

test('getReconcileDiagnostics returns a fresh copy each call (no shared mutable reference)', () => {
  resetReconcileDiagnostics();
  recordReconcileChunk(1, 1, { title: 1 });
  const first = getReconcileDiagnostics()!;
  first.reasonTally.title = 999;
  const second = getReconcileDiagnostics()!;
  assert.equal(second.reasonTally.title, 1);
});
