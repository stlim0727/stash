import { recordLog } from '@/observability/log-buffer';

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
 * The fix: funnel the whole decision (liveness probe + reopen) through one
 * in-flight `opening` promise. Concurrent callers await the same resolution, so
 * there is exactly one probe and at most one reopen per generation, and the
 * stale handle is closed rather than leaked. The auth store
 * (`session-storage.native.ts`) coalesces its single connection the same way.
 */
export class SqliteConnection<DB> {
  private db: DB | null = null;
  private opening: Promise<DB> | null = null;

  constructor(
    private readonly opener: () => Promise<DB>,
    /** Cheap liveness check; throws if the handle is stale/invalidated. */
    private readonly probe: (db: DB) => Promise<unknown>,
    /** Best-effort close of a handle being discarded. */
    private readonly close: (db: DB) => Promise<unknown>,
  ) {}

  /** Resolve to a live handle, reopening transparently if the current one died. */
  get(): Promise<DB> {
    if (!this.opening) {
      this.opening = this.resolve().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async resolve(): Promise<DB> {
    const existing = this.db;
    if (existing) {
      try {
        await this.probe(existing);
        return existing;
      } catch (error) {
        // Stale handle (app was backgrounded). Record it — repeated reopens are
        // a useful signal — then drop and close it before opening a fresh one.
        // Coalescing through `opening` means only one caller ever reaches here
        // per generation, so this never clobbers a replacement handle.
        recordLog('warn', `sqlite handle stale, reopening: ${String(error)}`);
        this.db = null;
        void Promise.resolve(this.close(existing)).catch(() => {
          // The stale handle may already be wedged; failing to close it is fine.
        });
      }
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
}
