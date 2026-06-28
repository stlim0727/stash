import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chunkByBytes,
  createSecureSessionStore,
  type LegacySessionSource,
  type SecureKvBackend,
} from './secure-session-core.ts';
import type { SupabaseAuthSession } from './types.ts';

// --- Test doubles ------------------------------------------------------------

/** In-memory secure backend with optional fault injection. */
class FakeBackend implements SecureKvBackend {
  readonly store = new Map<string, string>();
  getCalls: string[] = [];
  failSetForKey: string | null = null;

  async getItem(key: string): Promise<string | null> {
    this.getCalls.push(key);
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.failSetForKey !== null && key === this.failSetForKey) {
      throw new Error(`injected setItem failure for ${key}`);
    }
    this.store.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class FakeLegacySource implements LegacySessionSource {
  readCalls = 0;
  cleared = false;
  failClear = false;

  constructor(private session: SupabaseAuthSession | null) {}

  async read(): Promise<SupabaseAuthSession | null> {
    this.readCalls += 1;
    return this.session;
  }

  async clear(): Promise<void> {
    if (this.failClear) throw new Error('injected legacy clear failure');
    this.cleared = true;
    this.session = null;
  }
}

function makeSession(overrides: Partial<SupabaseAuthSession> = {}): SupabaseAuthSession {
  return {
    access_token: 'access-token-abc',
    refresh_token: 'refresh-token-xyz',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1_900_000_000,
    user: { id: 'user-123', email: 'a@b.com', is_anonymous: false },
    ...overrides,
  };
}

// --- chunkByBytes ------------------------------------------------------------

test('chunkByBytes returns a single empty chunk for an empty string', () => {
  assert.deepEqual(chunkByBytes('', 1800), ['']);
});

test('chunkByBytes keeps a short string in one chunk', () => {
  assert.deepEqual(chunkByBytes('hello', 1800), ['hello']);
});

test('chunkByBytes splits ASCII at the byte boundary and rejoins exactly', () => {
  const value = 'abcdefghij'; // 10 bytes
  const chunks = chunkByBytes(value, 4);
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij']);
  assert.equal(chunks.join(''), value);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 4);
  }
});

test('chunkByBytes never splits a multibyte code point across chunks', () => {
  // Each emoji is 4 UTF-8 bytes; a Korean syllable is 3 bytes.
  const value = '😀😀가나다😀';
  const maxBytes = 5;
  const chunks = chunkByBytes(value, maxBytes);
  assert.equal(chunks.join(''), value);
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk, 'utf8') <= maxBytes,
      `chunk "${chunk}" exceeds ${maxBytes} bytes`,
    );
    // Re-encoding must be lossless — proof no surrogate pair was severed.
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk);
  }
});

test('chunkByBytes rejects an unusably small limit', () => {
  assert.throws(() => chunkByBytes('x', 3), /at least 4/);
});

// --- round-trip --------------------------------------------------------------

test('write then read returns an equivalent session', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  const session = makeSession();

  await store.write(session);
  const read = await store.read();

  assert.deepEqual(read, session);
});

test('a large session is split across multiple chunks and reassembled', async () => {
  const backend = new FakeBackend();
  // Tiny cap forces many chunks for a normal-size session.
  const store = createSecureSessionStore({ backend, maxChunkBytes: 16 });
  const session = makeSession({
    access_token: 'A'.repeat(500),
    user: { id: 'user-123', full_name: '가나다라마바사', email: 'long@example.com' } as never,
  });

  await store.write(session);

  const count = Number.parseInt(backend.store.get('supabase.auth.session.v2.count') as string, 10);
  assert.ok(count > 1, `expected multiple chunks, got ${count}`);
  assert.deepEqual(await store.read(), session);
});

test('read returns null when nothing is stored', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  assert.equal(await store.read(), null);
});

// --- corruption / partial data ----------------------------------------------

test('read returns null when a chunk is missing (torn write)', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend, maxChunkBytes: 16 });
  await store.write(makeSession({ access_token: 'A'.repeat(200) }));

  // Drop a middle chunk but leave the count marker claiming it exists.
  backend.store.delete('supabase.auth.session.v2.1');
  assert.equal(await store.read(), null);
});

test('read returns null on an invalid count marker', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  backend.store.set('supabase.auth.session.v2.count', 'not-a-number');
  assert.equal(await store.read(), null);

  backend.store.set('supabase.auth.session.v2.count', '0');
  assert.equal(await store.read(), null);

  backend.store.set('supabase.auth.session.v2.count', '9999');
  assert.equal(await store.read(), null);
});

