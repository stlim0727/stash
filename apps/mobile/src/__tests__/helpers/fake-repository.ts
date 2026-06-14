import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';

export interface FakeRepositoryModule {
  repository: BookmarkRepository;
  /** Test hook: reset state, optionally pre-seeding stored bookmarks/tag data/enrichments. */
  __reset: (rows?: Bookmark[], seedTagData?: TagData, seedEnrichments?: AIEnrichment[]) => void;
  __queue: () => LocalPendingBookmark[];
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

  const repository: BookmarkRepository = {
    init: async () => {},
    listBookmarks: async () => [...bookmarks],
    insertBookmark: async (bookmark) => {
      bookmarks = [bookmark, ...bookmarks.filter((b) => b.id !== bookmark.id)];
    },
    updateBookmark: async (bookmark) => {
      bookmarks = bookmarks.map((b) => (b.id === bookmark.id ? bookmark : b));
    },
    replaceBookmark: async (previousId, bookmark) => {
      bookmarks = bookmarks.map((b) => (b.id === previousId ? bookmark : b));
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
    listTagData: async () => tagData,
    replaceTagData: async (data) => {
      tagData = data;
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
    },
    __queue: () => [...queue],
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
    model: 'dummy-v0',
    status: 'complete',
    confidence: null,
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
    created_at: now,
    updated_at: now,
    last_saved_at: now,
    metadata_status: 'complete',
    sync_status: 'synced',
    ...overrides,
  };
}
