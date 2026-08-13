export interface SqlitePreflightDiagnostics {
  directoryApi: string;
  fileApi: string;
  documentRoot: string;
  lastStep: string;
  lastError?: string;
  updatedAt: string;
}

export interface SqliteOpenDiagnostics {
  phase: string;
  error: string;
  updatedAt: string;
}

/**
 * Cumulative-since-launch summary of "sqlite tail wait" contention (see
 * `sqlite-connection.ts`'s `serialize`) — the single serialized connection's
 * queue depth/wait time. Kept as running max/count, not per-event log lines,
 * so it survives regardless of how much unrelated log noise rotates through
 * the log-buffer ring in between (STASH-3Y investigation: this contention
 * looked severe enough in one report to plausibly be a contributing cause).
 */
export interface SqliteContentionDiagnostics {
  maxWaitMs: number;
  maxDepth: number;
  /** How many waits crossed the "non-trivial" logging threshold. */
  waitCount: number;
  /**
   * The repository/session-storage operation label(s) queued on the
   * connection actor at the moment `maxDepth` last advanced (see
   * `sqlite-connection.ts`'s `serialize`). A bare depth number told us
   * contention happened but not what collided — a real report showed severe
   * contention (depth 23, 4061ms) with no way to tell whether that was one
   * runaway caller or several legitimate pipelines (sync drain, pull,
   * import reconcile) overlapping. Omitted when the caller didn't pass a
   * label (older/untouched call sites default to 'unlabeled').
   *
   * Tracked separately from `maxWaitLabels` (STASH-64): the two used to
   * share one `labels` field, so a *wait*-only advance (same or lower depth,
   * but a slower single op) overwrote whatever labels the actual
   * depth-driven max had recorded — a report showed `maxDepth: 22` but
   * labels naming only a 2-deep queue, because the label snapshot was
   * silently taken over by a later, shallower, merely-slower wait.
   */
  maxDepthLabels?: string;
  /**
   * When `maxDepth` (and `maxDepthLabels`) last advanced. Absent only if
   * `maxDepth` has never actually been set by a tail-wait/queue-depth call
   * (shouldn't happen once `sqliteContention` exists at all, but typed
   * optional to avoid a fabricated timestamp for an unset metric).
   */
  maxDepthUpdatedAt?: string;
  /**
   * The label(s) queued at the moment `maxWaitMs` last advanced. A high wait
   * at a low depth means one op itself ran long (a single slow/wedged
   * call), a different signature from a deep queue — see `maxDepthLabels`.
   */
  maxWaitLabels?: string;
  /**
   * When `maxWaitMs` (and `maxWaitLabels`) last advanced — tracked
   * separately from `maxDepthUpdatedAt` (STASH-64 review) so a depth spike
   * from one session and a slower-but-shallower wait from a later one don't
   * share a single timestamp that makes the stale one look contemporaneous
   * with whichever report actually triggered the update. Absent until the
   * first tail-wait call, since `noteSqliteQueueDepth` (the eager,
   * depth-only path) never observes a wait.
   */
  maxWaitUpdatedAt?: string;
}

export interface StorageDiagnostics {
  sqlitePreflight?: SqlitePreflightDiagnostics;
  sqliteOpen?: SqliteOpenDiagnostics;
  sqliteContention?: SqliteContentionDiagnostics;
}

const MAX_ERROR_LENGTH = 500;

const diagnostics: StorageDiagnostics = {};

function trimError(error: unknown): string {
  return String(error).slice(0, MAX_ERROR_LENGTH);
}

