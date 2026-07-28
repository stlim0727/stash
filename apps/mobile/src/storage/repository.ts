import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';

/**
 * Web/dev fallback store. Uses localStorage when available so bookmarks
 * survive reloads in the browser; falls back to memory during static
 * rendering where no storage API exists. Native platforms resolve
 * repository.native.ts instead.
 */

const BOOKMARKS_KEY = 'stash.bookmarks';
const QUEUE_KEY = 'stash.queue';
const SEEDED_KEY = 'stash.seeded';
const META_KEY = 'stash.meta';
const ENRICHMENTS_KEY = 'stash.enrichments';
const TAG_DATA_KEY = 'stash.tagData';

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

class WebBookmarkRepository implements BookmarkRepository {
  private bookmarks: Bookmark[] = [];
  private queue: LocalPendingBookmark[] = [];
  private meta: Record<string, string> = {};
  private enrichments: AIEnrichment[] = [];
  private tagData: TagData = EMPTY_TAG_DATA;

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

  async init(
    seed: Bookmark[],
    seedTagData?: TagData,
    seedEnrichments?: AIEnrichment[],
  ): Promise<void> {
    // Read the flag through the same helper `write` mirrors: the marker is
    // persisted with `write` (which JSON.stringifies, storing `"1"`), so a raw
    // `getItem(...) === '1'` never matched — the seed check always failed and
    // every reload re-seeded, overwriting saved bookmarks with the empty seed
    // (the "bookmarks disappear after refresh" bug on web). `read` JSON-parses,
    // so an already-persisted `"1"` reads back as '1' and no re-wipe occurs.
    const seeded = this.read<string | null>(SEEDED_KEY, null) === '1';
    this.bookmarks = this.read<Bookmark[]>(BOOKMARKS_KEY, []);
    // Entries persisted before mutation sync lack the operation field.
    this.queue = this.read<LocalPendingBookmark[]>(QUEUE_KEY, []).map((entry) => ({
      ...entry,
      operation: entry.operation ?? 'create',
    }));
    this.meta = this.read<Record<string, string>>(META_KEY, {});
    this.enrichments = this.read<AIEnrichment[]>(ENRICHMENTS_KEY, []);
    this.tagData = this.read<TagData>(TAG_DATA_KEY, EMPTY_TAG_DATA);
    if (!seeded) {
      this.bookmarks = [...seed];
      this.write(BOOKMARKS_KEY, this.bookmarks);
      if (seedTagData) {
        this.tagData = seedTagData;
        this.write(TAG_DATA_KEY, this.tagData);
      }
      if (seedEnrichments && seedEnrichments.length > 0) {
        this.enrichments = [...seedEnrichments];
        this.write(ENRICHMENTS_KEY, this.enrichments);
      }
      this.write(SEEDED_KEY, '1');
    }
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return [...this.bookmarks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getBookmark(id: string): Promise<Bookmark | null> {
    return this.bookmarks.find((bookmark) => bookmark.id === id) ?? null;
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
    // Rename previousId -> bookmark AND drop any row already under the
    // destination id (a remote twin a pull inserted) so an id swap can never
    // leave two rows sharing one id that resurface on the next load. Mirrors the
    // native store's `DELETE previousId` + `INSERT OR REPLACE` (PK) semantics.
    this.bookmarks = this.bookmarks
      .filter((existing) => existing.id === previousId || existing.id !== bookmark.id)
      .map((existing) => (existing.id === previousId ? bookmark : existing));
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

  async getMeta(key: string): Promise<string | null> {
    return this.meta[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta = { ...this.meta, [key]: value };
    this.write(META_KEY, this.meta);
  }

  async listEnrichments(): Promise<AIEnrichment[]> {
    return [...this.enrichments];
  }

  async upsertEnrichments(enrichments: AIEnrichment[]): Promise<void> {
    const incoming = new Set(enrichments.map((enrichment) => enrichment.id));
    this.enrichments = [
      ...this.enrichments.filter((existing) => !incoming.has(existing.id)),
      ...enrichments,
    ];
    this.write(ENRICHMENTS_KEY, this.enrichments);
  }

  async deleteEnrichment(bookmarkId: string): Promise<void> {
    this.enrichments = this.enrichments.filter((item) => item.bookmark_id !== bookmarkId);
    this.write(ENRICHMENTS_KEY, this.enrichments);
  }

  async listTagData(): Promise<TagData> {
    return this.tagData;
  }

  async replaceTagData(data: TagData): Promise<void> {
    this.tagData = data;
    this.write(TAG_DATA_KEY, this.tagData);
  }

  async clearAllData(): Promise<void> {
    this.bookmarks = [];
    this.queue = [];
    this.enrichments = [];
    this.tagData = EMPTY_TAG_DATA;
    this.write(BOOKMARKS_KEY, this.bookmarks);
    this.write(QUEUE_KEY, this.queue);
    this.write(ENRICHMENTS_KEY, this.enrichments);
    this.write(TAG_DATA_KEY, this.tagData);
  }
}

export const repository: BookmarkRepository = new WebBookmarkRepository();
