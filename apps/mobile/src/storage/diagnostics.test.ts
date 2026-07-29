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
