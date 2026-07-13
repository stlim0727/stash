import type { SqliteDirectoryAdapter } from '@/storage/sqlite-directory';
import { ensureSqliteDirectory } from '@/storage/sqlite-directory';
import { noteSqlitePreflight } from '@/storage/diagnostics';

type Log = NonNullable<SqliteDirectoryAdapter['log']>;

export interface ExpoFileSystemLike {
  Directory?: unknown;
  File?: unknown;
  Paths?: {
    document?: unknown;
  };
}

interface ExpoDirectoryLike {
  create?: (options: { intermediates?: boolean; idempotent?: boolean }) => void;
}

interface ExpoFileLike {
  readonly exists?: boolean;
  delete?: () => void;
}

type ExpoDirectoryConstructor = new (
  root: unknown,
  path: string,
) => ExpoDirectoryLike;

type ExpoFileConstructor = new (root: unknown, path: string) => ExpoFileLike;

export function createExpoSqliteDirectoryAdapter(
  fileSystem: ExpoFileSystemLike,
  directoryName: string,
  log?: Log,
): SqliteDirectoryAdapter | null {
  const Directory = fileSystem.Directory;
  const File = fileSystem.File;
  const documentRoot = fileSystem.Paths?.document;

  if (
    typeof Directory !== 'function' ||
    typeof File !== 'function' ||
    documentRoot == null
  ) {
    log?.(
      'warn',
      'sqlite directory preflight unavailable: expo-file-system Directory/File/Paths.document missing',
    );
    return null;
  }

  let directory: ExpoDirectoryLike;
  let file: ExpoFileLike;

  try {
    directory = new (Directory as ExpoDirectoryConstructor)(documentRoot, directoryName);
    file = new (File as ExpoFileConstructor)(documentRoot, directoryName);
  } catch (error) {
    log?.('warn', `sqlite directory preflight unavailable: ${String(error)}`);
    return null;
  }

  return {
    createDirectory: () => {
      if (typeof directory.create !== 'function') {
        log?.(
          'warn',
          'sqlite directory create unavailable; falling back to sqlite open',
        );
        return;
      }

      directory.create({ intermediates: true, idempotent: true });
    },
    pathIsNonDirectory: () => {
      try {
        return Boolean(file.exists);
      } catch (error) {
        log?.('warn', `sqlite directory file check unavailable: ${String(error)}`);
        return false;
      }
    },
    deleteFile: () => {
      if (typeof file.delete !== 'function') {
        log?.(
          'warn',
          'sqlite blocking path delete unavailable; falling back to sqlite open',
        );
        return;
      }

      file.delete();
    },
    log,
  };
}

function capability(value: unknown): string {
  if (value == null) {
    return 'missing';
  }
  return typeof value;
}

export function ensureExpoSqliteDirectory(
  fileSystem: ExpoFileSystemLike,
  directoryName: string,
  log?: Log,
): void {
  const baseDiagnostics = {
    directoryApi: capability(fileSystem.Directory),
    fileApi: capability(fileSystem.File),
    documentRoot: capability(fileSystem.Paths?.document),
  };
  noteSqlitePreflight({ ...baseDiagnostics, lastStep: 'adapter' });
  try {
    const adapter = createExpoSqliteDirectoryAdapter(fileSystem, directoryName, log);

    if (!adapter) {
      noteSqlitePreflight({ ...baseDiagnostics, lastStep: 'adapter-unavailable' });
      return;
    }

    noteSqlitePreflight({ ...baseDiagnostics, lastStep: 'ensure' });
    ensureSqliteDirectory(adapter, { failureLevel: 'warn' });
    noteSqlitePreflight({ ...baseDiagnostics, lastStep: 'complete' });
  } catch (error) {
    noteSqlitePreflight({
      ...baseDiagnostics,
      lastStep: 'fallback',
      lastError: String(error),
    });
    log?.(
      'warn',
      `sqlite directory preflight failed; falling back to sqlite open: ${String(error)}`,
    );
  }
}
