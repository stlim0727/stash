import * as FileSystem from 'expo-file-system';

import { recordLog } from '@/observability/log-buffer';
import { ensureExpoSqliteDirectory } from '@/storage/sqlite-directory-expo';

const SQLITE_DIR = 'SQLite';

export function ensureNativeSqliteDirectory(): void {
  ensureExpoSqliteDirectory(FileSystem, SQLITE_DIR, recordLog);
}
