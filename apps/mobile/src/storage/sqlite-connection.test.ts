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

/**
 * A fake handle backed by a shared key-value `store` (modelling one DB file
 * across reopens), with transaction semantics and a controllable COMMIT-point
 * death: the first COMMIT durably applies its writes, then invalidates the
 * handle and throws — the exact "commit landed but the promise rejected" case.
 */
class FakeKvDb {
  closed = false;
  private alive = true;
  private failCommitOnce: boolean;

  constructor(
    readonly id: number,
    private readonly store: Map<string, string>,
    opts: { failCommitOnce?: boolean } = {},
  ) {
    this.failCommitOnce = opts.failCommitOnce ?? false;
  }

  async probe(): Promise<void> {
    if (!this.alive) {
      throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    await task();
    // COMMIT point.
    if (this.failCommitOnce) {
      this.failCommitOnce = false;
      // Writes above have durably landed in `store`, but the handle dies and the
      // COMMIT promise rejects — replay must still converge.
      this.alive = false;
      throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
    }
  }
}

function makeConnection(opts?: {
  probeTimeoutMs?: number;
  closeTimeoutMs?: number;
  workTimeoutMs?: number;
  reopenAlertThreshold?: number;
}) {
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

test('run keys off liveness, not the error message: an NPE-shaped error on a live handle is not retried', async () => {
  // Proves the retry decision is `isAlive`, not string-matching the message —
  // a prepareAsync-NPE-looking error from a *live* handle is a real error.
  const { connection, opensCount } = makeConnection();
  let attempts = 0;
  await assert.rejects(
    () =>
      connection.run(async () => {
        attempts += 1;
        throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
      }),
    /NullPointerException/,
  );
  assert.equal(attempts, 1);
  assert.equal(opensCount(), 1);
});

test('run replays a transaction idempotently after a COMMIT-point death', async () => {
  // The worst case for replay: the first attempt's writes durably land, then the
  // handle dies and the COMMIT promise rejects with the NPE. The replay must
  // converge to the same state (this models replaceBookmark: DELETE old id +
  // INSERT OR REPLACE new id inside a transaction).
  const store = new Map<string, string>();
  store.set('local-1', 'payload');
  let opens = 0;
  const connection = new SqliteConnection<FakeKvDb>(
    async () => {
      opens += 1;
      return new FakeKvDb(opens, store, { failCommitOnce: opens === 1 });
    },
    (db) => db.probe(),
    (db) => db.close(),
  );

  await connection.run((db) =>
    db.withTransactionAsync(async () => {
      await db.del('local-1');
      await db.put('remote-1', 'payload');
    }),
  );

  assert.equal(opens, 2); // first handle died at COMMIT, replayed on a fresh one
  assert.equal(store.has('local-1'), false); // old id removed exactly once
  assert.equal(store.get('remote-1'), 'payload'); // new id present exactly once
  assert.equal(store.size, 1); // no duplication despite the durable first commit
});

test('a second consecutive death surfaces and is recorded, not retried again', async () => {
  clearLogEntries();
  const { connection } = makeConnection();
  const first = await connection.get();
  first.kill();

  // Work kills whatever handle it runs on, so the reopen's replacement dies too.
  await assert.rejects(
    () =>
      connection.run(async (db) => {
        db.kill();
        throw new Error('NativeDatabase.prepareAsync ... NullPointerException');
      }),
    /NullPointerException/,
  );

  // Single retry only — the second death is logged rather than retried forever.
  assert.ok(getLogEntries().some((e) => e.message.includes('after reopen retry')));
});

test('run serializes operations — they never overlap', async () => {
  const { connection } = makeConnection();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];

  const op = (n: number) =>
    connection.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // Yield a few times so overlap would be observable if it existed.
      await Promise.resolve();
      await Promise.resolve();
      order.push(n);
      active -= 1;
    });

  await Promise.all([op(1), op(2), op(3), op(4)]);
  assert.equal(maxActive, 1); // never more than one in flight
  assert.deepEqual(order, [1, 2, 3, 4]); // FIFO, matching submission order
});

test('closeCurrent releases the handle and the next op reopens', async () => {
  const { connection, opened, opensCount } = makeConnection();
  const first = await connection.run(async (db) => db.id);
  assert.equal(first, 1);
  assert.equal(opensCount(), 1);

  // Simulate AppState backgrounding: proactively close the live handle.
  await connection.closeCurrent();
  assert.equal(opened[0].closed, true);

  // Next operation reopens lazily on a fresh handle.
  const second = await connection.run(async (db) => db.id);
  assert.equal(second, 2);
  assert.equal(opensCount(), 2);
});

