import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import {
  createSecureSessionStore,
  type LegacySessionSource,
  type SecureKvBackend,
} from '@/supabase/secure-session-core';
import type { SupabaseAuthSession } from '@/supabase/types';
import { registerForBackgroundClose } from '@/storage/sqlite-app-lifecycle';
import { SqliteConnection } from '@/storage/sqlite-connection';

const LEGACY_SESSION_KEY = 'supabase.auth.session';

// iOS Keychain accessibility: AFTER_FIRST_UNLOCK lets a backgrounded app read
// the session (e.g. to refresh an expiring token on a background task) once the
// device has been unlocked at least since boot. The stricter default
// (WHEN_UNLOCKED) would make those reads fail while the screen is locked. The
// item is still excluded from iCloud/iTunes backups by SecureStore by default.
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

// Secure (Keychain/Keystore-backed) key/value backend. Every call is
// best-effort: a hardware/keystore failure must never block auth, so reads fall
// back to null and writes/deletes swallow. Worst case a session isn't persisted
// and a fresh anonymous one is created next launch — the same failure mode the
// old plaintext store had.
const secureBackend: SecureKvBackend = {
  async getItem(key) {
    try {
      return await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS);
  },
  async deleteItem(key) {
    try {
      await SecureStore.deleteItemAsync(key, SECURE_STORE_OPTIONS);
    } catch {
      // Nothing to delete / keystore unavailable — ignore.
    }
  },
};

// --- Legacy plaintext store (read + delete only) -----------------------------
// The previous implementation wrote the full session as JSON into this plain
// (unencrypted) SQLite file. We keep just enough of it to migrate any existing
// session into secure storage on first launch after upgrade, then wipe it. No
// new sessions are ever written here.
const legacyConnection = new SqliteConnection<SQLite.SQLiteDatabase>(
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

// Release the legacy handle when the app backgrounds; the next read reopens.
registerForBackgroundClose(() => {
  void legacyConnection.closeCurrent();
});

const legacySource: LegacySessionSource = {
  async read() {
    try {
      return await legacyConnection.run(async (db) => {
        const row = await db.getFirstAsync<{ value: string }>(
          'SELECT value FROM meta WHERE key = ?',
          [LEGACY_SESSION_KEY],
        );
        if (!row) return null;
        try {
          return JSON.parse(row.value) as SupabaseAuthSession;
        } catch {
          return null;
        }
      });
    } catch {
      return null;
    }
  },
  async clear() {
    try {
      await legacyConnection.run((db) =>
        db.runAsync('DELETE FROM meta WHERE key = ?', [LEGACY_SESSION_KEY]),
      );
    } catch {
      // Best-effort: a failed wipe just means migration retries next launch.
    }
  },
};

const store = createSecureSessionStore({ backend: secureBackend, legacy: legacySource });

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  return store.read();
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  try {
    await store.write(session);
  } catch {
    // Persistence is best-effort; the session is still usable this run.
  }
}

export async function clearSupabaseSession(): Promise<void> {
  try {
    await store.clear();
  } catch {
    // Ignore — nothing to clear if secure storage is unavailable.
  }
}

/**
 * Whether a real (non-anonymous) account was ever durably persisted on this
 * device. Best-effort: a keystore read failure reads as `false`, degrading to
 * the pre-fix behaviour (treat as first run) rather than blocking auth.
 */
export async function hadRealSupabaseSession(): Promise<boolean> {
  try {
    return await store.hadRealAccount();
  } catch {
    return false;
  }
}
