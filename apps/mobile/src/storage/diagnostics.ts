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

export interface StorageDiagnostics {
  sqlitePreflight?: SqlitePreflightDiagnostics;
  sqliteOpen?: SqliteOpenDiagnostics;
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

export function getStorageDiagnostics(): StorageDiagnostics | undefined {
  if (!diagnostics.sqlitePreflight && !diagnostics.sqliteOpen) {
    return undefined;
  }
  return {
    sqlitePreflight: diagnostics.sqlitePreflight
      ? { ...diagnostics.sqlitePreflight }
      : undefined,
    sqliteOpen: diagnostics.sqliteOpen ? { ...diagnostics.sqliteOpen } : undefined,
  };
}
