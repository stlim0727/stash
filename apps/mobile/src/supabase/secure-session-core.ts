import type { SupabaseAuthSession } from '@/supabase/types';

/**
 * Platform-free core for persisting the Supabase auth session in **secure,
 * OS-backed key/value storage** (iOS Keychain / Android Keystore on native, a
 * best-effort localStorage/in-memory fallback on web).
 *
 * Why this exists: the session carries the long-lived `refresh_token` and the
 * `access_token`. Previously both were written to a plain (unencrypted) SQLite
 * file on device — readable from a backup or a rooted/jailbroken device. Moving
 * them into Keychain/Keystore is the highest-value, lowest-cost hardening step
 * for shipping a commercial build.
 *
 * Everything here is pure and backend-injected so it can be exhaustively unit
 * tested with a fake store (no native modules, no React) — the native and web
 * adapters supply the real backend.
 *
 * Two things make the secure backend awkward and are handled here, not in the
 * adapters:
 *   1. **Size limit.** `expo-secure-store` only reliably stores small values
 *      (~2KB on Android; larger writes warn and "may fail"). A session JSON with
 *      both tokens plus OAuth `user_metadata` (avatar URL, name) can exceed that.
 *      A silent write failure is dangerous: on next launch we'd find no session,
 *      mint a *fresh anonymous user*, and orphan the original user's bookmarks.
 *      So we split the payload into byte-bounded chunks, and to make an overwrite
 *      crash-safe we double-buffer: the new session is written under an *inactive*
 *      generation and a single pointer key is flipped to commit, leaving the
 *      previous session fully readable until — and unless — the flip lands.
 *   2. **Migration.** Existing installs already have a session in the legacy
 *      plaintext SQLite store. On first read after upgrade we transparently
 *      carry it over into secure storage and wipe the plaintext copy, so nobody
 *      is signed out (and no anonymous user is orphaned) by the switch.
 */

/** Minimal secure key/value backend the adapters provide. All best-effort. */
export interface SecureKvBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/**
 * One-time source for a session left behind by an older app version, read so it
 * can be migrated into secure storage and then cleared. `clear` is best-effort.
 */
export interface LegacySessionSource {
  read(): Promise<SupabaseAuthSession | null>;
  clear(): Promise<void>;
}

export interface SecureSessionStore {
  read(): Promise<SupabaseAuthSession | null>;
  write(session: SupabaseAuthSession): Promise<void>;
  clear(): Promise<void>;
  /**
   * True when the last durably-persisted session belonged to a REAL (non-
   * anonymous) account. Read from a standalone breadcrumb (see REAL_ACCOUNT_KEY)
   * so it stays meaningful even when the chunked session blob reads back as
   * absent/torn — the signal restoreSession needs to avoid minting an anonymous
   * user over a lost real session.
   */
  hadRealAccount(): Promise<boolean>;
}

// Namespaced + versioned so the keys never collide with the legacy plaintext
// key and so a future format change can coexist during migration.
const KEY_PREFIX = 'supabase.auth.session.v2';
// Double-buffered storage: a session is written under one of two generations
// ('a' / 'b') and a single pointer key is flipped to commit (see
// createSecureSessionStore). The previous generation stays intact and readable
// until the flip, so a torn/failed overwrite never corrupts the live session.
const ACTIVE_KEY = `${KEY_PREFIX}.active`;
// A tiny, un-chunked breadcrumb recording whether the last durably-persisted
// session belonged to a REAL (non-anonymous) account. It lives in its own key —
// never chunked, never part of a generation — so it survives a partial/torn
// read of the session blob (a missing chunk, a transient keystore error). It
// lets restoreSession tell "a real account's session is unreadable this launch"
// (→ keep local data, prompt re-sign-in) apart from "genuine first run" (→ mint
// an anonymous user), closing the silent-anonymous-mint data-loss path.
const REAL_ACCOUNT_KEY = `${KEY_PREFIX}.real`;
type Generation = 'a' | 'b';
const countKey = (gen: Generation): string => `${KEY_PREFIX}.${gen}.count`;
const chunkKey = (gen: Generation, index: number): string => `${KEY_PREFIX}.${gen}.${index}`;
const otherGeneration = (gen: Generation): Generation => (gen === 'a' ? 'b' : 'a');

