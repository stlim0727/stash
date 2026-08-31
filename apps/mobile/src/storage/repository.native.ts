import * as SQLite from 'expo-sqlite';

import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import { noteSqliteOpenFailure } from '@/storage/diagnostics';
import { IMPORT_BATCH_SIZE, runImportBatchTransactions } from '@/storage/import-batch';
import { ensureNativeSqliteDirectory } from '@/storage/sqlite-directory.native';
import { registerForBackgroundClose } from '@/storage/sqlite-app-lifecycle';
import { SqliteConnection } from '@/storage/sqlite-connection';
import type {
  BookmarkRepository,
  CreateSyncCompletion,
  IdentityRekeyState,
  TagData,
} from '@/storage/types';

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
  last_error_kind: string | null;
  health_escalated_at: string | null;
  created_at: string;
  updated_at: string;
  last_attempt_at: string | null;
}

// A large JSON restore intentionally keeps its bookmark rows and organization
// outboxes in one transaction (see runImportBatchTransactions). On a real
// 997-bookmark restore that bounded unit took just over the connection's normal
// 5s watchdog and produced STASH-4V even though the handle completed normally.
// Keep the strict default for ordinary statements, but give this known bulk
// transaction enough reporting headroom; it is still surfaced if it truly
// remains stuck.
const IMPORT_BATCH_WORK_TIMEOUT_MS = 30_000;

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
    last_error_kind TEXT,
    health_escalated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_attempt_at TEXT
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
    async ({ useNewConnection }) => {
      let phase = 'preflight';
      try {
        ensureNativeSqliteDirectory();
        phase = 'openDatabaseAsync';
        // `useNewConnection` is set only when the previous handle was abandoned
        // with a native op still in flight; the default per-path cache would
        // otherwise hand that very connection straight back.
        const db = await SQLite.openDatabaseAsync('stash.db', { useNewConnection });
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
      try {
        await db.execAsync(
          'ALTER TABLE local_pending_bookmarks ADD COLUMN last_error_kind TEXT DEFAULT NULL',
        );
      } catch {
        // Column already exists.
      }
      try {
        await db.execAsync(
          'ALTER TABLE local_pending_bookmarks ADD COLUMN health_escalated_at TEXT DEFAULT NULL',
        );
      } catch {
        // Column already exists.
      }
      try {
        await db.execAsync(
          'ALTER TABLE local_pending_bookmarks ADD COLUMN last_attempt_at TEXT DEFAULT NULL',
        );
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
    }, 'init');
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<BookmarkRow>(
        'SELECT * FROM bookmarks ORDER BY created_at DESC',
      );
      return rows.map((row) => JSON.parse(row.data) as Bookmark);
    }, 'listBookmarks');
  }

  async getBookmark(id: string): Promise<Bookmark | null> {
    return this.connection.run(async (db) => {
      const row = await db.getFirstAsync<BookmarkRow>('SELECT * FROM bookmarks WHERE id = ?', [
        id,
      ]);
      return row ? (JSON.parse(row.data) as Bookmark) : null;
    }, 'getBookmark');
  }

  async insertBookmark(bookmark: Bookmark): Promise<void> {
    await this.connection.run((db) => writeBookmark(db, bookmark), 'insertBookmark');
  }

  async updateBookmark(bookmark: Bookmark): Promise<void> {
    await this.insertBookmark(bookmark);
  }

  async replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void> {
    await this.connection.run(
      (db) =>
        db.withTransactionAsync(async () => {
          await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [previousId]);
          await writeBookmark(db, bookmark);
        }),
      'replaceBookmark',
    );
  }

  async replaceBookmarkIdentities(
    replacements: Array<{ previousId: string; bookmark: Bookmark }>,
    entries: LocalPendingBookmark[],
    state: IdentityRekeyState,
  ): Promise<void> {
    await this.connection.run((db) =>
      db.withTransactionAsync(async () => {
        for (const { previousId, bookmark } of replacements) {
          await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [previousId]);
          await writeBookmark(db, bookmark);
          // Same transaction, not a follow-up call: a queue entry still
          // sitting under the OLD id (see this method's doc comment in
          // storage/types.ts) must never survive a crash between this
          // commit and a separate cleanup step, or it retries under the OLD
          // id after restart, in parallel with the newly-enqueued entry.
          await db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [
            previousId,
          ]);
        }
        for (const entry of entries) {
          await db.runAsync(
            `INSERT OR REPLACE INTO local_pending_bookmarks
            (local_id, remote_id, operation, payload, sync_status, retry_count, last_error, last_error_kind, health_escalated_at, created_at, updated_at, last_attempt_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.local_id,
              entry.remote_id,
              entry.operation,
              JSON.stringify(entry.payload),
              entry.sync_status,
              entry.retry_count,
              entry.last_error,
              entry.last_error_kind ?? null,
              entry.health_escalated_at ?? null,
              entry.created_at,
              entry.updated_at,
              entry.last_attempt_at ?? null,
            ],
          );
        }
        for (const [key, value] of Object.entries(state.metaUpdates)) {
          await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
            key,
            value,
          ]);
        }
        await writeTagData(db, state.tagData);
      }),
    'replaceBookmarkIdentities');
  }

  async completeCreateSyncBatch(completions: CreateSyncCompletion[]): Promise<void> {
    if (completions.length === 0) {
      return;
    }
    await this.connection.run((db) =>
      db.withTransactionAsync(async () => {
        for (const { bookmark, entry, originalLocalId } of completions) {
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
          if (originalLocalId && originalLocalId !== bookmark.id) {
            // The phantom row under the original id was never actually
            // created server-side (a duplicate-status create — STASH-3Q).
            await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [originalLocalId]);
          }
          await writeBookmark(db, bookmark);
          await db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [
            entry.local_id,
          ]);
        }
      }),
    'completeCreateSyncBatch');
  }

  async insertImportBatch(
    bookmarks: Bookmark[],
    entries: LocalPendingBookmark[],
    options?: { metaUpdates?: Record<string, string> },
  ): Promise<void> {
    if (bookmarks.length === 0) {
      return;
    }
    await this.connection.run(async (db) => {
      await runImportBatchTransactions({
        bookmarks,
        entries,
        metaUpdates: options?.metaUpdates,
        transaction: (work) => db.withTransactionAsync(work),
        writeMeta: async (key, value) => {
          await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
            key,
            value,
          ]);
        },
        writePair: async (bookmark, entry) => {
          await writeBookmark(db, bookmark);
          await db.runAsync(
            `INSERT OR REPLACE INTO local_pending_bookmarks
            (local_id, remote_id, operation, payload, sync_status, retry_count, last_error, last_error_kind, health_escalated_at, created_at, updated_at, last_attempt_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.local_id,
              entry.remote_id,
              entry.operation,
              JSON.stringify(entry.payload),
              entry.sync_status,
              entry.retry_count,
              entry.last_error,
              entry.last_error_kind ?? null,
              entry.health_escalated_at ?? null,
              entry.created_at,
              entry.updated_at,
              entry.last_attempt_at ?? null,
            ],
          );
        },
      });
    }, 'insertImportBatch', { workTimeoutMs: IMPORT_BATCH_WORK_TIMEOUT_MS });
  }

  async deleteBookmark(id: string): Promise<void> {
    await this.connection.run(
      (db) => db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]),
      'deleteBookmark',
    );
  }

  // Chunked transactions (one connection.run per IMPORT_BATCH_SIZE rows)
  // instead of one call per row — a large pull reconciling hundreds of rows
  // otherwise stacks that many separate calls onto the single connection
  // actor (Sentry STASH-5X: 802 deletions during one pull; see
  // docs/architecture/sqlite-write-contention.md). Bounded per the same
  // IMPORT_BATCH_SIZE chunking runImportBatchTransactions already uses,
  // rather than one unbounded transaction for the whole batch — a
  // first-sync-sized pull holding the write lock for its full duration is
  // exactly the failure mode this file has been burned by repeatedly.
  async upsertBookmarks(bookmarks: Bookmark[]): Promise<void> {
    for (let offset = 0; offset < bookmarks.length; offset += IMPORT_BATCH_SIZE) {
      const chunk = bookmarks.slice(offset, offset + IMPORT_BATCH_SIZE);
      await this.connection.run(
        (db) =>
          db.withTransactionAsync(async () => {
            for (const bookmark of chunk) {
              await writeBookmark(db, bookmark);
            }
          }),
        'upsertBookmarks',
      );
    }
  }

  async deleteBookmarks(ids: string[]): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += IMPORT_BATCH_SIZE) {
      const chunk = ids.slice(offset, offset + IMPORT_BATCH_SIZE);
      await this.connection.run(
        (db) =>
          db.withTransactionAsync(async () => {
            for (const id of chunk) {
              await db.runAsync('DELETE FROM bookmarks WHERE id = ?', [id]);
            }
          }),
        'deleteBookmarks',
      );
    }
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
        last_error_kind:
          row.last_error_kind === 'transient_dns' ||
          row.last_error_kind === 'transient_network' ||
          row.last_error_kind === 'other'
            ? row.last_error_kind
            : null,
        health_escalated_at: row.health_escalated_at ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_attempt_at: row.last_attempt_at ?? null,
      }));
    }, 'listQueue');
  }

  async enqueue(entry: LocalPendingBookmark): Promise<void> {
    await this.connection.run(
      (db) =>
        db.runAsync(
          `INSERT OR REPLACE INTO local_pending_bookmarks
        (local_id, remote_id, operation, payload, sync_status, retry_count, last_error, last_error_kind, health_escalated_at, created_at, updated_at, last_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.local_id,
            entry.remote_id,
            entry.operation,
            JSON.stringify(entry.payload),
            entry.sync_status,
            entry.retry_count,
            entry.last_error,
            entry.last_error_kind ?? null,
            entry.health_escalated_at ?? null,
            entry.created_at,
            entry.updated_at,
            entry.last_attempt_at ?? null,
          ],
        ),
      'enqueue',
    );
  }

  async updateQueueEntry(entry: LocalPendingBookmark): Promise<void> {
    await this.enqueue(entry);
  }

  async removeQueueEntry(localId: string): Promise<void> {
    await this.connection.run(
      (db) => db.runAsync('DELETE FROM local_pending_bookmarks WHERE local_id = ?', [localId]),
      'removeQueueEntry',
    );
  }

  async getMeta(key: string): Promise<string | null> {
    return this.connection.run(async (db) => {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM meta WHERE key = ?',
        [key],
      );
      return row?.value ?? null;
    }, 'getMeta');
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.connection.run(
      (db) => db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]),
      'setMeta',
    );
  }

  async listEnrichments(): Promise<AIEnrichment[]> {
    return this.connection.run(async (db) => {
      const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM enrichments');
      return rows.map((row) => JSON.parse(row.data) as AIEnrichment);
    }, 'listEnrichments');
  }

  async upsertEnrichments(enrichments: AIEnrichment[]): Promise<void> {
    await this.connection.run((db) => writeEnrichments(db, enrichments), 'upsertEnrichments');
  }

  async deleteEnrichment(bookmarkId: string): Promise<void> {
    await this.connection.run(
      (db) => db.runAsync('DELETE FROM enrichments WHERE bookmark_id = ?', [bookmarkId]),
      'deleteEnrichment',
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
    }, 'listTagData');
  }

  async replaceTagData(data: TagData): Promise<void> {
    await this.connection.run(
      (db) => db.withTransactionAsync(() => writeTagData(db, data)),
      'replaceTagData',
    );
  }

  async clearAllData(): Promise<void> {
    await this.connection.run(
      (db) =>
        db.withTransactionAsync(async () => {
          await db.runAsync('DELETE FROM bookmarks');
          await db.runAsync('DELETE FROM local_pending_bookmarks');
          await db.runAsync('DELETE FROM enrichments');
          await db.runAsync('DELETE FROM tag_data');
        }),
      'clearAllData',
    );
  }
}

export const repository: BookmarkRepository = new SqliteBookmarkRepository();
