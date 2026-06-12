import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';

/**
 * Web/dev fallback store. Uses localStorage when available so bookmarks
 * survive reloads in the browser; falls back to memory during static
 * rendering where no storage API exists. Native platforms resolve
 * repository.native.ts instead.
 */

const BOOKMARKS_KEY = 'stash.bookmarks';
const QUEUE_KEY = 'stash.queue';
const SEEDED_KEY = 'stash.seeded';

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

class WebBookmarkRepository implements BookmarkRepository {
  private bookmarks: Bookmark[] = [];
  private queue: LocalPendingBookmark[] = [];

  private read<T>(key: string, fallback: T): T {
    if (!storageAvailable()) {
      return fallback;
    }
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }

  private write(key: string, value: unknown): void {
    if (storageAvailable()) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  async init(seed: Bookmark[]): Promise<void> {
    const seeded = storageAvailable() && localStorage.getItem(SEEDED_KEY) === '1';
    this.bookmarks = this.read<Bookmark[]>(BOOKMARKS_KEY, []);
    this.queue = this.read<LocalPendingBookmark[]>(QUEUE_KEY, []);
    if (!seeded) {
      this.bookmarks = [...seed];
      this.write(BOOKMARKS_KEY, this.bookmarks);
      this.write(SEEDED_KEY, '1');
    }
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return [...this.bookmarks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async insertBookmark(bookmark: Bookmark): Promise<void> {
    this.bookmarks = [
      bookmark,
      ...this.bookmarks.filter((existing) => existing.id !== bookmark.id),
    ];
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  async updateBookmark(bookmark: Bookmark): Promise<void> {
    this.bookmarks = this.bookmarks.map((existing) =>
      existing.id === bookmark.id ? bookmark : existing,
    );
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  async replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void> {
    this.bookmarks = this.bookmarks.map((existing) =>
      existing.id === previousId ? bookmark : existing,
    );
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  async deleteBookmark(id: string): Promise<void> {
    this.bookmarks = this.bookmarks.filter((existing) => existing.id !== id);
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  async listQueue(): Promise<LocalPendingBookmark[]> {
    return [...this.queue];
  }

  async enqueue(entry: LocalPendingBookmark): Promise<void> {
    this.queue = [...this.queue.filter((existing) => existing.local_id !== entry.local_id), entry];
    this.write(QUEUE_KEY, this.queue);
  }

  async updateQueueEntry(entry: LocalPendingBookmark): Promise<void> {
    await this.enqueue(entry);
  }

  async removeQueueEntry(localId: string): Promise<void> {
    this.queue = this.queue.filter((existing) => existing.local_id !== localId);
    this.write(QUEUE_KEY, this.queue);
  }
}

export const repository: BookmarkRepository = new WebBookmarkRepository();
