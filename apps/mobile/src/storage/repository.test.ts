import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { Bookmark } from '@/domain/types';
import { repository } from '@/storage/repository';

/** Minimal in-memory localStorage shim so the web repository is testable under
 *  the Node runner (which has no DOM). The repository reads the `localStorage`
 *  global inside its methods, so installing this before `init` is enough. */
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

beforeEach(() => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = new MemoryStorage();
});

function makeBookmark(id: string): Bookmark {
  const now = new Date().toISOString();
  return {
    id,
    user_id: 'u',
    url: 'https://example.com',
    canonical_url: null,
    url_hash: 'example.com',
    title: 'Example',
    description: null,
    notes: null,
    source_app: null,
    content_type: 'url',
    preview_image_url: null,
    favicon_url: null,
    site_name: null,
    collection_id: null,
    is_archived: false,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'pending',
    sync_status: 'pending',
  };
}

test('a saved bookmark survives a reload (re-init does not re-seed over it)', async () => {
  // First launch: init with an empty seed, then the user saves a bookmark.
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  assert.equal((await repository.listBookmarks()).length, 1);

  // Second launch (a web refresh): init re-reads the same localStorage. The seed
  // marker must be recognized so it does NOT wipe the persisted bookmark with the
  // empty seed — the "bookmarks disappear after refresh" regression, which fired
  // because the marker was written JSON-encoded ("1") but read back raw (=== '1').
  await repository.init([]);
  const reloaded = await repository.listBookmarks();
  assert.equal(reloaded.length, 1, 'bookmark should survive the reload');
  assert.equal(reloaded[0].id, 'local-1');
});
