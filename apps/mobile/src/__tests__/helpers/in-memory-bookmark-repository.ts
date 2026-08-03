import type {
  AIEnrichment,
  Bookmark,
  LocalPendingBookmark,
} from '@/domain/types';
import type {
  BookmarkRepository,
  CreateSyncCompletion,
  TagData,
} from '@/storage/types';

export interface DurableBookmarkState {
  initialized: boolean;
  bookmarks: Bookmark[];
  queue: LocalPendingBookmark[];
  enrichments: AIEnrichment[];
  tagData: TagData;
  meta: Record<string, string>;
}

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  if (index < 0) {
    return [...rows, clone(row)];
  }
  const next = [...rows];
  next[index] = clone(row);
  return next;
}

/** Durable, restartable test adapter implementing the complete repository contract. */
export class InMemoryBookmarkRepository implements BookmarkRepository {
  private state: DurableBookmarkState;

  constructor(initial: Partial<DurableBookmarkState> = {}) {
    this.state = clone({
      initialized: initial.initialized ?? Object.keys(initial).length > 0,
      bookmarks: initial.bookmarks ?? [],
      queue: initial.queue ?? [],
      enrichments: initial.enrichments ?? [],
      tagData: initial.tagData ?? EMPTY_TAG_DATA,
      meta: initial.meta ?? {},
    });
  }

  inspect(): DurableBookmarkState {
    return clone(this.state);
  }

  restart(): InMemoryBookmarkRepository {
    return new InMemoryBookmarkRepository(this.inspect());
  }

  async init(seed: Bookmark[], seedTagData = EMPTY_TAG_DATA, seedEnrichments = []): Promise<void> {
    if (!this.state.initialized) {
      this.state.bookmarks = clone(seed);
      this.state.tagData = clone(seedTagData);
      this.state.enrichments = clone(seedEnrichments);
      this.state.initialized = true;
    }
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return clone(this.state.bookmarks);
  }

  async getBookmark(id: string): Promise<Bookmark | null> {
    return clone(this.state.bookmarks.find((bookmark) => bookmark.id === id) ?? null);
  }

  async insertBookmark(bookmark: Bookmark): Promise<void> {
    this.state.bookmarks = upsertById(this.state.bookmarks, bookmark);
  }

  async updateBookmark(bookmark: Bookmark): Promise<void> {
    // Deliberately model web's strict replace behavior. Native currently upserts,
    // so cross-platform callers must not rely on a missing row being inserted here.
    const index = this.state.bookmarks.findIndex((candidate) => candidate.id === bookmark.id);
    if (index >= 0) {
      this.state.bookmarks[index] = clone(bookmark);
    }
  }

  async replaceBookmark(previousId: string, bookmark: Bookmark): Promise<void> {
    this.state.bookmarks = this.state.bookmarks.filter((candidate) => candidate.id !== previousId);
    this.state.bookmarks = upsertById(this.state.bookmarks, bookmark);
  }

  async completeCreateSyncBatch(completions: CreateSyncCompletion[]): Promise<void> {
    const next = this.inspect();
    for (const completion of completions) {
      const stored = next.queue.find(
        (entry) => entry.local_id === completion.entry.local_id,
      );
      if (
        !stored ||
        stored.operation !== completion.entry.operation ||
        stored.updated_at !== completion.entry.updated_at
      ) {
        continue;
      }
      if (completion.originalLocalId && completion.originalLocalId !== completion.bookmark.id) {
        next.bookmarks = next.bookmarks.filter(
          (bookmark) => bookmark.id !== completion.originalLocalId,
        );
      }
      next.bookmarks = upsertById(next.bookmarks, completion.bookmark);
      next.queue = next.queue.filter((entry) => entry.local_id !== completion.entry.local_id);
    }
    this.state = next;
  }

  async insertImportBatch(
    bookmarks: Bookmark[],
    entries: LocalPendingBookmark[],
    options?: { metaUpdates?: Record<string, string> },
  ): Promise<void> {
    const next = this.inspect();
    if (options?.metaUpdates) {
      next.meta = { ...next.meta, ...clone(options.metaUpdates) };
    }
    for (const bookmark of bookmarks) {
      next.bookmarks = upsertById(next.bookmarks, bookmark);
    }
    for (const entry of entries) {
      const index = next.queue.findIndex((candidate) => candidate.local_id === entry.local_id);
      if (index < 0) {
        next.queue.push(clone(entry));
      } else {
        next.queue[index] = clone(entry);
      }
    }
    this.state = next;
  }

  async deleteBookmark(id: string): Promise<void> {
    this.state.bookmarks = this.state.bookmarks.filter((bookmark) => bookmark.id !== id);
  }

  async listQueue(): Promise<LocalPendingBookmark[]> {
    return clone(this.state.queue);
  }

  async enqueue(entry: LocalPendingBookmark): Promise<void> {
    const index = this.state.queue.findIndex((candidate) => candidate.local_id === entry.local_id);
    if (index < 0) {
      this.state.queue.push(clone(entry));
    } else {
      this.state.queue[index] = clone(entry);
    }
  }

  async updateQueueEntry(entry: LocalPendingBookmark): Promise<void> {
    await this.enqueue(entry);
  }

  async removeQueueEntry(localId: string): Promise<void> {
    this.state.queue = this.state.queue.filter((entry) => entry.local_id !== localId);
  }

  async getMeta(key: string): Promise<string | null> {
    return this.state.meta[key] ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.state.meta[key] = value;
  }

  async listEnrichments(): Promise<AIEnrichment[]> {
    return clone(this.state.enrichments);
  }

  async upsertEnrichments(enrichments: AIEnrichment[]): Promise<void> {
    for (const enrichment of enrichments) {
      this.state.enrichments = upsertById(this.state.enrichments, enrichment);
    }
  }

  async deleteEnrichment(bookmarkId: string): Promise<void> {
    this.state.enrichments = this.state.enrichments.filter(
      (enrichment) => enrichment.bookmark_id !== bookmarkId,
    );
  }

  async listTagData(): Promise<TagData> {
    return clone(this.state.tagData);
  }

  async replaceTagData(data: TagData): Promise<void> {
    this.state.tagData = clone(data);
  }

  async clearAllData(): Promise<void> {
    this.state = {
      initialized: this.state.initialized,
      bookmarks: [],
      queue: [],
      enrichments: [],
      tagData: clone(EMPTY_TAG_DATA),
      meta: clone(this.state.meta),
    };
  }
}
