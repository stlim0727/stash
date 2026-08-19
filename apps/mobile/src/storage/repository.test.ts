import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { Bookmark } from '@/domain/types';
import { repository } from '@/storage/repository';

/** Minimal in-memory localStorage shim so the web repository is testable under
 *  the Node runner (which has no DOM). The repository reads the `localStorage`
 *  global inside its methods, so installing this before `init` is enough. */
class MemoryStorage {
  private store = new Map<string, string>();
  failNextWriteTo: string | null = null;
  setItemCallCount = 0;
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.failNextWriteTo === key) {
      this.failNextWriteTo = null;
      throw new Error(`injected write failure: ${key}`);
    }
    this.setItemCallCount += 1;
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

let memoryStorage: MemoryStorage;
beforeEach(() => {
  memoryStorage = new MemoryStorage();
  (globalThis as unknown as { localStorage: unknown }).localStorage = memoryStorage;
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

test('clearAllData wipes library data but keeps meta (and never re-seeds)', async () => {
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  await repository.enqueue({
    local_id: 'local-1',
    remote_id: null,
    operation: 'create',
    payload: { url: 'https://example.com' },
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await repository.upsertEnrichments([
    {
      id: 'enr-1',
      bookmark_id: 'local-1',
      user_id: 'u',
      summary: null,
      topics: [],
      suggested_tags: [],
      suggested_collection_id: null,
      suggested_collection_name: null,
      model: null,
      status: 'complete',
      confidence: null,
      degraded: false,
      degraded_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]);
  await repository.replaceTagData({
    tags: [
      { id: 't1', user_id: 'u', name: 'tag', slug: 'tag', source: 'user', created_at: '2026' },
    ],
    bookmarkTags: [
      { bookmark_id: 'local-1', tag_id: 't1', source: 'user', confidence: null, created_at: '2026' },
    ],
    collections: [],
  });
  await repository.setMeta('some-key', 'kept');

  await repository.clearAllData();

  assert.equal((await repository.listBookmarks()).length, 0);
  assert.equal((await repository.listQueue()).length, 0);
  assert.equal((await repository.listEnrichments()).length, 0);
  const tagData = await repository.listTagData();
  assert.equal(tagData.tags.length, 0);
  assert.equal(tagData.bookmarkTags.length, 0);
  // Meta is deliberately untouched — the store owns resetting its own keys.
  assert.equal(await repository.getMeta('some-key'), 'kept');

  // The seeded marker must survive the wipe: a re-init after a library reset
  // (e.g. the next app launch) must come up empty, not re-seed sample data.
  await repository.init([makeBookmark('seed-1')]);
  assert.equal(
    (await repository.listBookmarks()).length,
    0,
    'a post-reset init must not re-seed',
  );
});

test('upsertBookmarks replaces existing rows and adds new ones in a single write (Sentry STASH-5X)', async () => {
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  await repository.insertBookmark(makeBookmark('local-2'));

  const updatedLocal1 = { ...makeBookmark('local-1'), title: 'Updated title' };
  memoryStorage.setItemCallCount = 0;
  await repository.upsertBookmarks!([updatedLocal1, makeBookmark('remote-3')]);

  // One localStorage write for the whole batch, not one per bookmark — this
  // is what prevents the O(rows) full-array re-serialize that froze the JS
  // thread for 15+ seconds reconciling a large pull.
  assert.equal(memoryStorage.setItemCallCount, 1);

  const all = await repository.listBookmarks();
  assert.equal(all.length, 3);
  const byId = new Map(all.map((bookmark) => [bookmark.id, bookmark]));
  assert.equal(byId.get('local-1')?.title, 'Updated title');
  assert.ok(byId.has('local-2'));
  assert.ok(byId.has('remote-3'));
});

test('upsertBookmarks dedupes a batch with two entries sharing a new id', async () => {
  await repository.init([]);

  const first = makeBookmark('new-1');
  const second = { ...makeBookmark('new-1'), title: 'Second copy wins' };
  await repository.upsertBookmarks!([first, second]);

  const all = await repository.listBookmarks();
  assert.equal(all.length, 1, 'two entries sharing an id must land as one row, not two');
  assert.equal(all[0]?.title, 'Second copy wins');
});

test('upsertBookmarks is a no-op for an empty batch', async () => {
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  memoryStorage.setItemCallCount = 0;

  await repository.upsertBookmarks!([]);

  assert.equal(memoryStorage.setItemCallCount, 0);
  assert.equal((await repository.listBookmarks()).length, 1);
});

test('deleteBookmarks removes exactly the given ids in a single write (Sentry STASH-5X)', async () => {
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  await repository.insertBookmark(makeBookmark('local-2'));
  await repository.insertBookmark(makeBookmark('local-3'));

  memoryStorage.setItemCallCount = 0;
  await repository.deleteBookmarks!(['local-1', 'local-3']);

  assert.equal(memoryStorage.setItemCallCount, 1);
  const remaining = await repository.listBookmarks();
  assert.deepEqual(
    remaining.map((bookmark) => bookmark.id).sort(),
    ['local-2'],
  );
});

test('deleteBookmarks is a no-op for an empty batch', async () => {
  await repository.init([]);
  await repository.insertBookmark(makeBookmark('local-1'));
  memoryStorage.setItemCallCount = 0;

  await repository.deleteBookmarks!([]);

  assert.equal(memoryStorage.setItemCallCount, 0);
  assert.equal((await repository.listBookmarks()).length, 1);
});

test('an interrupted web identity rekey is completed from its commit journal on reload', async () => {
  const old = makeBookmark('old-id');
  await repository.init([]);
  await repository.insertBookmark(old);
  const rehomed = { ...old, id: 'new-id', sync_status: 'pending' as const };
  const entry = {
    local_id: 'new-id',
    remote_id: null,
    operation: 'create' as const,
    payload: { id: 'new-id', url: old.url ?? undefined },
    sync_status: 'pending' as const,
    retry_count: 0,
    last_error: null,
    created_at: old.created_at,
    updated_at: old.updated_at,
  };

  memoryStorage.failNextWriteTo = 'stash.bookmarks';
  await assert.rejects(
    repository.replaceBookmarkIdentities!(
      [{ previousId: old.id, bookmark: rehomed }],
      [entry],
      {
        metaUpdates: { pending_import_collections: '[{"bookmark_id":"new-id"}]' },
        tagData: { tags: [], bookmarkTags: [], collections: [] },
      },
    ),
    /injected write failure/,
  );

  await repository.init([]);
  assert.deepEqual((await repository.listBookmarks()).map((bookmark) => bookmark.id), [
    'new-id',
  ]);
  assert.deepEqual((await repository.listQueue()).map((queued) => queued.local_id), [
    'new-id',
  ]);
  assert.equal(
    await repository.getMeta('pending_import_collections'),
    '[{"bookmark_id":"new-id"}]',
  );
});

test('replaceBookmarkIdentities drops an EXISTING queue entry under the OLD id, in the same atomic write (P1, round 8)', async () => {
  // A rehomed row can already have an active `create` queue entry under its
  // OLD id (e.g. an image upload landed but createBookmark never confirmed —
  // see staleUploadedImageRows in sync/account-transition.ts). Leaving that
  // entry behind — even as a "removed in a separate follow-up call" step —
  // risks it surviving a crash/reload between the two calls and retrying
  // under the OLD id in parallel with the new entry, which can collide on a
  // primary key if a real cloud row already exists under that id owned by a
  // different account. It must be gone the instant this call resolves.
  const old = makeBookmark('old-id');
  await repository.init([]);
  await repository.insertBookmark(old);
  await repository.enqueue({
    local_id: 'old-id',
    remote_id: null,
    operation: 'create',
    payload: { id: 'old-id', content_type: 'image' },
    sync_status: 'failed',
    retry_count: 2,
    last_error: 'stale',
    created_at: old.created_at,
    updated_at: old.updated_at,
  });

  const rehomed = { ...old, id: 'new-id', sync_status: 'pending' as const };
  await repository.replaceBookmarkIdentities!(
    [{ previousId: old.id, bookmark: rehomed }],
    [
      {
        local_id: 'new-id',
        remote_id: null,
        operation: 'create',
        payload: { id: 'new-id', content_type: 'image' },
        sync_status: 'pending',
        retry_count: 0,
        last_error: null,
        created_at: old.created_at,
        updated_at: old.updated_at,
      },
    ],
    { metaUpdates: {}, tagData: { tags: [], bookmarkTags: [], collections: [] } },
  );

  const queueIds = (await repository.listQueue()).map((queued) => queued.local_id);
  assert.deepEqual(queueIds, ['new-id']);
});
