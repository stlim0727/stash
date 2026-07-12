import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureSqliteDirectory } from '@/storage/sqlite-directory';

test('ensureSqliteDirectory returns when the directory can be created idempotently', () => {
  const calls: string[] = [];

  ensureSqliteDirectory({
    createDirectory: () => {
      calls.push('create');
    },
    pathIsNonDirectory: () => {
      calls.push('exists');
      return false;
    },
    deleteFile: () => {
      calls.push('delete');
    },
  });

  assert.deepEqual(calls, ['exists', 'create']);
});

test('ensureSqliteDirectory deletes a file blocking the SQLite directory then retries', () => {
  const calls: string[] = [];
  const logs: string[] = [];
  let pathIsNonDirectory = true;

  ensureSqliteDirectory({
    createDirectory: () => {
      calls.push('create');
    },
    pathIsNonDirectory: () => {
      calls.push('exists');
      return pathIsNonDirectory;
    },
    deleteFile: () => {
      calls.push('delete');
      pathIsNonDirectory = false;
    },
    log: (level, message) => {
      logs.push(`${level}:${message}`);
    },
  });

  assert.deepEqual(calls, ['exists', 'delete', 'create']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^warn:sqlite directory path was a file/);
});

test('ensureSqliteDirectory rethrows unrelated create failures without deleting', () => {
  const calls: string[] = [];

  assert.throws(
    () =>
      ensureSqliteDirectory({
        createDirectory: () => {
          calls.push('create');
          throw new Error('permission denied');
        },
        pathIsNonDirectory: () => {
          calls.push('exists');
          return false;
        },
        deleteFile: () => {
          calls.push('delete');
        },
      }),
    /permission denied/,
  );

  assert.deepEqual(calls, ['exists', 'create']);
});
