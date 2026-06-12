import * as SQLite from 'expo-sqlite';

import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';

interface BookmarkRow {
  id: string;
  data: string;
  created_at: string;
  is_archived: number;
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
 * SQLite-backed store. Bookmarks keep their full record as JSON alongside
 * the columns needed for ordering and filtering; dedicated columns can be
 * promoted when the query surface grows in Milestone 6.
 */
class SqliteBookmarkRepository implements BookmarkRepository {
  private db: SQLite.SQLiteDatabase | null = null;

  private async open(): Promise<SQLite.SQLiteDatabase> {
    if (!this.db) {
      this.db = await SQLite.openDatabaseAsync('stash.db');
    }
    return this.db;
  }

  async init(seed: Bookmark[]): Promise<void> {
    const db = await this.open();
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks (created_at);
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
    `);

    // Databases created before mutation sync lack the operation column.
    try {
      await db.execAsync(
        "ALTER TABLE local_pending_bookmarks ADD COLUMN operation TEXT NOT NULL DEFAULT 'create'",
      );
    } catch {
      // Column already exists.
    }

    const seeded = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'seeded'",
    );
    if (!seeded) {
      for (const bookmark of seed) {
        await this.insertBookmark(bookmark);
      }
      await db.runAsync("INSERT INTO meta (key, value) VALUES ('seeded', '1')");
    }
  }

  async listBookmarks(): Promise<Bookmark[]> {
    const db = await this.open();
    const rows = await db.getAllAsync<BookmarkRow>(
      'SELECT * FROM bookmarks ORDER BY created_at DESC',
    );
    return rows.map((row) => JSON.parse(row.data) as Bookmark);
  }

  async insertBookmark(bookmark: Bookmark): Promise<void> {
    const db = await this.open();
    await db.runAsync(
      'INSERT OR REPLACE INTO bookmarks (id, data, created_at, is_archived) VALUES (?, ?, ?, ?)',
      [bookmark.id, JSON.stringify(bookmark), bookmark.created_at, bookmark.is_archived ? 1 : 0],
    );
  }

  async updateBookmark(bookmark: Bookmark): Promise<void> {
    await this.insertBookmark(bookmark);
  }

  async replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void> {
    const db = await this.open();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [previousId]);
      await db.runAsync(
        'INSERT OR REPLACE INTO bookmarks (id, data, created_at, is_archived) VALUES (?, ?, ?, ?)',
        [bookmark.id, JSON.stringify(bookmark), bookmark.created_at, bookmark.is_archived ? 1 : 0],
      );
    });
  }

  async deleteBookmark(id: string): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]);
  }

  async listQueue(): Promise<LocalPendingBookmark[]> {
    const db = await this.open();
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
  }

  async enqueue(entry: LocalPendingBookmark): Promise<void> {
    const db = await this.open();
    await db.runAsync(
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
    );
  }

  async updateQueueEntry(entry: LocalPendingBookmark): Promise<void> {
    await this.enqueue(entry);
  }

  async removeQueueEntry(localId: string): Promise<void> {
    const db = await this.open();
    await db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [localId]);
  }
}

export const repository: BookmarkRepository = new SqliteBookmarkRepository();
