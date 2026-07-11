export interface SqliteDirectoryAdapter {
  createDirectory: () => void;
  fileExists: () => boolean;
  deleteFile: () => void;
  log?: (level: 'warn' | 'error', message: string) => void;
}

/**
 * Ensure expo-sqlite's parent directory exists. A corrupted install can have a
 * regular file at the SQLite directory path; expo-sqlite then rejects every
 * open with "Path already points to a non-normal file" (Sentry STASH-1Z).
 */
export function ensureSqliteDirectory(adapter: SqliteDirectoryAdapter): void {
  try {
    adapter.createDirectory();
    return;
  } catch (createError) {
    if (!adapter.fileExists()) {
      throw createError;
    }
    adapter.log?.(
      'warn',
      `sqlite directory path was a file; deleting it before retrying open: ${String(createError)}`,
    );
  }

  try {
    adapter.deleteFile();
    adapter.createDirectory();
  } catch (repairError) {
    adapter.log?.('error', `sqlite directory repair failed: ${String(repairError)}`);
    throw repairError;
  }
}
