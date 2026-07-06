import { recordLog } from '@/observability/log-buffer';

export interface SqliteConnectionOptions {
  /** Max time a liveness probe may run before the handle is treated as dead. */
  probeTimeoutMs?: number;
  /** Max time to wait for a stale handle to close before reopening anyway. */
  closeTimeoutMs?: number;
  /**
   * Max time a single unit of DB work may run before the stall is *reported*.
   * Unlike the probe/close bounds this does **not** abort or replay the op
   * (JS can't cancel an in-flight promise, and replaying a merely-slow write on
   * a reopened connection would corrupt the actor's ordering) — it only records
   * an `error` so a wedged handle, which otherwise stalls the whole
   * serialization tail silently, becomes visible in monitoring.
   */
  workTimeoutMs?: number;
  /**
   * How many reopens *within `reopenAlertWindowMs`* before the churn is
   * escalated from a local-buffer breadcrumb to a tracked error (one per
   * session). Frequent reopens are the leading indicator of the Android
   * background-handle thrash that wedges the DB, so we want it visible in
   * monitoring before it bites.
   */
  reopenAlertThreshold?: number;
  /**
   * Rolling window over which `reopenAlertThreshold` reopens count as churn.
   * Only *clustered* reopens are the thrash/wedge signature; benign lifecycle
   * reopens (one per background/foreground) spread across a long session must
   * not escalate, or the alert is pure noise (STASH-C).
   */
  reopenAlertWindowMs?: number;
  /** Clock for reopen-cadence tracking; injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;
// Generous on purpose: a single statement on this tiny local DB is sub-millisecond,
// so a multi-second stall is unambiguously a wedged handle, not a slow query —
// the bound exists to catch a hang, not to police latency.
const DEFAULT_WORK_TIMEOUT_MS = 5000;
const DEFAULT_REOPEN_ALERT_THRESHOLD = 5;
// 5 reopens inside a minute is unambiguous thrash; the same 5 spread across a
// long session is normal background/foreground lifecycle and must stay silent.
const DEFAULT_REOPEN_ALERT_WINDOW_MS = 60_000;
// Only record a tail wait past this bound. A healthy op on this tiny local DB
// starts near-instantly, so anything above this is head-of-line blocking worth
// a breadcrumb — while the steady state (fast, uncontended ops) stays silent.
const TAIL_WAIT_LOG_MS = 250;

/**
 * Coalesced, self-healing SQLite connection manager.
 *
 * Guarantees **a single live native connection** to the database file at any
 * time, even under the concurrent access a cold start produces (the startup
 * load's `Promise.all`, background saves, and the sync-queue drain all reach
 * for the DB at once).
 *
 * Why this exists: an Android handle is invalidated when the app is
 * backgrounded, so the next operation must reopen. The naive approach —
 * probe `this.db`, and on failure null it and reopen — races badly when several
 * callers probe the *same* stale handle at once: caller A reopens and installs
 * a fresh handle, then caller B's slower probe rejection nulls that fresh handle
 * and opens *another* connection. Two live connections to the same WAL file make
 * the native layer reject statements with
 * `NativeDatabase.prepareAsync ... NullPointerException`, and because every
 * reopen repeats the clobber it never recovers.
 *
 * The fix has several parts:
 *   1. All work runs through {@link run}, which serializes units onto a single
 *      tail (the "connection actor") so DB operations never overlap — the
 *      concurrent probe/reopen race becomes structurally impossible, not just
 *      coalesced.
 *   2. The liveness probe + reopen decision also funnels through one in-flight
 *      `opening` promise, so even direct {@link get} callers share one probe and
 *      at most one reopen per generation, and the stale handle is closed (not
 *      leaked).
 *   3. {@link run} retries the *operation*, not just the open: the probe can pass
 *      microseconds before the OS invalidates the handle, so the real statement
 *      still throws — `run` detects the now-dead handle and replays the work once
 *      on a fresh connection. A genuine SQL error (handle still alive) is never
 *      retried.
 *   4. The probe and close are time-bounded, so a wedged handle (the very case
 *      this targets) can't hang the probe or close forever and deadlock the
 *      tail. A long-running work unit is additionally *watched* and reported at
 *      `error` level — but never aborted or replayed, since that would break the
 *      actor ordering (see {@link runWork}); it only makes the stall observable.
 *   5. {@link closeCurrent} lets the app proactively release the handle when it
 *      backgrounds (the moment Android invalidates it), so the next operation
 *      reopens cleanly instead of first failing on a dead handle.
 *   6. Reopens are counted and, past a per-session threshold, escalated to a
 *      tracked error — frequent reopens are the leading indicator of the
 *      background-handle thrash that wedges the DB (see {@link noteReopen}).
 *
 * The auth store (`session-storage.native.ts`) drives its single connection the
 * same way.
 */
export class SqliteConnection<DB> {
  private db: DB | null = null;
  private opening: Promise<DB> | null = null;
  // Serialization tail (the "connection actor"). Every `run` and `closeCurrent`
  // chains onto this, so DB work executes strictly one unit at a time. The
  // concurrent probe/reopen race this class originally guarded against then
  // becomes structurally impossible rather than merely coalesced. The trade-off
  // is head-of-line blocking — acceptable here because each operation is a small,
  // fast statement on a tiny local DB (and SQLite serializes writes regardless).
  private tail: Promise<unknown> = Promise.resolve();
  // Number of units currently on the tail (queued + the one running). Reported
  // as a coarse depth when an op waits a non-trivial time, to make head-of-line
  // blocking visible.
  private pending = 0;
  // Wall-clock of the last reopen, for the inter-reopen cadence in noteReopen
  // (rapid reopens = thrash, not normal lifecycle).
  private lastReopenAt: number | null = null;
  // Timestamps of recent reopens, pruned to the alert window — the churn alert
  // fires on the count *within the window*, not lifetime reopens (STASH-C).
  private reopenTimes: number[] = [];
  // The churn error is one-per-session; latch it so a sustained thrash doesn't
  // re-fire on every reopen past the threshold.
  private reopenAlerted = false;
  // Count of successful opens this session. The first is the initial open; every
  // one after it is a reopen (a handle died or was proactively closed), which we
  // track as a freeze-risk signal (see noteReopen).
  private opens = 0;
  private readonly probeTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly workTimeoutMs: number;
  private readonly reopenAlertThreshold: number;
  private readonly reopenAlertWindowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly opener: () => Promise<DB>,
    /** Cheap liveness check; throws if the handle is stale/invalidated. */
    private readonly probe: (db: DB) => Promise<unknown>,
    /** Best-effort close of a handle being discarded. */
    private readonly close: (db: DB) => Promise<unknown>,
    options: SqliteConnectionOptions = {},
  ) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.workTimeoutMs = options.workTimeoutMs ?? DEFAULT_WORK_TIMEOUT_MS;
    this.reopenAlertThreshold = options.reopenAlertThreshold ?? DEFAULT_REOPEN_ALERT_THRESHOLD;
    this.reopenAlertWindowMs = options.reopenAlertWindowMs ?? DEFAULT_REOPEN_ALERT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Resolve to a live handle, reopening transparently if the current one died. */
  get(): Promise<DB> {
    if (!this.opening) {
      this.opening = this.resolve().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  /**
   * Run a unit of DB work with automatic recovery. If the handle dies *during*
   * the work — the probe in {@link get} can pass just before the OS invalidates
   * the handle, so the real statement still throws the `prepareAsync`
   * NullPointerException — the dead handle is dropped and the work is retried
   * exactly once on a fresh connection. A genuine failure (constraint, bad SQL),
   * where the handle is still alive, is surfaced immediately and never retried.
   *
   * The work callback MUST be idempotent under a full replay. Note the replay
   * can happen even when the first attempt's writes *did* land: the NPE is a
   * JS/native-binding failure, not proof the underlying COMMIT was rolled back,
   * so a transaction whose COMMIT durably succeeded but whose promise rejected
   * will be replayed. Every statement in the repository converges correctly
   * regardless: single `INSERT OR REPLACE` / `DELETE` / reads, and the two
   * transactions (`replaceBookmark` = DELETE + INSERT OR REPLACE, `replaceTagData`
   * = full overwrite) all reach the same state when re-run.
   *
   * The retry is deliberately single-shot: a back-to-back invalidation is not the
   * failure mode this targets, and a loop could spin. A second consecutive death
   * is surfaced (and recorded) rather than retried again.
   */
  run<T>(work: (db: DB) => Promise<T>): Promise<T> {
    return this.serialize(() => this.runOnce(work));
  }

  /**
   * Close and drop the active handle, then let the next {@link run} reopen
   * lazily. Wired to AppState so the app proactively releases the connection
   * when it backgrounds — Android invalidates native handles in the background,
   * and closing ahead of time means we rarely operate on an already-dead handle
   * instead of only recovering after the prepareAsync NPE. Serialized like every
   * other unit of work, so it never closes the handle out from under an
   * in-flight operation.
   */
  closeCurrent(): Promise<void> {
    return this.serialize(async () => {
      const db = this.db;
      if (db) {
        this.db = null;
        await this.closeQuietly(db);
      }
    });
  }

  /** Chain a task onto the serialization tail so units of work never overlap. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    // Measure head-of-line blocking: every unit waits behind whatever already
    // owns the tail, and a share→foreground reopen burst stacking here is the
    // prime freeze suspect (Sentry STASH-C/H). Record only a non-trivial wait so
    // the steady state stays silent; coarse numbers only, never bookmark content.
    this.pending += 1;
    const enqueuedAt = Date.now();
    const instrumented = () => {
      const waitMs = Date.now() - enqueuedAt;
      if (waitMs >= TAIL_WAIT_LOG_MS) {
        recordLog('info', `sqlite tail wait ${waitMs}ms (depth ${this.pending})`);
      }
      return task();
    };
    // Run after the current tail settles, regardless of its outcome; a prior
    // rejection must not break the chain for the next caller.
    const result = this.tail.then(instrumented, instrumented);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    // Release the depth slot once this unit settles (either outcome).
    const release = () => {
      this.pending -= 1;
    };
    result.then(release, release);
    return result;
  }

  private async runOnce<T>(work: (db: DB) => Promise<T>): Promise<T> {
    const first = await this.get();
    try {
      return await this.runWork(first, work);
    } catch (error) {
      // Retry only when the handle itself died; a still-live handle means the
      // error is real (constraint, bad SQL) and must not be replayed.
      if (await this.isAlive(first)) {
        throw error;
      }
      if (this.db === first) {
        this.db = null;
      }
      // Evict the dead handle before reopening (see closeQuietly / resolve).
      await this.closeQuietly(first);
    }
    const fresh = await this.get();
    try {
      return await this.runWork(fresh, work);
    } catch (error) {
      // The replacement handle also died (rapid background/foreground thrash).
      // Surface it — the first reopen is logged in resolve(), so without this
      // the second death would be silent behind the generic storage banner.
      recordLog('warn', `sqlite operation failed after reopen retry: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Run one unit of work under a **reporting-only** watchdog. A native op that
   * stalls past the bound is recorded at `error` level (so the wedge reaches
   * crash monitoring via the console bridge) but the operation is deliberately
   * **left to complete** — it is never aborted or replayed.
   *
   * This is load-bearing for the actor guarantee: JavaScript can't cancel an
   * in-flight promise, so reopening + replaying a merely-slow op (a large
   * import/pull write, or a call paused by app suspension) would let the
   * original `work(db)` finish *later* against a since-closed connection and
   * land a stale write after a newer edit. So the watchdog only observes; the
   * unit keeps owning the tail until it actually settles, and a genuinely dead
   * handle is still recovered by {@link runOnce}'s post-throw `isAlive` retry.
   * The report fires at most once per op (the tail is blocked meanwhile, so
   * there is nothing else to drown out).
   */
  private async runWork<T>(db: DB, work: (db: DB) => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      recordLog(
        'error',
        `sqlite operation still running after ${this.workTimeoutMs}ms — possible wedged handle (the connection actor is blocked until it settles; the op is left to finish, never aborted)`,
      );
    }, this.workTimeoutMs);
    try {
      return await work(db);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record a reopen as a freeze-risk signal. Each reopen is a low-severity
   *  breadcrumb in the local diagnostics buffer; once they cross the alert
   *  threshold in a session the churn is escalated to a single tracked `error`
   *  (the leading indicator of the Android background-handle wedge). */
  private noteReopen(timings: { probeMs: number; closeMs: number; openMs: number }): void {
    const reopens = this.opens - 1;
    const at = this.now();
    const cadence = this.lastReopenAt === null ? '' : ` ${at - this.lastReopenAt}ms after the last`;
    this.lastReopenAt = at;
    recordLog(
      'info',
      `sqlite connection reopened (reopen #${reopens} this session${cadence}; ` +
        `probe ${timings.probeMs}ms, close ${timings.closeMs}ms, open ${timings.openMs}ms)`,
    );
    // Escalate on cadence, not lifetime count: keep only reopens inside the
    // rolling window, and alert when *those* cross the threshold. This is the
    // thrash/wedge signature; benign lifecycle reopens spread across a session
    // never cluster, so they no longer trip the "excessive churn" error
    // (STASH-C's false positive). One error per session (latched).
    this.reopenTimes.push(at);
    const windowStart = at - this.reopenAlertWindowMs;
    while (this.reopenTimes.length > 0 && this.reopenTimes[0] < windowStart) {
      this.reopenTimes.shift();
    }
    if (!this.reopenAlerted && this.reopenTimes.length >= this.reopenAlertThreshold) {
      this.reopenAlerted = true;
      const windowSeconds = Math.round(this.reopenAlertWindowMs / 1000);
      recordLog(
        'error',
        `sqlite connection reopened ${this.reopenTimes.length} times within ${windowSeconds}s — excessive handle churn (likely background/foreground thrash or a wedging handle)`,
      );
    }
  }

  private async resolve(): Promise<DB> {
    const existing = this.db;
    // Time each reopen phase separately (see noteReopen): a probe or close
    // riding its multi-second timeout is the head-of-line stall behind the
    // freeze, and this is what tells probe/close/open apart.
    let probeMs = 0;
    let closeMs = 0;
    if (existing) {
      const probeStart = Date.now();
      const { alive, error } = await this.probeAlive(existing);
      probeMs = Date.now() - probeStart;
      if (alive) {
        return existing;
      }
      // Stale handle (app was backgrounded). Record it — repeated reopens are a
      // useful signal — then drop and close it before opening a fresh one.
      // Coalescing through `opening` means only one caller reaches here per
      // generation, so this never clobbers a replacement handle.
      recordLog('warn', `sqlite handle stale, reopening: ${String(error)}`);
      this.db = null;
      // Close and *await* before reopening. expo-sqlite opens with
      // useNewConnection=false, so the native layer caches one connection per
      // database path; closeAsync is what evicts the stale entry. A
      // fire-and-forget close lets the reopen reuse the still-cached invalid
      // handle — and once reopened against that binding, the trailing close only
      // drops a refcount instead of freeing it, so it never recovers. The wait
      // is time-bounded so a wedged close can't deadlock the reopen.
      const closeStart = Date.now();
      await this.closeQuietly(existing);
      closeMs = Date.now() - closeStart;
    }
    try {
      const openStart = Date.now();
      const db = await this.opener();
      const openMs = Date.now() - openStart;
      this.db = db;
      this.opens += 1;
      if (this.opens > 1) {
        this.noteReopen({ probeMs, closeMs, openMs });
      }
      return db;
    } catch (error) {
      // The precise native open error is otherwise swallowed by callers and
      // only surfaces as the generic "Couldn't open local storage" banner.
      recordLog('error', `sqlite open failed: ${String(error)}`);
      throw error;
    }
  }

  private async isAlive(db: DB): Promise<boolean> {
    return (await this.probeAlive(db)).alive;
  }

  private async probeAlive(db: DB): Promise<{ alive: boolean; error?: unknown }> {
    try {
      await this.withTimeout(this.probe(db), this.probeTimeoutMs, 'probe');
      return { alive: true };
    } catch (error) {
      return { alive: false, error };
    }
  }

  private async closeQuietly(db: DB): Promise<void> {
    try {
      await this.withTimeout(this.close(db), this.closeTimeoutMs, 'close');
    } catch {
      // The handle may already be wedged or slow to close; a bounded wait keeps
      // that from hanging the connection. We reopen regardless.
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`sqlite ${label} timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
