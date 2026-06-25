import * as SQLite from 'expo-sqlite';

import { SqliteConnection } from '@/storage/sqlite-connection';
import type { SupabaseAuthSession } from '@/supabase/types';

const SESSION_KEY = 'supabase.auth.session';

// Use a SEPARATE database file from the bookmarks store (stash.db). Two open
// connections to the same file race and the native layer rejects statements
// ("NativeDatabase.prepareAsync ... NullPointerException"). SqliteConnection
// coalesces opens, retries a failed open, and reopens a handle the OS
// invalidated while the app was backgrounded (CREATE TABLE IF NOT EXISTS makes
// reopening idempotent) so a stale auth handle self-heals instead of silently
// dropping every session write for the rest of the run.
const connection = new SqliteConnection<SQLite.SQLiteDatabase>(
  async () => {
    const db = await SQLite.openDatabaseAsync('stash-auth.db');
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return db;
  },
  (db) => db.getFirstAsync('SELECT 1'),
  (db) => db.closeAsync(),
);

// All operations are best-effort: a storage failure must never block auth.
// Worst case the session isn't persisted and a fresh anonymous one is created.
// `connection.run` reopens and retries once if the handle died under us.

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  try {
    return await connection.run(async (db) => {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM meta WHERE key = ?',
        [SESSION_KEY],
      );
      return row ? (JSON.parse(row.value) as SupabaseAuthSession) : null;
    });
  } catch {
    return null;
  }
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  try {
    await connection.run((db) =>
      db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
        SESSION_KEY,
        JSON.stringify(session),
      ]),
    );
  } catch {
    // Persistence is best-effort; the session is still usable this run.
  }
}

export async function clearSupabaseSession(): Promise<void> {
  try {
    await connection.run((db) => db.runAsync('DELETE FROM meta WHERE key = ?', [SESSION_KEY]));
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}
