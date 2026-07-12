export interface SqliteDirectoryAdapter {
  createDirectory: () => void;
  pathIsNonDirectory: () => boolean;
  deleteFile: () => void;
  log?: (level: 'warn' | 'error', message: string) => void;
}

/**
 * Ensure expo-sqlite's parent directory exists. A corrupted install can have a
 * regular file at the SQLite directory path; expo-sqlite then rejects every
 * open with "Path already points to a non-normal file" (Sentry STASH-1Z).
 */
export function ensureSqliteDirectory(adapter: SqliteDirectoryAdapter): void {
  if (adapter.pathIsNonDirectory()) {
    adapter.log?.(
      'warn',
      'sqlite directory path was a file; deleting it before retrying open',
    );
    try {
      adapter.deleteFile();
    } catch (deleteError) {
      adapter.log?.('error', `failed to delete blocking file: ${String(deleteError)}`);
    }
  }

  try {
    adapter.createDirectory();
  } catch (createError) {
    adapter.log?.('error', `sqlite directory creation failed: ${String(createError)}`);
    throw createError;
  }
}
