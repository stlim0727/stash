import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clearLogEntries, getLogEntries } from '@/observability/log-buffer';
import { getStorageDiagnostics } from '@/storage/diagnostics';
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
  reopenAlertWindowMs?: number;
  now?: () => number;
  registerForegroundState?: (handler: {
    onBackground?: () => void;
    onForeground?: () => void;
  }) => () => void;
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

test('queue depth is recorded eagerly at enqueue time, even before a blocking op settles', async () => {
  // STASH-3Y diagnostics regression test: a report filed *during* an active
  // stall must still show contention — depth can't wait for the blocking
  // op to finish, since everything queued behind it never gets that far
  // while it's stuck (see noteSqliteQueueDepth).
  const { connection } = makeConnection();
  let releaseFirst!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = connection.run(async () => {
    await blocker;
  });
  const second = connection.run(async () => undefined);
  const third = connection.run(async () => undefined);

  // Neither second nor third has started (first still holds the tail), yet
  // the depth must already be visible.
  const diagnosticsSnapshot = getStorageDiagnostics();
  assert.ok(diagnosticsSnapshot?.sqliteContention);
  assert.ok(diagnosticsSnapshot!.sqliteContention!.maxDepth >= 3);

  releaseFirst();
  await Promise.all([first, second, third]);
});

test('a wait spanning a background/foreground transition is excluded from maxWaitMs (long or short)', async () => {
  // A duration-based cutoff can't tell a genuine long stall apart from a
  // short background blip — both just look like "a long wait" by elapsed
  // time. The fix keys off actual transitions instead, so this must exclude
  // the wait regardless of how long it turns out to be. Fake clock (matching
  // this file's existing pattern) so the wait exceeds the log threshold
  // without a real delay.
  let handlers: { onBackground?: () => void; onForeground?: () => void } = {};
  let clock = 0;
  const { connection } = makeConnection({
    now: () => (clock += 300),
    registerForegroundState: (h) => {
      handlers = h;
      return () => {};
    },
  });

  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const first = connection.run(async () => {
    await blocker;
  });
  // Queued behind the blocker — its wait will span the transition below.
  const second = connection.run(async () => undefined);

  handlers.onBackground?.();
  handlers.onForeground?.();

  releaseBlocker();
  await Promise.all([first, second]);

  // Both ops were enqueued (and their waits measured) around the same
  // transition — neither should have landed in the cumulative diagnostic.
  const diagnosticsSnapshot = getStorageDiagnostics();
  assert.equal(diagnosticsSnapshot?.sqliteContention?.waitCount ?? 0, 0);
});

