import type { Bookmark, LocalPendingBookmark } from '@/domain/types';

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
  listQueue(): Promise<LocalPendingBookmark[]>;
  enqueue(entry: LocalPendingBookmark): Promise<void>;
  updateQueueEntry(entry: LocalPendingBookmark): Promise<void>;
}
