export interface SqliteDirectoryAdapter {
  createDirectory: () => void;
  pathIsNonDirectory: () => boolean;
  deleteFile: () => void;
  log?: (level: 'warn' | 'error', message: string) => void;
}

export interface EnsureSqliteDirectoryOptions {
  /** Best-effort native preflights should warn so successful fall-throughs do not create Sentry errors. */
  failureLevel?: 'warn' | 'error';
}

/**
 * Ensure expo-sqlite's parent directory exists. A corrupted install can have a
 * regular file at the SQLite directory path; expo-sqlite then rejects every
 * open with "Path already points to a non-normal file" (Sentry STASH-1Z).
 */
export function ensureSqliteDirectory(
  adapter: SqliteDirectoryAdapter,
  options: EnsureSqliteDirectoryOptions = {},
): void {
  const failureLevel = options.failureLevel ?? 'error';
  if (adapter.pathIsNonDirectory()) {
    adapter.log?.(
      'warn',
      'sqlite directory path was a file; deleting it before retrying open',
    );
    try {
      adapter.deleteFile();
    } catch (deleteError) {
      adapter.log?.(failureLevel, `failed to delete blocking file: ${String(deleteError)}`);
    }
  }

  try {
    adapter.createDirectory();
  } catch (createError) {
    adapter.log?.(failureLevel, `sqlite directory creation failed: ${String(createError)}`);
    throw createError;
  }
}
