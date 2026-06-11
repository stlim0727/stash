import type { SupabaseAuthSession } from '@/supabase/types';

const SESSION_KEY = 'stash.supabase.auth.session';
let memorySession: SupabaseAuthSession | null = null;

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

export async function readSupabaseSession(): Promise<SupabaseAuthSession | null> {
  if (!storageAvailable()) {
    return memorySession;
  }

  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as SupabaseAuthSession) : null;
}

export async function writeSupabaseSession(session: SupabaseAuthSession): Promise<void> {
  memorySession = session;
  if (storageAvailable()) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
}

export async function clearSupabaseSession(): Promise<void> {
  memorySession = null;
  if (storageAvailable()) {
    localStorage.removeItem(SESSION_KEY);
  }
}