// Conservative cap well under the ~2048-byte Android SecureStore limit, leaving
// headroom for the per-entry key/overhead the platform adds.
const DEFAULT_MAX_CHUNK_BYTES = 1800;

// Hard ceiling on how many chunks we'll ever read/delete. A real session is a
// handful of KB (a few chunks); anything beyond this is corruption, not data,
// and the bound stops a garbage count marker from spinning a huge loop.
const MAX_CHUNKS = 64;

/** UTF-8 byte length of a single code point (no allocation, deterministic). */
function codePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Split a string into pieces each no larger than `maxBytes` **UTF-8 bytes**,
 * never splitting a code point across a boundary (so reassembly is exact even
 * for multibyte content like a non-ASCII display name). An empty input yields a
 * single empty chunk so the round-trip of "" is still well defined.
 */
export function chunkByBytes(value: string, maxBytes: number = DEFAULT_MAX_CHUNK_BYTES): string[] {
  if (maxBytes < 4) {
    throw new Error('maxBytes must be at least 4 to fit any single code point');
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // for..of iterates by code point, so surrogate pairs stay intact.
  for (const char of value) {
    const charBytes = codePointByteLength(char.codePointAt(0) as number);
    if (currentBytes + charBytes > maxBytes && current !== '') {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  chunks.push(current);
  return chunks;
}

/**
 * Validate that a parsed value is a usable session before we hand it back.
 * Anything missing the tokens or the user id is treated as corrupt and dropped
 * (returns null upstream) rather than feeding a half-session into auth.
 */
function isValidSession(value: unknown): value is SupabaseAuthSession {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  if (typeof session.access_token !== 'string' || session.access_token === '') return false;
  if (typeof session.refresh_token !== 'string' || session.refresh_token === '') return false;
  if (typeof session.user !== 'object' || session.user === null) return false;
  const user = session.user as Record<string, unknown>;
  return typeof user.id === 'string' && user.id !== '';
}

export interface SecureSessionStoreOptions {
  backend: SecureKvBackend;
  /** Optional plaintext store to migrate from on first read after upgrade. */
  legacy?: LegacySessionSource;
  /** Override the per-chunk byte cap (tests use a tiny value to force chunking). */
  maxChunkBytes?: number;
}

export function createSecureSessionStore(options: SecureSessionStoreOptions): SecureSessionStore {
  const { backend, legacy, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES } = options;

  async function activeGeneration(): Promise<Generation | null> {
    const raw = await backend.getItem(ACTIVE_KEY);
    return raw === 'a' || raw === 'b' ? raw : null;
  }

  async function readGeneration(gen: Generation): Promise<SupabaseAuthSession | null> {
    const countRaw = await backend.getItem(countKey(gen));
    if (countRaw === null) return null;

    const count = Number.parseInt(countRaw, 10);
    if (!Number.isInteger(count) || count <= 0 || count > MAX_CHUNKS) return null;

    let serialized = '';
    for (let index = 0; index < count; index += 1) {
      const part = await backend.getItem(chunkKey(gen, index));
      // A missing chunk means a torn/partial write — treat the whole thing as
      // absent rather than parsing a truncated payload.
      if (part === null) return null;
      serialized += part;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return null;
    }
    return isValidSession(parsed) ? parsed : null;
  }

  async function readFromSecure(): Promise<SupabaseAuthSession | null> {
    const active = await activeGeneration();
    if (!active) return null;
    return readGeneration(active);
  }

  async function clearGeneration(gen: Generation): Promise<void> {
    const countRaw = await backend.getItem(countKey(gen));
    const count = countRaw === null ? 0 : Number.parseInt(countRaw, 10);
    await backend.deleteItem(countKey(gen));
    const upper = Number.isInteger(count) && count > 0 ? Math.min(count, MAX_CHUNKS) : 0;
    for (let index = 0; index < upper; index += 1) {
      await backend.deleteItem(chunkKey(gen, index));
    }
  }

  async function writeGeneration(gen: Generation, chunks: string[]): Promise<void> {
    // How many chunks this generation held before (e.g. from an interrupted
    // earlier write to it), so we can drop the longer tail and never read a
    // stale chunk back.
    const previousRaw = await backend.getItem(countKey(gen));
    const previousCount = previousRaw === null ? 0 : Number.parseInt(previousRaw, 10);

    for (let index = 0; index < chunks.length; index += 1) {
      await backend.setItem(chunkKey(gen, index), chunks[index]);
    }
    await backend.setItem(countKey(gen), String(chunks.length));

    if (Number.isInteger(previousCount)) {
      for (let index = chunks.length; index < previousCount && index < MAX_CHUNKS; index += 1) {
        await backend.deleteItem(chunkKey(gen, index));
      }
    }
  }

  async function writeToSecure(session: SupabaseAuthSession): Promise<void> {
    const serialized = JSON.stringify(session);
    const chunks = chunkByBytes(serialized, maxChunkBytes);
    if (chunks.length > MAX_CHUNKS) {
      // Practically unreachable for a real session, but never write a payload we
      // could not read back. Leave any existing session untouched.
      throw new Error(`session too large to persist (${chunks.length} chunks)`);
    }

    const active = await activeGeneration();
    const target = active ? otherGeneration(active) : 'a';

    // Write the whole new session into the INACTIVE generation. The active one is
    // left untouched, so a failure or app-kill anywhere in here leaves the
    // previous session fully readable — the pointer still names it.
    await writeGeneration(target, chunks);

    // Single-key flip = the atomic commit point. A torn write of one key yields
    // either the old or the new value, never a mix, so read() always resolves to
    // one complete generation, never a half-replaced blend of both.
    await backend.setItem(ACTIVE_KEY, target);

    // Retire the previous generation now that the pointer has moved off it.
    // Best-effort: if interrupted, the leftovers are simply ignored (the pointer
    // never names them) and overwritten the next time we target that generation.
    if (active) {
      await clearGeneration(active);
    }

    // Stamp the standalone real-account breadcrumb. Written AFTER the commit so
    // it can only claim a real account once one was actually persisted. An
    // anonymous session clears it (a later real→anon write means the durable
    // identity is no longer a real account).
    if (session.user.is_anonymous === false) {
      await backend.setItem(REAL_ACCOUNT_KEY, '1');
    } else {
      await backend.deleteItem(REAL_ACCOUNT_KEY);
    }
  }

  async function clearSecure(): Promise<void> {
    // Drop the pointer first so a half-finished clear never re-reads as present.
    await backend.deleteItem(ACTIVE_KEY);
    await clearGeneration('a');
    await clearGeneration('b');
    // Sign-out / account clear also drops the real-account breadcrumb so the
    // next lazy anonymous mint is not mistaken for a lost real session.
    await backend.deleteItem(REAL_ACCOUNT_KEY);
  }

  return {
    async read(): Promise<SupabaseAuthSession | null> {
      const fromSecure = await readFromSecure();
      if (fromSecure) {
        // Backfill the real-account breadcrumb for a session persisted by a build
        // that predates it. This read succeeded, but a real user upgraded from
        // such a build has no REAL_ACCOUNT_KEY until some later refresh/metadata
        // write happens — so if they hit a torn/absent read on a LATER launch
        // first, hadRealAccount() would be false and restoreSession would mint an
        // anonymous user again. Stamping it on a successful real read protects
        // already-upgraded installs immediately. Best-effort; keyed on
        // is_anonymous === false to match writeToSecure.
        if (fromSecure.user.is_anonymous === false) {
          try {
            await backend.setItem(REAL_ACCOUNT_KEY, '1');
          } catch {
            // A keystore hiccup just defers the backfill to the next read.
          }
        }
        return fromSecure;
      }

      // Nothing in secure storage — try a one-time migration from the legacy
      // plaintext store so an existing user isn't signed out by the upgrade.
      if (!legacy) return null;
      const legacySession = await legacy.read();
      if (!legacySession || !isValidSession(legacySession)) return null;

      try {
        await writeToSecure(legacySession);
        await legacy.clear();
      } catch {
        // Migration is best-effort: the session is still usable this run, and the
        // next launch retries (the plaintext copy is left in place until the
        // carry-over actually succeeds).
      }
      return legacySession;
    },

    async write(session: SupabaseAuthSession): Promise<void> {
      await writeToSecure(session);
    },

    async clear(): Promise<void> {
      await clearSecure();
      // Belt-and-suspenders: also wipe any legacy plaintext copy on sign-out.
      if (legacy) {
        await legacy.clear();
      }
    },

    async hadRealAccount(): Promise<boolean> {
      return (await backend.getItem(REAL_ACCOUNT_KEY)) === '1';
    },
  };
}
