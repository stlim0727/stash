import * as SQLite from 'expo-sqlite';

import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import { noteSqliteOpenFailure } from '@/storage/diagnostics';
import { ensureNativeSqliteDirectory } from '@/storage/sqlite-directory.native';
import { registerForBackgroundClose } from '@/storage/sqlite-app-lifecycle';
import { SqliteConnection } from '@/storage/sqlite-connection';
import type { BookmarkRepository, CreateSyncCompletion, TagData } from '@/storage/types';

interface BookmarkRow {
  id: string;
  data: string;
  created_at: string;
  is_archived: number;
  deleted_at: string | null;
}

interface QueueRow {
  local_id: string;
  remote_id: string | null;
  operation: string;
  payload: string;
  sync_status: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Idempotent schema applied on *every* open. Keeping it in the opener (rather
 * than only in `init`) means a transparently reopened — or freshly created —
 * connection is always self-sufficient and never depends on `init` having run
 * against this particular native handle. Matches the auth store's opener.
 */
const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks (created_at);
  CREATE TABLE IF NOT EXISTS tag_data (
    kind TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS enrichments (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_enrichments_bookmark_id ON enrichments (bookmark_id);
  CREATE TABLE IF NOT EXISTS local_pending_bookmarks (
    local_id TEXT PRIMARY KEY,
    remote_id TEXT,
    operation TEXT NOT NULL DEFAULT 'create',
    payload TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// Row writers shared by `init`'s seed path and the public methods, so neither
// nests a second `connection.run` (which would double-wrap the retry).
function writeBookmark(db: SQLite.SQLiteDatabase, bookmark: Bookmark): Promise<unknown> {
  return db.runAsync(
    'INSERT OR REPLACE INTO bookmarks (id, data, created_at, is_archived, deleted_at) VALUES (?, ?, ?, ?, ?)',
    [
      bookmark.id,
      JSON.stringify(bookmark),
      bookmark.created_at,
      bookmark.is_archived ? 1 : 0,
      bookmark.deleted_at ?? null,
    ],
  );
}

async function writeTagData(db: SQLite.SQLiteDatabase, data: TagData): Promise<void> {
  for (const kind of ['tags', 'bookmarkTags', 'collections'] as const) {
    await db.runAsync('INSERT OR REPLACE INTO tag_data (kind, data) VALUES (?, ?)', [
      kind,
      JSON.stringify(data[kind]),
    ]);
  }
}

async function writeEnrichments(
  db: SQLite.SQLiteDatabase,
  enrichments: AIEnrichment[],
): Promise<void> {
  for (const enrichment of enrichments) {
    await db.runAsync(
      'INSERT OR REPLACE INTO enrichments (id, bookmark_id, data, updated_at) VALUES (?, ?, ?, ?)',
      [enrichment.id, enrichment.bookmark_id, JSON.stringify(enrichment), enrichment.updated_at],
    );
  }
}

/**
 * SQLite-backed store. Bookmarks keep their full record as JSON alongside
 * the columns needed for ordering and filtering; dedicated columns can be
 * promoted when the query surface grows in Milestone 6.
 */
class SqliteBookmarkRepository implements BookmarkRepository {
  // A single coalesced, self-healing connection to stash.db. Every operation
  // runs through `connection.run`, which reopens and retries once if the OS
  // invalidated the handle (a backgrounded app), so a stale handle no longer
  // wedges persistence with "NativeDatabase.prepareAsync ... NullPointerException".
  private readonly connection = new SqliteConnection<SQLite.SQLiteDatabase>(
    async () => {
      let phase = 'preflight';
      try {
        ensureNativeSqliteDirectory();
        phase = 'openDatabaseAsync';
        const db = await SQLite.openDatabaseAsync('stash.db');
        phase = 'execSchema';
        await db.execAsync(SCHEMA_SQL);
        return db;
      } catch (error) {
        noteSqliteOpenFailure(phase, error);
        throw error;
      }
    },
    (db) => db.getFirstAsync('SELECT 1'),
    (db) => db.closeAsync(),
  );

  constructor() {
    // Release the handle when the app backgrounds (Android invalidates it then);
    // the next operation reopens lazily.
    registerForBackgroundClose(() => {
      void this.connection.closeCurrent();
    });
  }

  async init(
    seed: Bookmark[],
    seedTagData?: TagData,
    seedEnrichments?: AIEnrichment[],
  ): Promise<void> {
    await this.connection.run(async (db) => {
      // Schema (tables/indexes/WAL) is created in the opener. These migrations
      // backfill columns on databases created before later features and are the
      // only non-CREATE-IF-NOT-EXISTS steps.
      try {
        await db.execAsync(
          "ALTER TABLE local_pending_bookmarks ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'",
        );
      } catch {
        // Column already exists.
      }
      try {
        await db.execAsync('ALTER TABLE bookmarks ADD COLUMN deleted_at TEXT DEFAULT NULL');
      } catch {
        // Column already exists.
      }

      const seeded = await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'seeded'",
      );
      if (!seeded) {
        for (const bookmark of seed) {
          await writeBookmark(db, bookmark);
        }
        if (seedTagData) {
          await writeTagData(db, seedTagData);
        }
        if (seedEnrichments && seedEnrichments.length > 0) {
          await writeEnrichments(db, seedEnrichments);
        }
        await db.runAsync("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
      }
    });
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<BookmarkRow>(
        'SELECT * FROM bookmarks ORDER BY created_at DESC',
      );
      return rows.map((row) => JSON.parse(row.data) as Bookmark);
    });
  }

  async getBookmark(id: string): Promise<Bookmark | null> {
    return this.connection.run(async (db) => {
      const row = await db.getFirstAsync<BookmarkRow>('SELECT * FROM bookmarks WHERE id = ?', [
        id,
      ]);
      return row ? (JSON.parse(row.data) as Bookmark) : null;
    });
  }

  async insertBookmark(bookmark: Bookmark): Promise<void> {
    await this.connection.run((db) => writeBookmark(db, bookmark));
  }

  async updateBookmark(bookmark: Bookmark): Promise<void> {
    await this.insertBookmark(bookmark);
  }

  async replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void> {
    await this.connection.run((db) =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [previousId]);
        await writeBookmark(db, bookmark);
      }),
    );
  }

  async completeCreateSyncBatch(completions: CreateSyncCompletion[]): Promise<void> {
    if (completions.length === 0) {
      return;
    }
    await this.connection.run((db) =>
      db.withTransactionAsync(async () => {
        for (const { bookmark, entry } of completions) {
          const stored = await db.getFirstAsync<QueueRow>(
            'SELECT * FROM local_pending_bookmarks WHERE local_id = ?',
            [entry.local_id],
          );
          if (
            !stored ||
            stored.operation !== entry.operation ||
            stored.updated_at !== entry.updated_at
          ) {
            continue;
          }
          await writeBookmark(db, bookmark);
          await db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [
            entry.local_id,
          ]);
        }
      }),
    );
  }

  async deleteBookmark(id: string): Promise<void> {
    await this.connection.run((db) => db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]));
  }

  async listQueue(): Promise<LocalPendingBookmark[]> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<QueueRow>(
        'SELECT * FROM local_pending_bookmarks ORDER BY created_at ASC',
      );
      return rows.map((row) => ({
        local_id: row.local_id,
        remote_id: row.remote_id,
        operation: (row.operation ?? 'create') as LocalPendingBookmark['operation'],
        payload: JSON.parse(row.payload),
        sync_status: row.sync_status as LocalPendingBookmark['sync_status'],
        retry_count: row.retry_count,
        last_error: row.last_error,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    });
  }

  async enqueue(entry: LocalPendingBookmark): Promise<void> {
    await this.connection.run((db) =>
      db.runAsync(
        `INSERT OR REPLACE INTO local_pending_bookmarks
        (local_id, remote_id, operation, payload, sync_status, retry_count, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.local_id,
          entry.remote_id,
          entry.operation,
          JSON.stringify(entry.payload),
          entry.sync_status,
          entry.retry_count,
          entry.last_error,
          entry.created_at,
          entry.updated_at,
        ],
      ),
    );
  }

  async updateQueueEntry(entry: LocalPendingBookmark): Promise<void> {
    await this.enqueue(entry);
  }

  async removeQueueEntry(localId: string): Promise<void> {
    await this.connection.run((db) =>
      db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [localId]),
    );
  }

  async getMeta(key: string): Promise<string | null> {
    return this.connection.run(async (db) => {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM meta WHERE key = ?',
        [key],
      );
      return row?.value ?? null;
    });
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.connection.run((db) =>
      db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]),
    );
  }

  async listEnrichments(): Promise<AIEnrichment[]> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM enrichments');
      return rows.map((row) => JSON.parse(row.data) as AIEnrichment);
    });
  }

  async upsertEnrichments(enrichments: AIEnrichment[]): Promise<void> {
    await this.connection.run((db) => writeEnrichments(db, enrichments));
  }

  async deleteEnrichment(bookmarkId: string): Promise<void> {
    await this.connection.run((db) =>
      db.runAsync('DELETE FROM enrichments WHERE bookmark_id = ?', [bookmarkId]),
    );
  }

  async listTagData(): Promise<TagData> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<{ kind: string; data: string }>('SELECT * FROM tag_data');
      const byKind = new Map(rows.map((row) => [row.kind, row.data]));
      return {
        tags: JSON.parse(byKind.get('tags') ?? '[]'),
        bookmarkTags: JSON.parse(byKind.get('bookmarkTags') ?? '[]'),
        collections: JSON.parse(byKind.get('collections') ?? '[]'),
      };
    });
  }

  async replaceTagData(data: TagData): Promise<void> {
    await this.connection.run((db) => db.withTransactionAsync(() => writeTagData(db, data)));
  }

  async clearAllData(): Promise<void> {
    await this.connection.run((db) =>
      db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM bookmarks');
        await db.runAsync('DELETE FROM local_pending_bookmarks');
        await db.runAsync('DELETE FROM enrichments');
        await db.runAsync('DELETE FROM tag_data');
      }),
    );
  }
}

export const repository: BookmarkRepository = new SqliteBookmarkRepository();
