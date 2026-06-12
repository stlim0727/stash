import type { AIEnrichment, Bookmark, BookmarkTag, Collection, Tag } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';
import { hasRemoteIdentity } from '@/sync/sync-bookmarks';

export const LAST_PULLED_AT_KEY = 'last_pulled_at';

/** Re-fetch a little history each pull; idempotent merges make this harmless. */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

/** The slice of the bookmark API that pull needs (kept narrow for testing). */
export interface PullApi {
  listBookmarksUpdatedSince(since: string | null): Promise<Bookmark[]>;
  listBookmarkIds(): Promise<string[]>;
  listEnrichmentsUpdatedSince(since: string | null): Promise<AIEnrichment[]>;
  listTags(): Promise<Tag[]>;
  listBookmarkTags(): Promise<BookmarkTag[]>;
  listCollections(): Promise<Collection[]>;
}

export interface PullResult {
  /** Remote rows to insert or replace locally (already persisted). */
  upserts: Bookmark[];
  /** Local IDs removed because the remote row no longer exists (already persisted). */
  deletions: string[];
  /** Refreshed enrichments (already persisted to the cache). */
  enrichments: AIEnrichment[];
  /** Authoritative snapshot of tags/links/collections (already persisted). */
  tagData: TagData;
  /** The new watermark (already persisted). */
  pulledAt: string;
}

/**
 * Pulls remote changes since the stored watermark and persists them.
 *
 * Per the UX spec (§9): row-level last-write-wins by `updated_at`, except a
 * local row with queued (unsynced) mutations is never overwritten — its
 * queued upload will re-assert it. Remote deletions are detected by diffing
 * the full remote ID list; only cloud-synced local rows without queued work
 * are removed. The watermark is captured before fetching so changes that
 * land mid-pull are re-fetched next time, and each pull overlaps the
 * previous watermark to tolerate clock skew.
 */
export async function pullRemoteChanges(
  api: PullApi,
  repository: BookmarkRepository,
  getLocalBookmarks: () => Bookmark[],
  hasQueuedWork: (bookmarkId: string) => boolean,
): Promise<PullResult> {
  const watermark = await repository.getMeta(LAST_PULLED_AT_KEY);
  const since = watermark
    ? new Date(Date.parse(watermark) - WATERMARK_OVERLAP_MS).toISOString()
    : null;
  const pulledAt = new Date().toISOString();

  const [remoteRows, remoteIds, enrichments, tags, bookmarkTags, collections] = await Promise.all([
    api.listBookmarksUpdatedSince(since),
    api.listBookmarkIds(),
    api.listEnrichmentsUpdatedSince(since),
    api.listTags(),
    api.listBookmarkTags(),
    api.listCollections(),
  ]);
  const tagData: TagData = { tags, bookmarkTags, collections };

  const locals = getLocalBookmarks();
  const localById = new Map(locals.map((bookmark) => [bookmark.id, bookmark]));

  const upserts: Bookmark[] = [];
  for (const remote of remoteRows) {
    if (hasQueuedWork(remote.id)) {
      continue;
    }
    const local = localById.get(remote.id);
    if (!local || remote.updated_at > local.updated_at) {
      upserts.push(remote);
    }
  }

  const remoteIdSet = new Set(remoteIds);
  const deletions = locals
    .filter(
      (bookmark) =>
        hasRemoteIdentity(bookmark.id) &&
        bookmark.sync_status === 'synced' &&
        !remoteIdSet.has(bookmark.id) &&
        !hasQueuedWork(bookmark.id),
    )
    .map((bookmark) => bookmark.id);

  for (const bookmark of upserts) {
    await repository.insertBookmark(bookmark);
  }
  for (const id of deletions) {
    await repository.deleteBookmark(id);
  }
  if (enrichments.length > 0) {
    await repository.upsertEnrichments(enrichments);
  }
  await repository.replaceTagData(tagData);
  await repository.setMeta(LAST_PULLED_AT_KEY, pulledAt);

  return { upserts, deletions, enrichments, tagData, pulledAt };
}
