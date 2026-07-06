import { sanitizeTagData } from '@/domain/tag-data';
import { recordLog } from '@/observability/log-buffer';
import type { AIEnrichment, Bookmark, BookmarkTag, Collection, Tag } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';
import { hasRemoteIdentity } from '@/sync/sync-bookmarks';

export const LAST_PULLED_AT_KEY = 'last_pulled_at';
/** The Supabase user id the local cache was last synced against. */
export const SYNCED_USER_ID_KEY = 'synced_user_id';
/** Whether that last-synced user was anonymous ('true' / 'false'). */
export const SYNCED_USER_ANON_KEY = 'synced_user_is_anonymous';

export interface PullUser {
  id: string;
  isAnonymous: boolean;
}

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
  /** True when the signed-in user differed from the last-synced one. */
  userChanged: boolean;
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
 *
 * When `currentUser` is supplied and differs from the last-synced user, this is
 * an account switch: the remote-deletion diff is SKIPPED (the previous account's
 * rows must never be deleted just because they are absent from this account —
 * the data-loss guard) and the watermark is reset for a full refresh. Re-homing
 * or dropping those rows is the caller's job (see account-transition.ts).
 */
export async function pullRemoteChanges(
  api: PullApi,
  repository: BookmarkRepository,
  getLocalBookmarks: () => Bookmark[],
  hasQueuedWork: (bookmarkId: string) => boolean,
  currentUser?: PullUser | null,
): Promise<PullResult> {
  const previousUserId = currentUser ? await repository.getMeta(SYNCED_USER_ID_KEY) : null;
  const userChanged =
    currentUser != null && previousUserId != null && previousUserId !== currentUser.id;

  const watermark = userChanged ? null : await repository.getMeta(LAST_PULLED_AT_KEY);
  const since = watermark
    ? new Date(Date.parse(watermark) - WATERMARK_OVERLAP_MS).toISOString()
    : null;
  const pulledAt = new Date().toISOString();

  if (userChanged) {
    recordLog(
      'warn',
      `pull: signed-in user changed (${previousUserId} → ${currentUser!.id}); full refresh, deletions skipped`,
    );
  }

  const [remoteRows, remoteIds, enrichments, tags, bookmarkTags, collections] = await Promise.all([
    api.listBookmarksUpdatedSince(since),
    api.listBookmarkIds(),
    api.listEnrichmentsUpdatedSince(since),
    api.listTags(),
    api.listBookmarkTags(),
    api.listCollections(),
  ]);
  // Drop blank-named tags/collections (and their orphaned links) the server may
  // still hold so they never re-enter local state as empty Browse chips.
  const { tagData } = sanitizeTagData({ tags, bookmarkTags, collections });

  const locals = getLocalBookmarks();
  const localById = new Map(locals.map((bookmark) => [bookmark.id, bookmark]));

  const upserts: Bookmark[] = [];
  for (const remote of remoteRows) {
    if (hasQueuedWork(remote.id)) {
      continue;
    }
    const local = localById.get(remote.id);
    if (!local || remote.updated_at > local.updated_at) {
      // Carry over device-only fields the remote row can't carry (they're never
      // sent to the cloud), so a pull that overwrites a locally-opened row
      // doesn't erase its last-opened time or captured-image URI.
      upserts.push(
        local
          ? {
              ...remote,
              last_accessed_at: local.last_accessed_at,
              local_image_uri: local.local_image_uri,
            }
          : remote,
      );
    }
  }

  const remoteIdSet = new Set(remoteIds);
  // Guard: on an account switch, never treat the previous account's rows as
  // remote deletions. Same-account deletions (a row removed on another device)
  // still reconcile normally.
  //
  // Also skip the deletion diff for ANY anonymous session: an anonymous account
  // is single-device by definition, so "deleted on another device" can never be
  // a valid inference — there is no other device. This is the durable guard
  // against a failed real-session restore that mints a throwaway anonymous user
  // while the local cache still holds a real account's synced rows. The
  // `userChanged` skip only covers the FIRST pull after such a mint: at the end
  // of that pull SYNCED_USER_ID is re-stamped to the anon id, so on the SECOND
  // pull userChanged is false and — without this — the diff would wipe every
  // still-owned synced row as a phantom "deleted on another device".
  const skipDeletions = userChanged || currentUser?.isAnonymous === true;
  const deletions = skipDeletions
    ? []
    : locals
        .filter(
          (bookmark) =>
            hasRemoteIdentity(bookmark.id) &&
            bookmark.sync_status === 'synced' &&
            !remoteIdSet.has(bookmark.id) &&
            !hasQueuedWork(bookmark.id),
        )
        .map((bookmark) => bookmark.id);

  if (deletions.length > 0) {
    recordLog('info', `pull: removing ${deletions.length} row(s) deleted on another device`);
  }

  for (const bookmark of upserts) {
    await repository.insertBookmark(bookmark);
  }
  for (const id of deletions) {
    await repository.deleteBookmark(id);
  }
  if (enrichments.length > 0) {
    await repository.upsertEnrichments(enrichments);
  }
  // Same single-device reasoning as the deletion guard: never let an anonymous
  // session's EMPTY remote snapshot nuke a non-empty durable local tag cache
  // (e.g. a real account's tags still cached after a failed session restore).
  // A non-empty snapshot still replaces normally, and a genuine switch to a
  // real account (isAnonymous === false) still replaces so account B's tags load
  // and A's never leak. Skipping only preserves the durable cache — the local
  // tags reappear on relaunch / on re-signing into the real account.
  const tagDataEmpty =
    tagData.tags.length === 0 &&
    tagData.collections.length === 0 &&
    tagData.bookmarkTags.length === 0;
  const skipTagReplace = currentUser?.isAnonymous === true && tagDataEmpty;
  if (!skipTagReplace) {
    await repository.replaceTagData(tagData);
  }
  await repository.setMeta(LAST_PULLED_AT_KEY, pulledAt);
  if (currentUser) {
    await repository.setMeta(SYNCED_USER_ID_KEY, currentUser.id);
    await repository.setMeta(SYNCED_USER_ANON_KEY, String(currentUser.isAnonymous));
  }

  return { upserts, deletions, enrichments, tagData, pulledAt, userChanged };
}
