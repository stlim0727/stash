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
  updatedAt: string;
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

export function noteSqliteTailWait(waitMs: number, depth: number): void {
  const prev = diagnostics.sqliteContention;
  diagnostics.sqliteContention = {
    maxWaitMs: Math.max(prev?.maxWaitMs ?? 0, waitMs),
    maxDepth: Math.max(prev?.maxDepth ?? 0, depth),
    waitCount: (prev?.waitCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
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
