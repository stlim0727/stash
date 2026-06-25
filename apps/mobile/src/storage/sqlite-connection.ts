import { recordLog } from '@/observability/log-buffer';

export interface SqliteConnectionOptions {
  /** Max time a liveness probe may run before the handle is treated as dead. */
  probeTimeoutMs?: number;
  /** Max time to wait for a stale handle to close before reopening anyway. */
  closeTimeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;

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
 *      this targets) can't hang the probe or close forever and deadlock the tail.
 *   5. {@link closeCurrent} lets the app proactively release the handle when it
 *      backgrounds (the moment Android invalidates it), so the next operation
 *      reopens cleanly instead of first failing on a dead handle.
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
  private readonly probeTimeoutMs: number;
  private readonly closeTimeoutMs: number;

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
    // Run after the current tail settles, regardless of its outcome; a prior
    // rejection must not break the chain for the next caller.
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async runOnce<T>(work: (db: DB) => Promise<T>): Promise<T> {
    const first = await this.get();
    try {
      return await work(first);
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
      return await work(fresh);
    } catch (error) {
      // The replacement handle also died (rapid background/foreground thrash).
      // Surface it — the first reopen is logged in resolve(), so without this
      // the second death would be silent behind the generic storage banner.
      recordLog('warn', `sqlite operation failed after reopen retry: ${String(error)}`);
      throw error;
    }
  }

  private async resolve(): Promise<DB> {
    const existing = this.db;
    if (existing) {
      const { alive, error } = await this.probeAlive(existing);
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
      await this.closeQuietly(existing);
    }
    try {
      const db = await this.opener();
      this.db = db;
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