test('closeCurrent is a no-op when there is no open handle', async () => {
  const { connection, opensCount } = makeConnection();
  await connection.closeCurrent(); // nothing open yet
  assert.equal(opensCount(), 0);
});

test('closeCurrent does not close the handle out from under an in-flight op', async () => {
  const { connection, opened } = makeConnection();
  await connection.get(); // open handle 1

  let opSawClosed = false;
  const op = connection.run(async (db) => {
    // closeCurrent is queued while this op runs; it must wait, not close db now.
    await Promise.resolve();
    opSawClosed = (db as { closed: boolean }).closed;
  });
  const closing = connection.closeCurrent();
  await Promise.all([op, closing]);

  assert.equal(opSawClosed, false); // the op completed on a live handle
  assert.equal(opened[0].closed, true); // then it was closed
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

test('a wedged operation is bounded, reported, and recovered on a fresh handle', async () => {
  clearLogEntries();
  const { connection, opened, opensCount } = makeConnection({
    workTimeoutMs: 20,
    probeTimeoutMs: 50,
    closeTimeoutMs: 50,
  });
  await connection.get(); // handle 1

  let attempts = 0;
  const result = await connection.run(async (db) => {
    attempts += 1;
    if (attempts === 1) {
      // The native op wedges — never settles. The watchdog must not let it
      // stall the tail forever.
      return new Promise<string>(() => {});
    }
    return `ok:${db.id}`;
  });

  assert.equal(attempts, 2);
  assert.equal(result, 'ok:2'); // recovered on a reopened handle
  assert.equal(opensCount(), 2);
  assert.equal(opened[0].closed, true); // the wedged handle was dropped
  // The stall is reported at error level so it reaches crash monitoring.
  assert.ok(getLogEntries().some((e) => e.level === 'error' && e.message.includes('stalled after')));
});

test('a wedged operation does not probe the hung handle before reopening', async () => {
  // The recovery must treat a stall as dead without probing — a probe on a
  // wedged handle would itself hang (only to be bounded), doubling the wait.
  let probes = 0;
  let opens = 0;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      return new FakeDb(opens);
    },
    (db) => {
      probes += 1;
      return db.probe();
    },
    (db) => db.close(),
    { workTimeoutMs: 20, probeTimeoutMs: 50, closeTimeoutMs: 50 },
  );

  let attempts = 0;
  await connection.run(async (db) => {
    attempts += 1;
    if (attempts === 1) {
      return new Promise<void>(() => {}); // wedge
    }
    return undefined;
  });

  assert.equal(attempts, 2);
  assert.equal(opens, 2);
  // No liveness probe was run to decide the stall was fatal — the timeout is
  // proof enough. (Probes here come only from get()'s reuse path, which doesn't
  // run on a first open or a freshly reopened handle.)
  assert.equal(probes, 0);
});

test('a back-to-back wedge surfaces after a single retry, not forever', async () => {
  clearLogEntries();
  const { connection } = makeConnection({
    workTimeoutMs: 20,
    probeTimeoutMs: 50,
    closeTimeoutMs: 50,
  });

  await assert.rejects(
    () => connection.run(() => new Promise<void>(() => {})), // wedges on every handle
    (error: Error) => error.name === 'SqliteTimeoutError',
  );
  // Reported on each stall, and the second-failure path is recorded too.
  assert.ok(getLogEntries().some((e) => e.message.includes('after reopen retry')));
});

test('frequent reopens escalate to a tracked error past the threshold', async () => {
  clearLogEntries();
  const { connection, opensCount } = makeConnection({ reopenAlertThreshold: 3 });

  // Kill the handle before each call so every get() reopens.
  for (let i = 0; i < 4; i += 1) {
    const db = await connection.get();
    db.kill();
  }
  // 4 opens total = the initial open + 3 reopens, hitting the threshold.
  assert.equal(opensCount(), 4);

  const reopenBreadcrumbs = getLogEntries().filter((e) => e.message.includes('connection reopened (reopen #'));
  assert.equal(reopenBreadcrumbs.length, 3); // one info breadcrumb per reopen

  const escalations = getLogEntries().filter(
    (e) => e.level === 'error' && e.message.includes('excessive handle churn'),
  );
  assert.equal(escalations.length, 1); // fires exactly once, when it crosses
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
