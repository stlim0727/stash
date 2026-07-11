import { Directory, File, Paths } from 'expo-file-system';

import { recordLog } from '@/observability/log-buffer';
import { ensureSqliteDirectory } from '@/storage/sqlite-directory';

const SQLITE_DIR = 'SQLite';

export function ensureNativeSqliteDirectory(): void {
  const directory = new Directory(Paths.document, SQLITE_DIR);
  const file = new File(Paths.document, SQLITE_DIR);

  ensureSqliteDirectory({
    createDirectory: () => {
      directory.create({ intermediates: true, idempotent: true });
    },
    pathIsNonDirectory: () => {
      const info = Paths.info(directory.uri);
      return info.exists && info.isDirectory !== true;
    },
    deleteFile: () => {
      file.delete();
    },
    log: recordLog,
  });
}
