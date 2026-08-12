import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStorageDiagnostics, noteSqliteQueueDepth, noteSqliteTailWait } from './diagnostics.ts';

test('getStorageDiagnostics is undefined until something is recorded', () => {
  assert.equal(getStorageDiagnostics(), undefined);
});

test('noteSqliteTailWait tracks running max wait/depth and a running count', () => {
  noteSqliteTailWait(300, 2);
  noteSqliteTailWait(1200, 5);
  noteSqliteTailWait(400, 3);

  const diagnostics = getStorageDiagnostics();
  assert.ok(diagnostics?.sqliteContention);
  assert.equal(diagnostics!.sqliteContention!.maxWaitMs, 1200);
  assert.equal(diagnostics!.sqliteContention!.maxDepth, 5);
  assert.equal(diagnostics!.sqliteContention!.waitCount, 3);
});

test('noteSqliteQueueDepth updates maxDepth without touching maxWaitMs/waitCount', () => {
  noteSqliteTailWait(1200, 5);
  const before = getStorageDiagnostics()!.sqliteContention!;

  noteSqliteQueueDepth(before.maxDepth + 4);
  const after = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(after.maxDepth, before.maxDepth + 4);
  assert.equal(after.maxWaitMs, before.maxWaitMs); // unchanged
  assert.equal(after.waitCount, before.waitCount); // unchanged

  // A lower depth than already observed must not regress the running max.
  noteSqliteQueueDepth(1);
  assert.equal(getStorageDiagnostics()!.sqliteContention!.maxDepth, after.maxDepth);
});

test('noteSqliteQueueDepth does not bump updatedAt when it does not advance the max', async () => {
  noteSqliteQueueDepth(20);
  const before = getStorageDiagnostics()!.sqliteContention!;

  await new Promise((resolve) => setTimeout(resolve, 5));
  noteSqliteQueueDepth(1); // well below the current max — must be a true no-op
  const after = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(after.updatedAt, before.updatedAt);
});

test('noteSqliteTailWait bumps waitCount but not updatedAt when neither maximum advances', async () => {
  noteSqliteTailWait(10_000, 5); // sets a severe maximum
  const severe = getStorageDiagnostics()!.sqliteContention!;

  await new Promise((resolve) => setTimeout(resolve, 5));
  // A routine wait long after, below both existing maxima — must count
  // toward waitCount but not make the old severe max look contemporaneous.
  noteSqliteTailWait(300, 2);
  const after = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(after.maxWaitMs, severe.maxWaitMs);
  assert.equal(after.maxDepth, severe.maxDepth);
  assert.equal(after.waitCount, severe.waitCount + 1);
  assert.equal(after.updatedAt, severe.updatedAt);
});

test('noteSqliteTailWait records the labels queued at the new depth max, not a later non-advancing wait', () => {
  const before = getStorageDiagnostics()!.sqliteContention!;
  // A depth well past anything accumulated so far guarantees this call
  // advances the running max regardless of state left by earlier tests.
  const severeDepth = before.maxDepth + 100;
  noteSqliteTailWait(1, severeDepth, 'replaceBookmark:20, getBookmark:1, pull:2');
  const advanced = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(advanced.maxDepth, severeDepth);
  assert.equal(advanced.maxDepthLabels, 'replaceBookmark:20, getBookmark:1, pull:2');

  // A later wait that doesn't advance either maximum must not overwrite the
  // labels recorded for the severe one.
  noteSqliteTailWait(1, 1, 'getMeta:3');
  const after = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(after.maxDepthLabels, 'replaceBookmark:20, getBookmark:1, pull:2');
});

test('noteSqliteQueueDepth records labels only when it advances the max', () => {
  const before = getStorageDiagnostics()!.sqliteContention!;
  const severeDepth = before.maxDepth + 100;
  noteSqliteQueueDepth(severeDepth, 'insertImportBatch:5');
  noteSqliteQueueDepth(1, 'getMeta:1'); // below the max — must not overwrite labels

  const diagnostics = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(diagnostics.maxDepth, severeDepth);
  assert.equal(diagnostics.maxDepthLabels, 'insertImportBatch:5');
});

test('a wait-only advance (STASH-64) must not overwrite the depth-driven max labels', () => {
  const before = getStorageDiagnostics()!.sqliteContention!;
  // Establish a severe depth max with its own labels, via a low wait so the
  // next call can advance maxWaitMs without also advancing maxDepth.
  const severeDepth = before.maxDepth + 100;
  noteSqliteTailWait(1, severeDepth, 'replaceTagData:20, setMeta:2');
  const depthMax = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(depthMax.maxDepthLabels, 'replaceTagData:20, setMeta:2');

  // A much slower wait, but at a shallow depth — a single long-running op,
  // not a queue pile-up. Before the fix this clobbered maxDepthLabels with
  // this shallow queue's contents even though depth never advanced.
  noteSqliteTailWait(depthMax.maxWaitMs + 5000, 2, 'replaceTagData:1, setMeta:1');
  const after = getStorageDiagnostics()!.sqliteContention!;
  assert.equal(after.maxDepth, severeDepth);
  assert.equal(after.maxDepthLabels, 'replaceTagData:20, setMeta:2');
  assert.equal(after.maxWaitLabels, 'replaceTagData:1, setMeta:1');
});