test('read returns null when the payload is not valid JSON', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  backend.store.set('supabase.auth.session.v2.count', '1');
  backend.store.set('supabase.auth.session.v2.0', '{ not json');
  assert.equal(await store.read(), null);
});

test('read rejects a structurally invalid session (missing refresh_token)', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  const broken = { access_token: 'a', token_type: 'bearer', user: { id: 'u' } };
  backend.store.set('supabase.auth.session.v2.count', '1');
  backend.store.set('supabase.auth.session.v2.0', JSON.stringify(broken));
  assert.equal(await store.read(), null);
});

test('read rejects a session whose user has no id', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend });
  const broken = { access_token: 'a', refresh_token: 'r', user: {} };
  backend.store.set('supabase.auth.session.v2.count', '1');
  backend.store.set('supabase.auth.session.v2.0', JSON.stringify(broken));
  assert.equal(await store.read(), null);
});

// --- overwrite / clear -------------------------------------------------------

test('overwriting with a shorter payload leaves no orphan chunks', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend, maxChunkBytes: 16 });

  await store.write(makeSession({ access_token: 'A'.repeat(400) }));
  const longCount = Number.parseInt(
    backend.store.get('supabase.auth.session.v2.count') as string,
    10,
  );

  await store.write(makeSession({ access_token: 'B' }));
  const shortCount = Number.parseInt(
    backend.store.get('supabase.auth.session.v2.count') as string,
    10,
  );

  assert.ok(shortCount < longCount);
  // No chunk index at or beyond the new count should survive.
  for (let i = shortCount; i < longCount; i += 1) {
    assert.equal(backend.store.has(`supabase.auth.session.v2.${i}`), false);
  }
  assert.deepEqual(await store.read(), makeSession({ access_token: 'B' }));
});

test('clear removes the count marker and every chunk', async () => {
  const backend = new FakeBackend();
  const store = createSecureSessionStore({ backend, maxChunkBytes: 16 });
  await store.write(makeSession({ access_token: 'A'.repeat(200) }));

  await store.clear();

  assert.equal(backend.store.size, 0);
  assert.equal(await store.read(), null);
});

// --- legacy migration --------------------------------------------------------

test('read migrates a legacy plaintext session into secure storage and wipes it', async () => {
  const backend = new FakeBackend();
  const legacySession = makeSession({ refresh_token: 'legacy-refresh' });
  const legacy = new FakeLegacySource(legacySession);
  const store = createSecureSessionStore({ backend, legacy });

  const first = await store.read();
  assert.deepEqual(first, legacySession);
  assert.equal(legacy.cleared, true, 'plaintext copy should be wiped after carry-over');

  // It now lives in secure storage, and a second read does not touch legacy again.
  const second = await store.read();
  assert.deepEqual(second, legacySession);
  assert.equal(legacy.readCalls, 1, 'legacy should only be read once');
});

test('read does not migrate when the legacy session is invalid', async () => {
  const backend = new FakeBackend();
  const legacy = new FakeLegacySource({ access_token: 'a' } as never);
  const store = createSecureSessionStore({ backend, legacy });

  assert.equal(await store.read(), null);
  assert.equal(legacy.cleared, false);
  assert.equal(backend.store.size, 0, 'nothing should be written for an invalid legacy session');
});

test('a session in secure storage takes precedence over legacy (no migration read)', async () => {
  const backend = new FakeBackend();
  const legacy = new FakeLegacySource(makeSession({ refresh_token: 'stale-legacy' }));
  const store = createSecureSessionStore({ backend, legacy });

  const current = makeSession({ refresh_token: 'current' });
  await store.write(current);

  assert.deepEqual(await store.read(), current);
  assert.equal(legacy.readCalls, 0, 'legacy must not be consulted when secure storage has a session');
});

test('migration still returns the session when persisting it fails', async () => {
  const backend = new FakeBackend();
  // The first chunk write fails, so the carry-over can't be persisted.
  backend.failSetForKey = 'supabase.auth.session.v2.0';
  const legacySession = makeSession({ refresh_token: 'legacy-refresh' });
  const legacy = new FakeLegacySource(legacySession);
  const store = createSecureSessionStore({ backend, legacy });

  // Auth is not blocked: the session is still returned for this run...
  assert.deepEqual(await store.read(), legacySession);
  // ...and the plaintext copy is preserved so the next launch can retry.
  assert.equal(legacy.cleared, false);
});

test('clear also wipes the legacy plaintext copy', async () => {
  const backend = new FakeBackend();
  const legacy = new FakeLegacySource(makeSession());
  const store = createSecureSessionStore({ backend, legacy });

  await store.write(makeSession());
  await store.clear();

  assert.equal(legacy.cleared, true);
});