test('a wait with no background/foreground transition is still recorded normally', async () => {
  let clock = 0;
  const { connection } = makeConnection({
    now: () => (clock += 300),
    registerForegroundState: () => () => {}, // registered but never fired
  });

  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const first = connection.run(async () => {
    await blocker;
  });
  const second = connection.run(async () => undefined);

  releaseBlocker();
  await Promise.all([first, second]);

  const diagnosticsSnapshot = getStorageDiagnostics();
  assert.ok((diagnosticsSnapshot?.sqliteContention?.waitCount ?? 0) >= 1);
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

test('a stalled operation is reported but left to finish on the same handle (never aborted/replayed)', async () => {
  clearLogEntries();
  const { connection, opened, opensCount } = makeConnection({ workTimeoutMs: 10 });
  await connection.get(); // handle 1

  // A slow op that has not settled by the watchdog deadline. The watchdog must
  // report it but must NOT close/reopen/replay — replaying a still-running write
  // on a fresh connection would let the original land later and corrupt order.
  let resolveWork: () => void = () => {};
  let ran = 0;
  const runPromise = connection.run((db) => {
    ran += 1;
    return new Promise<string>((res) => {
      resolveWork = () => res(`done:${db.id}`);
    });
  });

  // Wait past the watchdog so its report fires while the op is still in flight.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(
    getLogEntries().some((e) => e.level === 'error' && e.message.includes('still running after')),
    'the stall is reported at error level',
  );
  assert.equal(opensCount(), 1); // no reopen while the op is merely slow
  assert.equal(opened[0].closed, false); // the live handle was not closed out from under it

  // The op finally completes — on the original handle, run exactly once, no replay.
  resolveWork();
  assert.equal(await runPromise, 'done:1');
  assert.equal(ran, 1);
  assert.equal(opensCount(), 1);
});

test('frequent reopens escalate to a tracked error past the threshold', async () => {
  clearLogEntries();
  // Reopens 100ms apart with a 1s window → all 3 fall inside one window and
  // cross the threshold (the thrash/wedge signature).
  let clock = 0;
  const { connection, opensCount } = makeConnection({
    reopenAlertThreshold: 3,
    reopenAlertWindowMs: 1000,
    now: () => (clock += 100),
  });

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

test('reopens spread beyond the window do NOT escalate (benign lifecycle, STASH-C)', async () => {
  clearLogEntries();
  // Each reopen lands 5s apart with a 1s window, so no two ever coincide — the
  // count within the window never exceeds 1, well under the threshold. This is
  // the normal background/foreground pattern that used to trip the alert.
  let clock = 0;
  const { connection, opensCount } = makeConnection({
    reopenAlertThreshold: 3,
    reopenAlertWindowMs: 1000,
    now: () => (clock += 5000),
  });

  for (let i = 0; i < 6; i += 1) {
    const db = await connection.get();
    db.kill();
  }
  assert.equal(opensCount(), 6); // initial open + 5 reopens

  const reopenBreadcrumbs = getLogEntries().filter((e) => e.message.includes('connection reopened (reopen #'));
  assert.equal(reopenBreadcrumbs.length, 5); // every reopen still leaves a breadcrumb

  const escalations = getLogEntries().filter(
    (e) => e.level === 'error' && e.message.includes('excessive handle churn'),
  );
  assert.equal(escalations.length, 0); // spread out → never escalates
});

test('reopens after proactive background close stay breadcrumbs even when clustered', async () => {
  clearLogEntries();
  // Opening external links can background/foreground the app several times in a
  // minute. Those reopens are expected because AppState called closeCurrent().
  let clock = 0;
  const { connection, opensCount } = makeConnection({
    reopenAlertThreshold: 3,
    reopenAlertWindowMs: 1000,
    now: () => (clock += 100),
  });

  await connection.run(async (db) => db.id); // initial open
  for (let i = 0; i < 5; i += 1) {
    await connection.closeCurrent();
    await connection.run(async (db) => db.id);
  }
  assert.equal(opensCount(), 6); // initial open + 5 lifecycle reopens

  const reopenBreadcrumbs = getLogEntries().filter((e) => e.message.includes('connection reopened (reopen #'));
  assert.equal(reopenBreadcrumbs.length, 5);
  assert.ok(
    reopenBreadcrumbs.every((e) => e.message.includes('expected after background close')),
  );

  const escalations = getLogEntries().filter(
    (e) => e.level === 'error' && e.message.includes('excessive handle churn'),
  );
  assert.equal(escalations.length, 0);
});

test('reopens after failed proactive close still count as churn', async () => {
  clearLogEntries();
  let clock = 0;
  let opens = 0;
  const connection = new SqliteConnection<FakeDb>(
    async () => {
      opens += 1;
      return new FakeDb(opens);
    },
    (db) => db.probe(),
    () => new Promise<void>(() => {}), // close times out; not a clean lifecycle release
    {
      closeTimeoutMs: 1,
      reopenAlertThreshold: 3,
      reopenAlertWindowMs: 1000,
      now: () => (clock += 100),
    },
  );

  await connection.run(async (db) => db.id); // initial open
  for (let i = 0; i < 3; i += 1) {
    await connection.closeCurrent();
    await connection.run(async (db) => db.id);
  }
  assert.equal(opens, 4); // initial open + 3 reopens after failed closes

  const reopenBreadcrumbs = getLogEntries().filter((e) => e.message.includes('connection reopened (reopen #'));
  assert.equal(reopenBreadcrumbs.length, 3);
  assert.ok(
    reopenBreadcrumbs.every((e) => !e.message.includes('expected after background close')),
  );

  const escalations = getLogEntries().filter(
    (e) => e.level === 'error' && e.message.includes('excessive handle churn'),
  );
  assert.equal(escalations.length, 1);
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

// --- Abandoned native ops (Sentry STASH-J / STASH-3W / STASH-3Z) -------------
// A probe or close that blows its timeout has NOT finished — we merely stopped
// waiting for it. Closing the handle then destroys the sqlite3 mutex while a
// statement still holds it, which is the fatal `pthread_mutex_lock` under
// `exsqlite3_finalize` / `NativeStatementBinding::getColumnNames`.

/** A connection whose probe hangs on demand, recording opens and closes. */
function makeHangingProbeConnection(options: { probeTimeoutMs: number }) {
  const events: string[] = [];
  const opens: Array<{ id: number; useNewConnection: boolean }> = [];
  let opened = 0;
  let releaseProbe: (() => void) | null = null;
  let hangNextProbe = false;

  const connection = new SqliteConnection<{ id: number }>(
    async ({ useNewConnection }) => {
      opened += 1;
      opens.push({ id: opened, useNewConnection });
      events.push(`open:${opened}:new=${useNewConnection}`);
      return { id: opened };
    },
    async (db) => {
      if (!hangNextProbe) throw new Error('stale handle');
      hangNextProbe = false;
      events.push(`probe-hang:${db.id}`);
      // Still running natively long after the timeout fires.
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
    },
    async (db) => {
      events.push(`close:${db.id}`);
    },
    { probeTimeoutMs: options.probeTimeoutMs, closeTimeoutMs: 10 },
  );

  return {
    connection,
    events,
    opens,
    hangProbe: () => {
      hangNextProbe = true;
    },
    releaseProbe: () => releaseProbe?.(),
  };
}

test('a timed-out probe never closes the handle underneath its running statement', async () => {
  const h = makeHangingProbeConnection({ probeTimeoutMs: 10 });

  const first = await h.connection.get();
  assert.equal(first.id, 1);

  h.hangProbe();
  const second = await h.connection.get();

  // The reopen happened, but handle 1 was NOT closed — its probe is still live.
  assert.equal(second.id, 2);
  assert.ok(
    !h.events.includes('close:1'),
    `handle 1 must not be closed while its probe runs; events: ${h.events.join(', ')}`,
  );
  // expo-sqlite caches one connection per path, so the reopen has to ask for a
  // fresh one or it lands right back on the connection being torn down.
  assert.deepEqual(h.opens[1], { id: 2, useNewConnection: true });
});

test('the deferred close runs once the abandoned probe finally settles', async () => {
  const h = makeHangingProbeConnection({ probeTimeoutMs: 10 });
  await h.connection.get();
  h.hangProbe();
  await h.connection.get();
  assert.ok(!h.events.includes('close:1'));

  h.releaseProbe();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(
    h.events.includes('close:1'),
    `handle 1 must be closed after its probe settles; events: ${h.events.join(', ')}`,
  );
});

test('an ordinary probe rejection still closes immediately and reuses the cached connection', async () => {
  const h = makeHangingProbeConnection({ probeTimeoutMs: 1000 });
  await h.connection.get();

  // No hangProbe(): the probe rejects fast, so nothing is left in flight and the
  // pre-existing evict-then-reopen behaviour must be untouched.
  const second = await h.connection.get();

  assert.equal(second.id, 2);
  assert.ok(h.events.includes('close:1'));
  assert.deepEqual(h.opens[1], { id: 2, useNewConnection: false });
});

test('a wedged close forces the reopen onto a new native connection', async () => {
  const opens: boolean[] = [];
  let opened = 0;
  const connection = new SqliteConnection<FakeDb>(
    async ({ useNewConnection }) => {
      opened += 1;
      opens.push(useNewConnection);
      return new FakeDb(opened);
    },
    (db) => db.probe(),
    () => new Promise<void>(() => {}), // never resolves — wedged close
    { closeTimeoutMs: 10, probeTimeoutMs: 50 },
  );

  const first = await connection.get();
  first.kill();
  const second = await connection.get();

  assert.equal(second.id, 2);
  // The close is still in flight and will free that connection when it lands;
  // reopening onto the cached one would be the use-after-free.
  assert.deepEqual(opens, [false, true]);
});
