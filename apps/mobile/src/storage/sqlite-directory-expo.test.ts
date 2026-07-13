import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createExpoSqliteDirectoryAdapter,
  ensureExpoSqliteDirectory,
} from '@/storage/sqlite-directory-expo';
import { ensureSqliteDirectory } from '@/storage/sqlite-directory';

test('createExpoSqliteDirectoryAdapter returns null when the Expo file API is missing', () => {
  const logs: string[] = [];

  const adapter = createExpoSqliteDirectoryAdapter({}, 'SQLite', (level, message) => {
    logs.push(`${level}:${message}`);
  });

  assert.equal(adapter, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^warn:sqlite directory preflight unavailable/);
});

test('createExpoSqliteDirectoryAdapter deletes a blocking file then creates the directory', () => {
  const calls: string[] = [];

  class Directory {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    create(options: { intermediates?: boolean; idempotent?: boolean }) {
      calls.push(`create:${this.name}:${String(options.intermediates)}`);
    }
  }

  class File {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    get exists() {
      calls.push(`exists:${this.name}`);
      return true;
    }

    delete() {
      calls.push(`delete:${this.name}`);
    }
  }

  const adapter = createExpoSqliteDirectoryAdapter(
    { Directory, File, Paths: { document: 'document-root' } },
    'SQLite',
  );

  assert.notEqual(adapter, null);
  ensureSqliteDirectory(adapter!);
  assert.deepEqual(calls, ['exists:SQLite', 'delete:SQLite', 'create:SQLite:true']);
});

test('createExpoSqliteDirectoryAdapter tolerates a runtime without Directory.create', () => {
  const logs: string[] = [];

  class Directory {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}
  }

  class File {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    get exists() {
      return false;
    }
  }

  const adapter = createExpoSqliteDirectoryAdapter(
    { Directory, File, Paths: { document: 'document-root' } },
    'SQLite',
    (level, message) => {
      logs.push(`${level}:${message}`);
    },
  );

  assert.notEqual(adapter, null);
  assert.doesNotThrow(() => ensureSqliteDirectory(adapter!));
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^warn:sqlite directory create unavailable/);
});

test('ensureExpoSqliteDirectory logs and falls through when the preflight throws', () => {
  const logs: string[] = [];

  class Directory {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    create() {
      throw new TypeError('undefined is not a function');
    }
  }

  class File {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    get exists() {
      return false;
    }
  }

  assert.doesNotThrow(() =>
    ensureExpoSqliteDirectory(
      { Directory, File, Paths: { document: 'document-root' } },
      'SQLite',
      (level, message) => {
        logs.push(`${level}:${message}`);
      },
    ),
  );

  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /^warn:sqlite directory creation failed/);
  assert.match(
    logs[1]!,
    /^warn:sqlite directory preflight failed; falling back to sqlite open: TypeError: undefined is not a function/,
  );
});

test('ensureExpoSqliteDirectory still tolerates a runtime with a failing file check', () => {
  const logs: string[] = [];
  const calls: string[] = [];

  class Directory {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    create() {
      calls.push('create');
    }
  }

  class File {
    constructor(
      readonly root: unknown,
      readonly name: string,
    ) {}

    get exists() {
      throw new TypeError('undefined is not a function');
    }
  }

  assert.doesNotThrow(() =>
    ensureExpoSqliteDirectory(
      { Directory, File, Paths: { document: 'document-root' } },
      'SQLite',
      (level, message) => {
        logs.push(`${level}:${message}`);
      },
    ),
  );

  assert.deepEqual(calls, ['create']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^warn:sqlite directory file check unavailable/);
});
