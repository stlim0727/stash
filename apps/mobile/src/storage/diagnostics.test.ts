import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStorageDiagnostics, noteSqliteTailWait } from './diagnostics.ts';

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
