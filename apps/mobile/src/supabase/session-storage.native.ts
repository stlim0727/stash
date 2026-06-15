import * as SQLite from 'expo-sqlite';

import type { SupabaseAuthSession } from '@/supabase/types';

const SESSION_KEY = 'supabase.auth.session';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    // Use a SEPARATE database file from the bookmarks store (stash.db). Two
    // open connections to the same file race and the native layer rejects
    // statements ("NativeDatabase.prepareAsync ... NullPointerException").
    dbPromise = SQLite.openDatabaseAsync('stash-auth.db').then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      return db;
    });
    // Let a failed open be retried rather than caching a rejected promise.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }

  return dbPromise;
}

// All operations are best-effort: a storage failure must never block auth.
// Worst case the session isn't persisted and a fresh anonymous one is created.

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  try {
    const db = await open();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      SESSION_KEY,
    ]);
    return row ? (JSON.parse(row.value) as SupabaseAuthSession) : null;
  } catch {
    return null;
  }
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  try {
    const db = await open();
    await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      SESSION_KEY,
      JSON.stringify(session),
    ]);
  } catch {
    // Persistence is best-effort; the session is still usable this run.
  }
}

export async function clearSupabaseSession(): Promise<void> {
  try {
    const db = await open();
    await db.runAsync('DELETE FROM meta WHERE key = ?', [SESSION_KEY]);
  } catch {
    // Ignore — nothing to clear if storage is unavailable.
  }
}
