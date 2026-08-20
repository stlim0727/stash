import { sanitizeTagData } from '@/domain/tag-data';
import { recordLog } from '@/observability/log-buffer';
import { recordSlowSegment } from '@/observability/slow-segment-log';
import type { AIEnrichment, Bookmark, BookmarkTag, Collection, Tag } from '@/domain/types';
import type { BookmarkRepository, TagData } from '@/storage/types';
import { recordPullAttempt } from '@/sync/pull-diagnostics';
import { hasRemoteIdentity, isLocalOnlyBookmark } from '@/sync/sync-bookmarks';

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
  listBookmarksUpdatedSince(since: string | null, beforePage?: () => void): Promise<Bookmark[]>;
  listBookmarkIds(beforePage?: () => void): Promise<string[]>;
  listEnrichmentsUpdatedSince(
    since: string | null,
    beforePage?: () => void,
  ): Promise<AIEnrichment[]>;
  listTags(beforePage?: () => void): Promise<Tag[]>;
  listBookmarkTags(beforePage?: () => void): Promise<BookmarkTag[]>;
  listCollections(beforePage?: () => void): Promise<Collection[]>;
}

export class PullPausedError extends Error {
  constructor() {
    super('Pull stopped because sync was paused.');
    this.name = 'PullPausedError';
  }
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
  shouldContinue: () => boolean = () => true,
): Promise<PullResult> {
  const previousUserId = currentUser ? await repository.getMeta(SYNCED_USER_ID_KEY) : null;
  const userChanged =
    currentUser != null && previousUserId != null && previousUserId !== currentUser.id;
  const initialLocals = getLocalBookmarks();
  // hasRemoteIdentity excludes seed/sample rows, and isLocalOnlyBookmark
  // excludes local-only rows (e.g. image bookmarks) — both are marked
  // sync_status: 'synced' locally too even though they were never a real
  // cloud row (see hasSyncedOnce in store/bookmarks.tsx).
  const initialLocalCloudRowCount = initialLocals.filter(
    (bookmark) =>
      hasRemoteIdentity(bookmark.id) &&
      bookmark.sync_status === 'synced' &&
      !isLocalOnlyBookmark(bookmark),
  ).length;
  const hasLocalCloudRows = initialLocalCloudRowCount > 0;
  // STASH-22: stale sync metadata can survive an upgrade/session-recovery path
  // even when the local cache is empty. A same-user incremental pull would then
  // omit older cloud rows and leave the signed-in Inbox empty.
  const emptyRealCacheWithSameUser =
    currentUser?.isAnonymous === false &&
    !hasLocalCloudRows &&
    (previousUserId === null || previousUserId === currentUser.id);
  const needsFullRefresh = userChanged || emptyRealCacheWithSameUser;
  const fullRefreshReason = userChanged
    ? 'user_changed'
    : emptyRealCacheWithSameUser
      ? 'empty_real_cache_same_user'
      : null;

  const watermark = needsFullRefresh ? null : await repository.getMeta(LAST_PULLED_AT_KEY);
  const since = watermark
    ? new Date(Date.parse(watermark) - WATERMARK_OVERLAP_MS).toISOString()
    : null;
  const pulledAt = new Date().toISOString();

  // Diagnostics span the whole attempt (fetch + merge + persist), recorded on
  // both the success path below and any failure/thrown-error path (a pull can
  // legitimately throw — a network failure, or `PullPausedError` if the app
  // backgrounds mid-pull). Fire-and-forget, and must never itself be able to
  // slow down or break a pull — see `sync/pull-diagnostics.ts`.
  const attemptStartedAt = Date.now();

  try {
    if (userChanged) {
      recordLog(
        'warn',
        `pull: signed-in user changed (${previousUserId} → ${currentUser!.id}); full refresh, deletions skipped`,
      );
    }

    recordLog(
      'info',
      `pull: starting since=${since ? 'set' : 'null'} initialLocal=${initialLocals.length} initialLocalCloud=${initialLocalCloudRowCount}`,
    );
    const beforePage = () => {
      if (!shouldContinue()) {
        throw new PullPausedError();
      }
    };
    const [remoteRows, remoteIds, enrichments, tags, bookmarkTags, collections] = await Promise.all([
      api.listBookmarksUpdatedSince(since, beforePage),
      api.listBookmarkIds(beforePage),
      api.listEnrichmentsUpdatedSince(since, beforePage),
      api.listTags(beforePage),
      api.listBookmarkTags(beforePage),
      api.listCollections(beforePage),
    ]);
    // The pause can land after every final page resolves but before this
    // continuation runs. Never apply a partial or now-unwanted pull snapshot.
    beforePage();
    recordLog(
      fullRefreshReason ? 'warn' : 'info',
      `pull: result initialLocal=${initialLocals.length} initialLocalCloud=${initialLocalCloudRowCount} remoteRows=${remoteRows.length} remoteIds=${remoteIds.length} since=${since ? 'set' : 'null'} fullRefresh=${fullRefreshReason ?? 'none'} userChanged=${userChanged}`,
    );
    // Drop blank-named tags/collections (and their orphaned links) the server may
    // still hold so they never re-enter local state as empty Browse chips.
    const { tagData } = sanitizeTagData({ tags, bookmarkTags, collections });

    // STASH-K: everything from here to the record call below runs without an
    // await, so its elapsed time is JS-thread block time — what the loop-stall
    // watchdog measures from the outside but cannot attribute. This region is the
    // pull-side counterpart to the bulk-create brackets in store/bookmarks.tsx:
    // `hasQueuedWork` is a linear scan of the pending queue in the store, called
    // once per remote row here and once per local row in the deletion diff, so the
    // work is O(rows x queue) — which is exactly the shape of a stall reported
    // with `syncing=true queue=685`.
    const mergeStartedAt = Date.now();
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
                title_is_derived:
                  remote.title === local.title ? local.title_is_derived : undefined,
                // Also device-only (STASH-61): a live YouTube-availability check
                // result the remote row can't carry, so a pull never silently
                // clears a confirmed "unavailable" badge this device already
                // found.
                video_unavailable: local.video_unavailable,
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
              !isLocalOnlyBookmark(bookmark) &&
              !remoteIdSet.has(bookmark.id) &&
              !hasQueuedWork(bookmark.id),
          )
          .map((bookmark) => bookmark.id);

    recordSlowSegment('pull-merge', Date.now() - mergeStartedAt);

    if (deletions.length > 0) {
      recordLog('info', `pull: removing ${deletions.length} row(s) deleted on another device`);
    }

    // Batched in one call instead of one repository call per row — looping
    // insertBookmark/deleteBookmark per row re-serializes and writes the
    // *entire* local bookmarks array on the web backend on every single call,
    // turning an O(n) write into O(rows × n) (Sentry STASH-5X: 802 deletions
    // against a ~1800-row cache froze the JS thread for 15+ seconds). Falls
    // back to the per-row loop for a repository that doesn't implement the
    // batch method.
    if (repository.upsertBookmarks) {
      await repository.upsertBookmarks(upserts);
    } else {
      for (const bookmark of upserts) {
        await repository.insertBookmark(bookmark);
      }
    }
    if (repository.deleteBookmarks) {
      await repository.deleteBookmarks(deletions);
    } else {
      for (const id of deletions) {
        await repository.deleteBookmark(id);
      }
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
    // When the replace is skipped, return the PRESERVED durable snapshot (not the
    // empty server one). The store applies `result.tagData` straight to live state
    // (store/bookmarks.tsx), so returning the empty snapshot would still blank the
    // tags/collections from the current UI until a relaunch even though the durable
    // cache is intact. Returning the preserved snapshot keeps the on-screen tags.
    let effectiveTagData = tagData;
    if (skipTagReplace) {
      effectiveTagData = await repository.listTagData();
    } else {
      await repository.replaceTagData(tagData);
    }
    await repository.setMeta(LAST_PULLED_AT_KEY, pulledAt);
    if (currentUser) {
      await repository.setMeta(SYNCED_USER_ID_KEY, currentUser.id);
      await repository.setMeta(SYNCED_USER_ANON_KEY, String(currentUser.isAnonymous));
    }

    recordPullAttempt({
      since,
      fullRefreshReason,
      remoteRowCount: remoteRows.length,
      outcome: 'success',
      durationMs: Date.now() - attemptStartedAt,
    });

    return { upserts, deletions, enrichments, tagData: effectiveTagData, pulledAt, userChanged };
  } catch (error) {
    recordPullAttempt({
      since,
      fullRefreshReason,
      remoteRowCount: 0,
      outcome: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - attemptStartedAt,
    });
    throw error;
  }
}
