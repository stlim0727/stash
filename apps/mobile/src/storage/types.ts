import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  LocalPendingBookmark,
  Tag,
} from '@/domain/types';

/** Snapshot of the user's organizational data, refreshed by pull sync. */
export interface TagData {
  tags: Tag[];
  bookmarkTags: BookmarkTag[];
  collections: Collection[];
}

export interface CreateSyncCompletion {
  bookmark: Bookmark;
  entry: LocalPendingBookmark;
  /**
   * Present when this create resolved as a server-side duplicate of an
   * existing different row (STASH-3Q): `bookmark.id` is that existing row's
   * id, and this is the id the local row was captured under (never actually
   * created server-side) — the caller must delete that phantom row as part
   * of the same atomic batch, or it lingers as a permanent duplicate.
   */
  originalLocalId?: string;
}

/**
 * Durable local storage contract for bookmarks and the offline sync queue.
 *
 * Platform implementations:
 * - repository.native.ts — SQLite via expo-sqlite (iOS/Android).
 * - repository.ts — localStorage-backed fallback (web/dev), memory during
 *   static rendering.
 */
export interface BookmarkRepository {
  /**
   * Prepare storage and seed sample data exactly once on first run. The
   * optional tag-data and enrichment seeds let the sample bookmarks demo as
   * fully-synced cloud rows (collection assignable, AI summary present) rather
   * than relying on in-memory fallbacks.
   */
  init(seed: Bookmark[], seedTagData?: TagData, seedEnrichments?: AIEnrichment[]): Promise<void>;
  listBookmarks(): Promise<Bookmark[]>;
  getBookmark(id: string): Promise<Bookmark | null>;
  insertBookmark(bookmark: Bookmark): Promise<void>;
  updateBookmark(bookmark: Bookmark): Promise<void>;
  /** Atomically swap a row's identity, e.g. local ID -> remote ID after sync. */
  replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void>;
  /**
   * Atomically finish a bulk create chunk: each bookmark's updated fields
   * (sync_status, ever_synced, etc.) and its completed create queue row are
   * persisted together, along with deleting the phantom old-id row for any
   * completion whose create resolved as a server-side duplicate (see
   * CreateSyncCompletion.originalLocalId).
   */
  completeCreateSyncBatch?(completions: CreateSyncCompletion[]): Promise<void>;
  /**
   * Atomically insert a batch of imported bookmarks and their pending create queue
   * entries in a single transaction (Sentry STASH-3S / STASH-3T).
   */
  insertImportBatch?(bookmarks: Bookmark[], entries: LocalPendingBookmark[]): Promise<void>;
  deleteBookmark(id: string): Promise<void>;
  listQueue(): Promise<LocalPendingBookmark[]>;
  enqueue(entry: LocalPendingBookmark): Promise<void>;
  updateQueueEntry(entry: LocalPendingBookmark): Promise<void>;
  removeQueueEntry(localId: string): Promise<void>;
  /** Small durable key/value store (e.g. the pull watermark). */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** Local cache of cloud AI enrichments, refreshed by pull sync. */
  listEnrichments(): Promise<AIEnrichment[]>;
  upsertEnrichments(enrichments: AIEnrichment[]): Promise<void>;
  deleteEnrichment(bookmarkId: string): Promise<void>;
  /** Local cache of tags/links/collections; replaced wholesale by pull sync. */
  listTagData(): Promise<TagData>;
  replaceTagData(data: TagData): Promise<void>;
  /**
   * Wipe all locally-stored library data at once: bookmarks, the sync queue,
   * cached enrichments, and tag/link/collection data. Meta keys are left
   * untouched — the caller (the store's library reset) owns resetting the meta
   * it manages (watermark, pending tag ops, AI bookkeeping), and the seeded
   * flag must survive so a reset never re-seeds sample data.
   */
  clearAllData(): Promise<void>;
}
