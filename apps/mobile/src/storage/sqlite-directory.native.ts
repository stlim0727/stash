import * as FileSystem from 'expo-file-system';

import { recordLog } from '@/observability/log-buffer';
import { ensureSqliteDirectory } from '@/storage/sqlite-directory';
import { createExpoSqliteDirectoryAdapter } from '@/storage/sqlite-directory-expo';

const SQLITE_DIR = 'SQLite';

export function ensureNativeSqliteDirectory(): void {
  const adapter = createExpoSqliteDirectoryAdapter(FileSystem, SQLITE_DIR, recordLog);

  if (!adapter) {
    return;
  }

  ensureSqliteDirectory(adapter);
}
