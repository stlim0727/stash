import type { AIEnrichment, Bookmark, LocalPendingBookmark } from '@/domain/types';
import type {
  BookmarkRepository,
  CreateSyncCompletion,
  IdentityRekeyState,
  TagData,
} from '@/storage/types';

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
const IDENTITY_REKEY_COMMIT_KEY = 'stash.identityRekeyCommit';

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };

interface IdentityRekeyCommit {
  bookmarks: Bookmark[];
  queue: LocalPendingBookmark[];
  meta: Record<string, string>;
  tagData: TagData;
}

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
    const interruptedRekey = this.read<IdentityRekeyCommit | null>(
      IDENTITY_REKEY_COMMIT_KEY,
      null,
    );
    if (interruptedRekey) {
      this.bookmarks = interruptedRekey.bookmarks;
      this.queue = interruptedRekey.queue;
      this.meta = interruptedRekey.meta;
      this.tagData = interruptedRekey.tagData;
      this.write(BOOKMARKS_KEY, this.bookmarks);
      this.write(QUEUE_KEY, this.queue);
      this.write(META_KEY, this.meta);
      this.write(TAG_DATA_KEY, this.tagData);
      localStorage.removeItem(IDENTITY_REKEY_COMMIT_KEY);
    }
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

  async replaceBookmarkIdentities(
    replacements: Array<{ previousId: string; bookmark: Bookmark }>,
    entries: LocalPendingBookmark[],
    state: IdentityRekeyState,
  ): Promise<void> {
    let nextBookmarks = this.bookmarks;
    for (const { previousId, bookmark } of replacements) {
      nextBookmarks = nextBookmarks
        .filter((existing) => existing.id === previousId || existing.id !== bookmark.id)
        .map((existing) => (existing.id === previousId ? bookmark : existing));
    }
    const entryIds = new Set(entries.map((entry) => entry.local_id));
    // A queue entry still sitting under a rehomed row's OLD id (see this
    // method's doc comment in storage/types.ts) must be dropped in this SAME
    // atomic write, not a separate follow-up call — otherwise it survives to
    // retry under the OLD id after a crash/reload, in parallel with the
    // freshly-enqueued entry under the new id.
    const previousIds = new Set(replacements.map((replacement) => replacement.previousId));
    const nextQueue = [
      ...this.queue.filter(
        (entry) => !entryIds.has(entry.local_id) && !previousIds.has(entry.local_id),
      ),
      ...entries,
    ];
    const commit: IdentityRekeyCommit = {
      bookmarks: nextBookmarks,
      queue: nextQueue,
      meta: { ...this.meta, ...state.metaUpdates },
      tagData: state.tagData,
    };
    this.write(IDENTITY_REKEY_COMMIT_KEY, commit);
    this.bookmarks = commit.bookmarks;
    this.queue = commit.queue;
    this.meta = commit.meta;
    this.tagData = commit.tagData;
    this.write(BOOKMARKS_KEY, this.bookmarks);
    this.write(QUEUE_KEY, this.queue);
    this.write(META_KEY, this.meta);
    this.write(TAG_DATA_KEY, this.tagData);
    if (storageAvailable()) {
      localStorage.removeItem(IDENTITY_REKEY_COMMIT_KEY);
    }
  }

  async completeCreateSyncBatch(completions: CreateSyncCompletion[]): Promise<void> {
    const applied = completions.filter((completion) => {
      const stored = this.queue.find((entry) => entry.local_id === completion.entry.local_id);
      return (
        stored &&
        stored.operation === completion.entry.operation &&
        stored.updated_at === completion.entry.updated_at
      );
    });
    if (applied.length === 0) {
      return;
    }
    for (const { bookmark, originalLocalId } of applied) {
      // Drop the phantom row under the original id (a create resolved as a
      // duplicate of an existing different row never actually created one —
      // see CreateSyncCompletion.originalLocalId), then upsert in place,
      // collapsing onto an existing row already at the destination id (e.g.
      // one a pull already inserted) instead of leaving a duplicate.
      let replaced = false;
      this.bookmarks = this.bookmarks
        .filter((existing) => existing.id !== originalLocalId)
        .map((existing) => {
          if (existing.id === bookmark.id) {
            replaced = true;
            return bookmark;
          }
          return existing;
        });
      if (!replaced) {
        this.bookmarks = [bookmark, ...this.bookmarks];
      }
    }
    const completedIds = new Set(applied.map((completion) => completion.entry.local_id));
    this.queue = this.queue.filter((entry) => !completedIds.has(entry.local_id));
    this.write(BOOKMARKS_KEY, this.bookmarks);
    this.write(QUEUE_KEY, this.queue);
  }

  async insertImportBatch(
    bookmarks: Bookmark[],
    entries: LocalPendingBookmark[],
    options?: { metaUpdates?: Record<string, string> },
  ): Promise<void> {
    if (bookmarks.length === 0) {
      return;
    }
    if (options?.metaUpdates) {
      this.meta = { ...this.meta, ...options.metaUpdates };
      this.write(META_KEY, this.meta);
    }
    const existingIds = new Set(this.bookmarks.map((b) => b.id));
    const newBookmarks = bookmarks.filter((b) => !existingIds.has(b.id));
    this.bookmarks = [...newBookmarks, ...this.bookmarks];
    const existingQueueIds = new Set(this.queue.map((q) => q.local_id));
    const newQueueEntries = entries.filter((e) => !existingQueueIds.has(e.local_id));
    this.queue = [...this.queue, ...newQueueEntries];
    this.write(BOOKMARKS_KEY, this.bookmarks);
    this.write(QUEUE_KEY, this.queue);
  }

  async deleteBookmark(id: string): Promise<void> {
    this.bookmarks = this.bookmarks.filter((existing) => existing.id !== id);
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  // listBookmarks() always re-sorts by created_at, so the stored array's
  // order is never observed — replacing existing rows in place and
  // prepending brand-new ones (rather than replicating insertBookmark's
  // per-call "move to front") is behaviorally equivalent and O(n) total.
  async upsertBookmarks(bookmarks: Bookmark[]): Promise<void> {
    if (bookmarks.length === 0) {
      return;
    }
    const byId = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
    const existingIds = new Set(this.bookmarks.map((existing) => existing.id));
    // Iterate the deduped map, not the raw `bookmarks` array — two input
    // entries sharing an id neither of which is already local would
    // otherwise both land in brandNew, landing two rows under one id
    // (replaceBookmark's own comment above explains why that's a bug worth
    // preventing). Not reachable via pullRemoteChanges's `upserts` today,
    // but the dedup is free.
    const brandNew = [...byId.values()].filter((bookmark) => !existingIds.has(bookmark.id));
    const merged = this.bookmarks.map((existing) => byId.get(existing.id) ?? existing);
    this.bookmarks = [...brandNew, ...merged];
    this.write(BOOKMARKS_KEY, this.bookmarks);
  }

  async deleteBookmarks(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    this.bookmarks = this.bookmarks.filter((existing) => !idSet.has(existing.id));
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
