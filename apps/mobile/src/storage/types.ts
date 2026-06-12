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

/**
 * Durable local storage contract for bookmarks and the offline sync queue.
 *
 * Platform implementations:
 * - repository.native.ts — SQLite via expo-sqlite (iOS/Android).
 * - repository.ts — localStorage-backed fallback (web/dev), memory during
 *   static rendering.
 */
export interface BookmarkRepository {
  /** Prepare storage and seed sample data exactly once on first run. */
  init(seed: Bookmark[]): Promise<void>;
  listBookmarks(): Promise<Bookmark[]>;
  insertBookmark(bookmark: Bookmark): Promise<void>;
  updateBookmark(bookmark: Bookmark): Promise<void>;
  /** Atomically swap a row's identity, e.g. local ID -> remote ID after sync. */
  replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void>;
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
  /** Local cache of tags/links/collections; replaced wholesale by pull sync. */
  listTagData(): Promise<TagData>;
  replaceTagData(data: TagData): Promise<void>;
}
