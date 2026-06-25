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

  isAlive(): boolean {
    return this.alive;
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

function makeConnection(opts?: { probeTimeoutMs?: number; closeTimeoutMs?: number }) {
  let opens = 0;
  const opened: FakeDb[] = [];
  const events: string[] = [];
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      events.push(`open:${opens}`);
      const db = new FakeDb(opens);
      opened.push(db);
      return db;
    },
    (db) => db.probe(),
    async (db) => {
      events.push(`close:${db.id}`);
      await db.close();
    },
    opts,
  );
  return { connection, opened, events, opensCount: () => opens };
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
  const { connection, opened, events, opensCount } = makeConnection();

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
  // The stale handle is closed (evicting it from expo-sqlite's per-path native
  // cache) *before* the replacement is opened — otherwise the reopen could
  // reuse the still-cached invalid handle. Order must be close:1 then open:2.
  assert.deepEqual(events, ['open:1', 'close:1', 'open:2']);
  // The fresh handle is live and not clobbered by a late probe rejection.
  assert.equal((await connection.get()).id, fresh.id);

  // The stale handle was reported once, not once per concurrent caller.
  const staleLogs = getLogEntries().filter((e) => e.message.includes('handle stale, reopening'));
  assert.equal(staleLogs.length, 1);
});

test('reopens exactly once when the handle dies between calls', async () => {
  const { connection, opensCount } = makeConnection();
  const a = await connection.get();
  a.kill();
  const b = await connection.get();
  assert.notEqual(b.id, a.id);
  assert.equal(opensCount(), 2);
  // b is still live — a later call must not open yet another connection.
  const c = await connection.get();
  assert.equal(c.id, b.id);
  assert.equal(opensCount(), 2);
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

test('run returns the work result on a live handle', async () => {
  const { connection, opensCount } = makeConnection();
  const result = await connection.run(async (db) => `value:${db.id}`);
  assert.equal(result, 'value:1');
  assert.equal(opensCount(), 1);
});

test('run reopens and retries once when the handle dies mid-operation', async () => {
  // The probe in get() passes, then the handle is invalidated in the window
  // before the real statement — exactly the field NPE. run must recover.
  const { connection, opened, opensCount } = makeConnection();
  await connection.get(); // establish handle 1

  let attempts = 0;
  const result = await connection.run(async (db) => {
    attempts += 1;
    if (attempts === 1) {
      // Handle dies just as the statement begins.
      db.kill();
      throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
    }
    return `ok:${db.id}`;
  });

  assert.equal(attempts, 2);
  assert.equal(result, 'ok:2'); // replayed on the fresh handle
  assert.equal(opensCount(), 2);
  assert.equal(opened[0].closed, true); // dead handle evicted
});

test('run does not retry a genuine error on a live handle', async () => {
  const { connection, opensCount } = makeConnection();
  let attempts = 0;
  await assert.rejects(
    () =>
      connection.run(async () => {
        attempts += 1;
        throw new Error('UNIQUE constraint failed: bookmarks.id');
      }),
    /UNIQUE constraint/,
  );
  // The handle is alive, so the error is real — work ran exactly once.
  assert.equal(attempts, 1);
  assert.equal(opensCount(), 1);
});

test('a close that never resolves does not deadlock the reopen', async () => {
  let opens = 0;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      return new FakeDb(opens);
    },
    (db) => db.probe(),
    () => new Promise<void>(() => {}), // never resolves — wedged close
    { closeTimeoutMs: 10, probeTimeoutMs: 50 },
  );

  const first = await connection.get();
  first.kill();
  // Must fall through the bounded close and reopen rather than hang forever.
  const second = await connection.get();
  assert.equal(second.id, 2);
  assert.equal(opens, 2);
});

test('a probe that hangs is treated as stale and reopened', async () => {
  let opens = 0;
  let hang = false;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      return new FakeDb(opens);
    },
    (db) =>
      hang ? new Promise(() => {}) : db.probe(), // first reuse probe hangs
    (db) => db.close(),
    { probeTimeoutMs: 10, closeTimeoutMs: 10 },
  );

  await connection.get(); // handle 1
  hang = true; // the next liveness probe will hang
  const second = await connection.get();
  assert.equal(second.id, 2); // timed-out probe → treated as dead → reopened
  assert.equal(opens, 2);
});