export function noteSqlitePreflight(
  update: Omit<SqlitePreflightDiagnostics, 'updatedAt'>,
): void {
  diagnostics.sqlitePreflight = {
    ...update,
    lastError: update.lastError ? trimError(update.lastError) : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function noteSqliteOpenFailure(phase: string, error: unknown): void {
  diagnostics.sqliteOpen = {
    phase,
    error: trimError(error),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The caller (`sqlite-connection.ts`) is expected to skip calling this
 * entirely when a background/foreground transition happened while the unit
 * of work was queued — a duration-based cutoff can't tell a genuine long
 * stall apart from a short background blip (a real multi-minute freeze and a
 * multi-minute background both just look like "a long wait"), so the
 * distinction is made by counting actual AppState transitions instead of
 * guessing from elapsed time.
 *
 * `waitCount` increments on every call (it's a running tally, not a
 * maximum), but `maxDepthUpdatedAt`/`maxWaitUpdatedAt` each only advance
 * when their own metric (`maxDepth`/`maxWaitMs`) actually does — a routine
 * 300ms wait long after an hours-old 10s one must not make that old severe
 * event look contemporaneous with a report filed around the routine one.
 */
export function noteSqliteTailWait(waitMs: number, depth: number, labels?: string): void {
  const prev = diagnostics.sqliteContention;
  const depthAdvanced = !prev || depth > prev.maxDepth;
  const waitAdvanced = !prev || waitMs > prev.maxWaitMs;
  const now = depthAdvanced || waitAdvanced ? new Date().toISOString() : undefined;
  diagnostics.sqliteContention = {
    maxWaitMs: Math.max(prev?.maxWaitMs ?? 0, waitMs),
    maxDepth: Math.max(prev?.maxDepth ?? 0, depth),
    waitCount: (prev?.waitCount ?? 0) + 1,
    maxDepthLabels: depthAdvanced ? labels : prev?.maxDepthLabels,
    maxDepthUpdatedAt: depthAdvanced ? now! : prev!.maxDepthUpdatedAt,
    maxWaitLabels: waitAdvanced ? labels : prev?.maxWaitLabels,
    maxWaitUpdatedAt: waitAdvanced ? now! : prev!.maxWaitUpdatedAt,
  };
}

/**
 * Eagerly records queue depth at enqueue time, before the unit of work has
 * even started waiting — unlike `noteSqliteTailWait`, whose measurement only
 * lands once a unit finally starts running. Under a genuine stall (one op
 * wedged or very slow), everything queued behind it never gets that far, so
 * a report filed *during* the stall would otherwise show no contention at
 * all despite the queue visibly growing. Wait time itself can't be known
 * this early (it's still unbounded), only depth.
 *
 * A no-op (including no `maxDepthUpdatedAt` bump) when `depth` doesn't
 * exceed the already-recorded maximum — a routine depth-2 enqueue right
 * before a report is filed must not make an hours-old severe-contention
 * maximum look contemporaneous with that report.
 */
export function noteSqliteQueueDepth(depth: number, labels?: string): void {
  const prev = diagnostics.sqliteContention;
  if (prev && depth <= prev.maxDepth) {
    return;
  }
  diagnostics.sqliteContention = {
    maxWaitMs: prev?.maxWaitMs ?? 0,
    maxDepth: depth,
    waitCount: prev?.waitCount ?? 0,
    maxDepthLabels: labels,
    maxDepthUpdatedAt: new Date().toISOString(),
    maxWaitLabels: prev?.maxWaitLabels,
    maxWaitUpdatedAt: prev?.maxWaitUpdatedAt,
  };
}

export function getStorageDiagnostics(): StorageDiagnostics | undefined {
  if (!diagnostics.sqlitePreflight && !diagnostics.sqliteOpen && !diagnostics.sqliteContention) {
    return undefined;
  }
  return {
    sqlitePreflight: diagnostics.sqlitePreflight
      ? { ...diagnostics.sqlitePreflight }
      : undefined,
    sqliteOpen: diagnostics.sqliteOpen ? { ...diagnostics.sqliteOpen } : undefined,
    sqliteContention: diagnostics.sqliteContention
      ? { ...diagnostics.sqliteContention }
      : undefined,
  };
}
