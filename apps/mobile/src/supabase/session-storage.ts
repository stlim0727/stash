import {
  createSecureSessionStore,
  type LegacySessionSource,
  type SecureKvBackend,
} from '@/supabase/secure-session-core';
import type { SupabaseAuthSession } from '@/supabase/types';

// Web has no Keychain/Keystore, so "secure" storage is best-effort localStorage
// with an in-memory fallback during SSR. We still route through the shared core
// so chunking, validation, and legacy migration behave identically to native —
// the browser is a dev/SSR target, not the security-sensitive surface.
const LEGACY_SESSION_KEY = 'stash.supabase.auth.session';

const memory = new Map<string, string>();

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

const webBackend: SecureKvBackend = {
  async getItem(key) {
    if (storageAvailable()) {
      return localStorage.getItem(key);
    }
    return memory.has(key) ? (memory.get(key) as string) : null;
  },
  async setItem(key, value) {
    memory.set(key, value);
    if (storageAvailable()) {
      localStorage.setItem(key, value);
    }
  },
  async deleteItem(key) {
    memory.delete(key);
    if (storageAvailable()) {
      localStorage.removeItem(key);
    }
  },
};

const legacySource: LegacySessionSource = {
  async read() {
    if (!storageAvailable()) return null;
    const raw = localStorage.getItem(LEGACY_SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SupabaseAuthSession;
    } catch {
      return null;
    }
  },
  async clear() {
    if (storageAvailable()) {
      localStorage.removeItem(LEGACY_SESSION_KEY);
    }
  },
};

const store = createSecureSessionStore({ backend: webBackend, legacy: legacySource });

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  return store.read();
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  await store.write(session);
}

export async function clearSupabaseSession(): Promise<void> {
  await store.clear();
}
