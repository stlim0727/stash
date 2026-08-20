import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPullAttemptDiagnostics,
  PULL_DIAGNOSTICS_PREF_KEY,
  serializePullDiagnosticsHistory,
} from '@/domain/pull-diagnostics';
import { repository } from '@/storage/repository';
import { getPullDiagnostics, hydratePullDiagnostics } from '@/sync/pull-diagnostics';

/**
 * Regression coverage for a real startup-ordering bug (Codex review on
 * STASH pull-diagnostics): on the WEB repository (`storage/repository.ts`),
 * `getMeta` only reads an in-memory map that `init()` itself populates from
 * `localStorage` — so hydrating this module before `repository.init()` has
 * run reads an empty map and silently fails to restore the persisted
 * history, even though it durably exists on disk. `app/_layout.tsx` fixes
 * this by sequencing `hydratePullDiagnostics()` after `ensureRepositoryReady()`
 * (exported from `store/bookmarks.tsx` for exactly this).
 *
 * This exercises the REAL web repository singleton (not a fake), with the
 * same in-memory `localStorage` shim `storage/repository.test.ts` uses,
 * because the bug is specific to that repository's actual init/getMeta
 * contract — a fake repository (as used elsewhere in this test suite) would
 * not reproduce it. `_layout.tsx` itself (React/expo-router wiring) is not
 * exercised here; this pins the underlying contract the fix depends on.
 */

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

function installFreshLocalStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = storage;
  return storage;
}

function seedPersistedHistory(storage: MemoryStorage): void {
  const history = [
    buildPullAttemptDiagnostics({
      since: '2026-08-01T00:00:00.000Z',
      fullRefreshReason: null,
      remoteRowCount: 4,
      outcome: 'success',
      durationMs: 120,
    }),
  ];
  storage.setItem(
    'stash.meta',
    JSON.stringify({ [PULL_DIAGNOSTICS_PREF_KEY]: serializePullDiagnosticsHistory(history) }),
  );
}

test('hydrating BEFORE repository.init() cannot see the persisted history on web (the bug the startup sequencing avoids)', async () => {
  const storage = installFreshLocalStorage();
  seedPersistedHistory(storage);

  // Deliberately NOT calling repository.init() first.
  await hydratePullDiagnostics();

  assert.deepEqual(getPullDiagnostics(), []);
});

test('hydrating AFTER repository.init() restores the persisted history on web', async () => {
  const storage = installFreshLocalStorage();
  seedPersistedHistory(storage);

  await repository.init([]);
  await hydratePullDiagnostics();

  const history = getPullDiagnostics();
  assert.equal(history.length, 1);
  assert.equal(history[0]?.remoteRowCount, 4);
  assert.equal(history[0]?.outcome, 'success');
});
