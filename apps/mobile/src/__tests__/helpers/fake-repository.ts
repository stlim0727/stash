import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';

export interface FakeRepositoryModule {
  repository: BookmarkRepository;
  /** Test hook: reset state, optionally pre-seeding stored bookmarks/tag data/enrichments. */
  __reset: (rows?: Bookmark[], seedTagData?: TagData, seedEnrichments?: AIEnrichment[]) => void;
  __queue: () => LocalPendingBookmark[];
  /** Test hook: read the current stored bookmark rows (e.g. to assert collection_id). */
  __bookmarks: () => Bookmark[];
  __listBookmarksCalls: () => number;
  __getBookmarkCalls: () => number;
  __meta: (key: string) => string | null;
  /** Test hook: pre-seed a durable meta value (e.g. the unseen-suggestions set). */
  __setMeta: (key: string, value: string) => void;
}

/**
 * In-memory BookmarkRepository for component tests. Mirrors the web
 * implementation's semantics without any storage APIs.
 */
export function createFakeRepositoryModule(): FakeRepositoryModule {
  let bookmarks: Bookmark[] = [];
  let queue: LocalPendingBookmark[] = [];
  let enrichments: AIEnrichment[] = [];
  let tagData: TagData = { tags: [], bookmarkTags: [], collections: [] };
  let meta: Record<string, string> = {};
  let listBookmarksCalls = 0;
  let getBookmarkCalls = 0;

  const repository: BookmarkRepository = {
    init: async () => {},
    listBookmarks: async () => {
      listBookmarksCalls += 1;
      return [...bookmarks];
    },
    getBookmark: async (id) => {
      getBookmarkCalls += 1;
      return bookmarks.find((bookmark) => bookmark.id === id) ?? null;
    },
    insertBookmark: async (bookmark) => {
      bookmarks = [bookmark, ...bookmarks.filter((b) => b.id !== bookmark.id)];
    },
    updateBookmark: async (bookmark) => {
      bookmarks = bookmarks.map((b) => (b.id === bookmark.id ? bookmark : b));
    },
    replaceBookmark: async (previousId, bookmark) => {
      // Mirror the real repositories: rename previousId AND collapse any row
      // already under the destination id (a remote twin a pull inserted), so the
      // fake reflects durable state, not just the in-memory array.
      bookmarks = bookmarks
        .filter((b) => b.id === previousId || b.id !== bookmark.id)
        .map((b) => (b.id === previousId ? bookmark : b));
    },
    completeCreateSyncBatch: async (completions) => {
      for (const { previousId, bookmark, entry } of completions) {
        const stored = queue.find((queued) => queued.local_id === entry.local_id);
        if (
          !stored ||
          stored.operation !== entry.operation ||
          stored.updated_at !== entry.updated_at
        ) {
          continue;
        }
        bookmarks = bookmarks
          .filter((b) => b.id === previousId || b.id !== bookmark.id)
          .map((b) => (b.id === previousId ? bookmark : b));
        queue = queue.filter((queued) => queued.local_id !== entry.local_id);
      }
    },
    deleteBookmark: async (id) => {
      bookmarks = bookmarks.filter((b) => b.id !== id);
    },
    listQueue: async () => [...queue],
    enqueue: async (entry) => {
      queue = [...queue.filter((q) => q.local_id !== entry.local_id), entry];
    },
    updateQueueEntry: async (entry) => {
      queue = [...queue.filter((q) => q.local_id !== entry.local_id), entry];
    },
    removeQueueEntry: async (localId) => {
      queue = queue.filter((q) => q.local_id !== localId);
    },
    getMeta: async (key) => meta[key] ?? null,
    setMeta: async (key, value) => {
      meta = { ...meta, [key]: value };
    },
    listEnrichments: async () => [...enrichments],
    upsertEnrichments: async (rows) => {
      const ids = new Set(rows.map((row) => row.id));
      enrichments = [...enrichments.filter((row) => !ids.has(row.id)), ...rows];
    },
    deleteEnrichment: async (bookmarkId) => {
      enrichments = enrichments.filter((row) => row.bookmark_id !== bookmarkId);
    },
    listTagData: async () => tagData,
    replaceTagData: async (data) => {
      tagData = data;
    },
    clearAllData: async () => {
      bookmarks = [];
      queue = [];
      enrichments = [];
      tagData = { tags: [], bookmarkTags: [], collections: [] };
    },
  };

  return {
    repository,
    __reset: (rows: Bookmark[] = [], seedTagData?: TagData, seedEnrichments: AIEnrichment[] = []) => {
      bookmarks = [...rows];
      queue = [];
      enrichments = [...seedEnrichments];
      tagData = seedTagData ?? { tags: [], bookmarkTags: [], collections: [] };
      meta = {};
      listBookmarksCalls = 0;
      getBookmarkCalls = 0;
    },
    __queue: () => [...queue],
    __bookmarks: () => [...bookmarks],
    __listBookmarksCalls: () => listBookmarksCalls,
    __getBookmarkCalls: () => getBookmarkCalls,
    __meta: (key: string) => meta[key] ?? null,
    __setMeta: (key: string, value: string) => {
      meta = { ...meta, [key]: value };
    },
  };
}

export function makeEnrichment(overrides: Partial<AIEnrichment> = {}): AIEnrichment {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: 'enrichment-test-1',
    bookmark_id: '7e64cf1e-0000-4000-8000-000000000001',
    user_id: 'user-test',
    summary: null,
    topics: [],
    suggested_tags: [],
    suggested_collection_id: null,
    suggested_collection_name: null,
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
    degraded: false,
    degraded_reason: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function makeStoredBookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  const now = '2026-06-12T00:00:00.000Z';
  return {
    id: '7e64cf1e-0000-4000-8000-000000000001',
    user_id: 'user-test',
    url: 'https://example.com/stored',
    canonical_url: null,
    url_hash: 'https://example.com/stored',
    title: 'Stored bookmark',
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
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}
