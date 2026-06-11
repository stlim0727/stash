import * as SQLite from 'expo-sqlite';

import type { SupabaseAuthSession } from '@/supabase/types';

const SESSION_KEY = 'supabase.auth.session';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('stash.db').then(async (db) => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      return db;
    });
  }

  return dbPromise;
}

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  const db = await open();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    SESSION_KEY,
  ]);
  return row ? (JSON.parse(row.value) as SupabaseAuthSession) : null;
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  const db = await open();
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    SESSION_KEY,
    JSON.stringify(session),
  ]);
}

export async function clearSupabaseSession(): Promise<void> {
  const db = await open();
  await db.runAsync('DELETE FROM meta WHERE key = ?', [SESSION_KEY]);
}
