import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearLogEntries, getLogEntries } from '@/observability/log-buffer';
import { SqliteConnection } from '@/storage/sqlite-connection';

/** A fake native handle whose liveness is controllable. */
class FakeDb {
  closed = false;
  constructor(
    readonly id: number,
    private alive: boolean = true,
  ) {}

  kill(): void {
    this.alive = false;
  }

  async probe(): Promise<void> {
    if (!this.alive) {
      throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeConnection() {
  let opens = 0;
  const opened: FakeDb[] = [];
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      const db = new FakeDb(opens);
      opened.push(db);
      return db;
    },
    (db) => db.probe(),
    (db) => db.close(),
  );
  return { connection, opened, opensCount: () => opens };
}

test('opens lazily and reuses a live handle', async () => {
  const { connection, opensCount } = makeConnection();
  const a = await connection.get();
  const b = await connection.get();
  assert.equal(a, b);
  assert.equal(opensCount(), 1);
});

test('coalesces a cold-start burst onto a single open', async () => {
  const { connection, opened, opensCount } = makeConnection();
  const handles = await Promise.all(Array.from({ length: 12 }, () => connection.get()));
  // Every concurrent caller gets the same handle from one open call.
  assert.equal(opensCount(), 1);
  for (const h of handles) {
    assert.equal(h, opened[0]);
  }
});

test('a stale handle is reopened once and closed, never double-opened', async () => {
  clearLogEntries();
  const { connection, opened, opensCount } = makeConnection();

  const first = await connection.get();
  assert.equal(opensCount(), 1);

  // Simulate the OS invalidating the handle while backgrounded.
  first.kill();

  // A whole burst of operations hit the dead handle at once (the exact race
  // that previously leaked competing connections and wedged the DB).
  const handles = await Promise.all(Array.from({ length: 12 }, () => connection.get()));

  // Exactly one reopen, and everyone converges on the same fresh handle.
  assert.equal(opensCount(), 2);
  const fresh = opened[1];
  for (const h of handles) {
    assert.equal(h, fresh);
  }
  // The dead handle was closed, not leaked.
  assert.equal(first.closed, true);
  // The fresh handle is live and not clobbered by a late probe rejection.
  assert.equal((await connection.get()).id, fresh.id);

  // The stale handle was reported once, not once per concurrent caller.
  const staleLogs = getLogEntries().filter((e) => e.message.includes('handle stale, reopening'));
  assert.equal(staleLogs.length, 1);
});

test('surfaces and retries a failed open', async () => {
  clearLogEntries();
  let attempts = 0;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('disk full');
      }
      return new FakeDb(attempts);
    },
    (db) => db.probe(),
    (db) => db.close(),
  );

  await assert.rejects(() => connection.get(), /disk full/);
  // The failure is recorded for the diagnostics buffer...
  assert.ok(getLogEntries().some((e) => e.message.includes('sqlite open failed')));
  // ...and a later call retries rather than caching the rejection.
  const db = await connection.get();
  assert.equal(db.id, 2);
});

test('a reopen failure does not poison later retries', async () => {
  let attempts = 0;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      attempts += 1;
      // Second open (the reopen) fails; third succeeds.
      if (attempts === 2) {
        throw new Error('transient open failure');
      }
      return new FakeDb(attempts);
    },
    (db) => db.probe(),
    (db) => db.close(),
  );

  const first = await connection.get();
  first.kill();

  await assert.rejects(() => connection.get(), /transient open failure/);
  // A subsequent call starts a fresh attempt and recovers.
  const recovered = await connection.get();
  assert.equal(recovered.id, 3);
});
