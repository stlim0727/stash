import { BOOKMARK_NOT_FOUND_ERROR_MESSAGE, createBookmarkApi } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import { createPayloadFromBookmark, isUploadableCreate } from '@/domain/create-payload';
import type { Bookmark, CreateBookmarkInput, LocalPendingBookmark } from '@/domain/types';
import { canonicalizeUrl } from '@/domain/urls';
import { recordLog } from '@/observability/log-buffer';
import type { BookmarkRepository } from '@/storage/types';
import { SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

export interface EntrySyncResult {
  entry: LocalPendingBookmark;
  /** Present when the local bookmark row's fields changed (sync_status,
   *  ever_synced, etc.) and the caller needs to persist/reflect them. Applied
   *  by id — a bookmark's id never changes once captured (see makeBookmarkId),
   *  EXCEPT the one case `originalLocalId` below covers. */
  bookmarkUpdate?: Bookmark;
  /** True when the entry's work is finished and it can leave the queue. */
  removeEntry?: boolean;
  /** For creates: what was actually sent, so callers can reconcile later edits. */
  uploadedPayload?: CreateBookmarkInput;
  /** Present when the local bookmark row was removed (deleted on another
   *  device while this device had a queued edit for it — see below). */
  removedBookmarkId?: string;
  /**
   * Present when a create's own id could not be used because the server
   * deduped it against an EXISTING different row (`status: 'duplicate'`) —
   * see STASH-3Q. `bookmarkUpdate.id` is the existing row's id in this case,
   * different from the entry's `local_id` (carried here as `originalLocalId`
   * so the caller can find the in-memory row, re-key tag/AI-retry state onto
   * the new id the same way account rehoming does, and delete the phantom
   * local-id row that was never actually created server-side).
   */
  originalLocalId?: string;
}

export const BULK_CREATE_SYNC_CHUNK_SIZE = 50;

export function hasBulkCreateResultKey(entry: LocalPendingBookmark): boolean {
  if (entry.operation !== 'create') {
    return false;
  }
  return (
    (typeof entry.payload.client_id === 'string' && entry.payload.client_id.trim().length > 0) ||
    (typeof entry.payload.url === 'string' && entry.payload.url.trim().length > 0)
  );
}

/**
 * True when an `update` failed because the row is confirmed gone remotely —
 * deleted on this account (any device) or never owned by this user — as
 * opposed to a transient network/server error. Unambiguous because the
 * request that threw it was already scoped to the current user's own id.
 */
function isBookmarkGoneRemotely(error: unknown): boolean {
  return error instanceof Error && error.message === BOOKMARK_NOT_FOUND_ERROR_MESSAGE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sync failed.';
}

/**
 * Retry count at which a stuck queue entry's health gets escalated (see
 * `crossedHealthEscalationThreshold` and its caller in store/bookmarks.tsx),
 * so a systemic sync problem — an API outage, a schema mismatch affecting
 * every upload — surfaces to the team without waiting for an in-app feedback
 * report. Deliberately low: 3 failed attempts already means automatic retry
 * alone hasn't resolved it.
 */
export const SYNC_QUEUE_HEALTH_ESCALATION_THRESHOLD = 3;

/**
 * True exactly when a failed attempt just crossed the escalation threshold —
 * the previous retry_count was below it, the new one is at/above it. Fires
 * once per entry at the crossing, not again on every retry past it (an entry
 * stuck at attempt 40 shouldn't re-escalate 37 more times).
 */
export function crossedHealthEscalationThreshold(
  previousRetryCount: number,
  nextRetryCount: number,
): boolean {
  return (
    previousRetryCount < SYNC_QUEUE_HEALTH_ESCALATION_THRESHOLD &&
    nextRetryCount >= SYNC_QUEUE_HEALTH_ESCALATION_THRESHOLD
  );
}

/**
 * Removes a finished entry's queue row — unless a newer mutation (e.g. a
 * durable delete enqueued while this entry was in flight) has replaced the
 * row at the same key, in which case that newer work must survive.
 */
export async function removeQueueEntryIfNotSuperseded(
  repository: BookmarkRepository,
  entry: LocalPendingBookmark,
): Promise<void> {
  const stored = (await repository.listQueue()).find(
    (queued) => queued.local_id === entry.local_id,
  );
  if (
    !stored ||
    stored.operation === entry.operation ||
    (stored.operation === 'update' && entry.operation === 'create')
  ) {
    await repository.removeQueueEntry(entry.local_id);
  }
}

async function failEntry(
  repository: BookmarkRepository,
  entry: LocalPendingBookmark,
  error: unknown,
  now: string,
): Promise<LocalPendingBookmark> {
  const failedEntry: LocalPendingBookmark = {
    ...entry,
    sync_status: 'failed',
    retry_count: entry.retry_count + 1,
    last_error: errorMessage(error),
    updated_at: now,
  };
  const stored = (await repository.listQueue()).find(
    (queued) => queued.local_id === entry.local_id,
  );
  if (
    stored &&
    (stored.operation === entry.operation ||
      (stored.operation === 'update' && entry.operation === 'create')) &&
    stored.updated_at === entry.updated_at
  ) {
    await repository.updateQueueEntry(failedEntry);
    return failedEntry;
  }
  return stored ?? failedEntry;
}

const OPTIONAL_BOOKMARK_UPDATE_COLUMNS = [
  'dismissed_suggested_tags',
  'dismissed_suggested_folders',
  'reviewed_summary_tokens',
] as const;

type BookmarkUpdatePayload = Parameters<BookmarkApi['updateBookmark']>[1];

function isMissingOptionalBookmarkColumnError(
  error: unknown,
  payload: BookmarkUpdatePayload,
): boolean {
  if (!(error instanceof SupabaseRequestError) || error.status < 400 || error.status >= 500) {
    return false;
  }
  const message = error.message.toLowerCase();
  return OPTIONAL_BOOKMARK_UPDATE_COLUMNS.some(
    (column) =>
      Object.prototype.hasOwnProperty.call(payload, column) &&
      message.includes(column.toLowerCase()) &&
      message.includes('schema cache'),
  );
}

function withoutOptionalBookmarkUpdateColumns(
  payload: BookmarkUpdatePayload,
): BookmarkUpdatePayload {
  const next = { ...payload };
  for (const column of OPTIONAL_BOOKMARK_UPDATE_COLUMNS) {
    delete next[column];
  }
  return next;
}

function createUploadPayload(
  entry: LocalPendingBookmark,
  getBookmark: (id: string) => Bookmark | undefined,
): CreateBookmarkInput {
  const latestAtUpload = getBookmark(entry.local_id);
  return latestAtUpload
    ? {
        ...entry.payload,
        title: latestAtUpload.title ?? undefined,
        notes: latestAtUpload.notes ?? undefined,
      }
    : entry.payload;
}

export async function syncCreateQueueEntryBatch(
  api: BookmarkApi,
  entries: LocalPendingBookmark[],
  getBookmark: (id: string) => Bookmark | undefined,
): Promise<EntrySyncResult[]> {
  if (entries.length === 0) {
    return [];
  }
  if (entries.some((entry) => entry.operation !== 'create')) {
    throw new Error('Bulk create sync only accepts create queue entries.');
  }
  if (entries.some((entry) => !hasBulkCreateResultKey(entry))) {
    throw new Error('Bulk create sync requires a client_id or URL mapping key.');
  }

  const now = new Date().toISOString();
  const uploadedPayloads = entries.map((entry) => createUploadPayload(entry, getBookmark));
  const created = await api.createBookmarks(uploadedPayloads);
  if (created.length !== entries.length) {
    throw new Error('Bulk create sync returned the wrong number of results.');
  }

  const results: EntrySyncResult[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const output = created[index]!;
    const syncedEntry: LocalPendingBookmark = {
      ...entry,
      remote_id: output.bookmark_id,
      sync_status: 'synced',
      last_error: null,
      updated_at: now,
    };

    const localBookmark = getBookmark(entry.local_id);
    // A duplicate-status result means the server matched this create against
    // an EXISTING different row instead of using the id the client sent (see
    // EntrySyncResult.originalLocalId / STASH-3Q) — the one remaining case a
    // bookmark's id changes after capture, alongside account rehoming.
    const isDuplicateSwap =
      output.status === 'duplicate' &&
      Boolean(output.bookmark_id) &&
      output.bookmark_id !== entry.local_id;
    if (localBookmark) {
      const syncedBookmark: Bookmark = {
        ...localBookmark,
        id: isDuplicateSwap ? output.bookmark_id : localBookmark.id,
        sync_status: 'synced',
        ever_synced: true,
        updated_at: now,
      };
      results.push({
        entry: syncedEntry,
        bookmarkUpdate: syncedBookmark,
        uploadedPayload: uploadedPayloads[index],
        originalLocalId: isDuplicateSwap ? entry.local_id : undefined,
      });
      continue;
    }

    results.push({
      entry: syncedEntry,
      uploadedPayload: uploadedPayloads[index],
      originalLocalId: output.bookmark_id !== entry.local_id ? entry.local_id : undefined,
    });
  }

  return results;
}

/**
 * Performs one queue entry's remote operation. All three are safe to retry:
 * `create` is idempotent on the server (URL dedupe + unique-conflict
 * handling), `update` re-sends the bookmark's current user-editable fields
 * (last write wins), and `delete` treats an already-deleted row as success.
 * Failures stay in the queue as retryable with the error recorded.
 *
 * `getBookmark` must return the LATEST local row — not a snapshot — so
 * concurrent enrichment or edits are never overwritten by stale data.
 */
export async function syncQueueEntry(
  api: BookmarkApi,
  repository: BookmarkRepository,
  entry: LocalPendingBookmark,
  getBookmark: (id: string) => Bookmark | undefined,
): Promise<EntrySyncResult> {
  const now = new Date().toISOString();

  if (entry.operation === 'update') {
    const bookmark = getBookmark(entry.local_id);
    if (!bookmark) {
      // The bookmark is gone locally; nothing left to update remotely. A
      // durable delete may have replaced this row — leave that intact.
      await removeQueueEntryIfNotSuperseded(repository, entry);
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    }
    const updatePayload: BookmarkUpdatePayload = {
      title: bookmark.title,
      description: bookmark.description,
      notes: bookmark.notes,
      collection_id: bookmark.collection_id,
      is_archived: bookmark.is_archived,
      deleted_at: bookmark.deleted_at,
      // Push generated metadata so enrichment done on this device reaches
      // the cloud (and, via pull, other devices).
      site_name: bookmark.site_name,
      favicon_url: bookmark.favicon_url,
      preview_image_url: bookmark.preview_image_url,
      metadata_status: bookmark.metadata_status,
      ...(bookmark.dismissed_suggested_tags !== undefined
        ? { dismissed_suggested_tags: bookmark.dismissed_suggested_tags }
        : {}),
      ...(bookmark.dismissed_suggested_folders !== undefined
        ? { dismissed_suggested_folders: bookmark.dismissed_suggested_folders }
        : {}),
      ...(bookmark.reviewed_summary_tokens !== undefined
        ? { reviewed_summary_tokens: bookmark.reviewed_summary_tokens }
        : {}),
    };
    try {
      try {
        await api.updateBookmark(entry.local_id, updatePayload);
      } catch (error) {
        if (!isMissingOptionalBookmarkColumnError(error, updatePayload)) {
          throw error;
        }
        recordLog(
          'warn',
          `sync update: optional bookmark dismissal column missing; retrying without AI dismissal fields (${error instanceof Error ? error.message : String(error)})`,
        );
        await api.updateBookmark(entry.local_id, withoutOptionalBookmarkUpdateColumns(updatePayload));
        throw new Error(
          'Optional AI dismissal fields are waiting for the Supabase schema to update.',
        );
      }
      await removeQueueEntryIfNotSuperseded(repository, entry);
      if (bookmark.sync_status !== 'synced') {
        const syncedBookmark: Bookmark = {
          ...bookmark,
          sync_status: 'synced',
          ever_synced: true,
          updated_at: now,
        };
        await repository.updateBookmark(syncedBookmark);
        return {
          entry: { ...entry, sync_status: 'synced', updated_at: now },
          bookmarkUpdate: syncedBookmark,
          removeEntry: true,
        };
      }
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    } catch (error) {
      if (isBookmarkGoneRemotely(error)) {
        // Deleted on another device while this device still had a queued
        // edit for it. Pull-side reconciliation deliberately never deletes a
        // local row that has queued work (see pull-bookmarks.ts), so without
        // this the edit would retry forever against a row that can never
        // come back — a climbing retry_count visible in Settings' Sync Queue
        // (Sentry STASH-2F: "Lots of retrial"). Finish what pull would have
        // done: remove the local row, then the queue entry (in that order so
        // a crash in between still self-heals via the "bookmark gone
        // locally" branch above on the next pass).
        recordLog(
          'info',
          `sync: removing local row ${entry.local_id} — deleted on another device (queued update could not land)`,
        );
        await repository.deleteBookmark(entry.local_id);
        await removeQueueEntryIfNotSuperseded(repository, entry);
        return {
          entry: { ...entry, sync_status: 'synced', updated_at: now },
          removeEntry: true,
          removedBookmarkId: entry.local_id,
        };
      }
      return { entry: await failEntry(repository, entry, error, now) };
    }
  }

  if (entry.operation === 'delete') {
    try {
      await api.deleteBookmark(entry.remote_id ?? entry.local_id, true);
      await removeQueueEntryIfNotSuperseded(repository, entry);
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    } catch (error) {
      return { entry: await failEntry(repository, entry, error, now) };
    }
  }

  // operation === 'create'
  // Send the LATEST user-authored fields, not the payload captured at save
  // time: the user may have edited title/notes before this upload ran.
  const payload = createUploadPayload(entry, getBookmark);
  try {
    const result = await api.createBookmark(payload);
    const syncedEntry: LocalPendingBookmark = {
      ...entry,
      remote_id: result.bookmark_id,
      sync_status: 'synced',
      last_error: null,
      updated_at: now,
    };
    await repository.updateQueueEntry(syncedEntry);

    const localBookmark = getBookmark(entry.local_id);
    // result.bookmark_id normally equals localBookmark.id — the client sent
    // that id explicitly (see makeBookmarkId/CreateBookmarkInput.id) — EXCEPT
    // when the server deduped this create against an existing different row
    // (status: 'duplicate'; see STASH-3Q and EntrySyncResult.originalLocalId).
    // In that case the local row must adopt the EXISTING row's id, or the
    // next pull fetches that existing row separately and the library doubles.
    if (localBookmark) {
      const isDuplicateSwap =
        result.status === 'duplicate' && Boolean(result.bookmark_id) && result.bookmark_id !== entry.local_id;
      const syncedBookmark: Bookmark = {
        ...localBookmark,
        id: isDuplicateSwap ? result.bookmark_id : localBookmark.id,
        sync_status: 'synced',
        ever_synced: true,
        updated_at: now,
      };
      if (isDuplicateSwap) {
        // insertBookmark (not updateBookmark), since the existing row's id is
        // new to THIS device — updateBookmark only replaces a row already
        // stored under that id (a strict replace, not an upsert, on the
        // web/localStorage backend) and would silently no-op here.
        await repository.deleteBookmark(localBookmark.id);
        await repository.insertBookmark(syncedBookmark);
      } else {
        await repository.updateBookmark(syncedBookmark);
      }
      return {
        entry: syncedEntry,
        bookmarkUpdate: syncedBookmark,
        uploadedPayload: payload,
        originalLocalId: isDuplicateSwap ? entry.local_id : undefined,
      };
    }

    return {
      entry: syncedEntry,
      uploadedPayload: payload,
      originalLocalId: result.bookmark_id !== entry.local_id ? entry.local_id : undefined,
    };
  } catch (error) {
    const failedEntry = await failEntry(repository, entry, error, now);
    const localBookmark = getBookmark(entry.local_id);
    if (localBookmark && localBookmark.sync_status !== 'failed') {
      const failedBookmark: Bookmark = { ...localBookmark, sync_status: 'failed' };
      await repository.updateBookmark(failedBookmark);
      return {
        entry: failedEntry,
        bookmarkUpdate: failedBookmark,
      };
    }

    return { entry: failedEntry };
  }
}

/**
 * After a `create` uploads and the local row adopts its remote id, decide
 * whether a follow-up `update` is needed. The create payload only carries
 * url/title/notes, and the freshly-created remote row defaults to no generated
 * metadata, no collection, active (not archived, not trashed), pending status.
 * If the local row diverged while the create was in flight — archived, filed,
 * edited, enriched, or TRASHED — those changes haven't reached the cloud yet,
 * so reconcile them with one follow-up update.
 *
 * Critically includes `deleted_at`: a bookmark trashed before it gained a
 * remote id uploads as an active create, so without this the cloud row stays
 * live and resurrects on other devices on the next pull. The `description`
 * clause covers text notes, whose body uploads as `shared_text` and lands in
 * the remote row's `description`: if the user edited the note before the create
 * ran, the body diverged and must be re-pushed too.
 */
export function createNeedsReconcileUpdate(
  persisted: Bookmark,
  uploadedPayload: CreateBookmarkInput | undefined,
): boolean {
  return (
    persisted.deleted_at !== null ||
    persisted.is_archived ||
    persisted.collection_id !== null ||
    persisted.title !== (uploadedPayload?.title ?? null) ||
    persisted.notes !== (uploadedPayload?.notes ?? null) ||
    persisted.description !== (uploadedPayload?.shared_text ?? null) ||
    persisted.metadata_status !== 'pending' ||
    persisted.site_name !== null ||
    persisted.favicon_url !== null ||
    persisted.preview_image_url !== null
  );
}

/** Builds a pending mutation entry targeting a bookmark that exists remotely. */
export function makeMutationEntry(
  bookmarkId: string,
  operation: 'update' | 'delete',
): LocalPendingBookmark {
  const now = new Date().toISOString();
  return {
    local_id: bookmarkId,
    remote_id: bookmarkId,
    operation,
    payload: {},
    sync_status: 'pending',
    retry_count: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when a bookmark id has the shape of a Supabase-generated UUID rather
 * than a device-local (`local-…`) or seeded sample (`bookmark-…`) one.
 *
 * IMPORTANT: this is NOT a "has this synced" proxy. Every bookmark gets a real
 * UUID id at CAPTURE time (see `makeBookmarkId` in store/bookmarks.tsx) and
 * keeps that same id for its whole life — id shape doesn't distinguish "never
 * synced" from "synced." Use `sync_status === 'synced' || ever_synced` for
 * that instead (see `Bookmark.ever_synced`). The remaining legitimate use is
 * excluding seeded sample rows, which are marked `sync_status: 'synced'`
 * locally (so the orphan self-heal never tries to upload them) without ever
 * being a real cloud row.
 */
export function hasRemoteIdentity(bookmarkId: string): boolean {
  return UUID_PATTERN.test(bookmarkId);
}

export function createSyncApi(session: SupabaseAuthSession): BookmarkApi {
  return createBookmarkApi(session);
}

// Postgres's default btree index page can't hold an index row over roughly
// 2.7KB, and the dedupe index is keyed on (user_id, url_hash) — a URL long
// enough (Sentry STASH-2J: an Oracle email-verification link) blows that
// limit on EVERY retry, forever, since the URL will always be too long. A
// client-side length guard (domain/urls.ts isUrlTooLong) now stops any NEW
// bookmark from ever being queued this way, but an entry already queued on a
// pre-fix build still carries this exact Postgres message in `last_error`
// from its last failed attempt — checking that text (rather than requiring a
// fresh failure to relabel it) lets an already-stuck entry stop being
// retried the moment the app updates, with no further doomed request needed.
const URL_TOO_LONG_ERROR_TEXT = 'exceeds btree version';

/** Exported so the caller can DRAIN these from the visible queue (see
 *  `syncNow`'s "permanently unsyncable" cleanup) — merely excluding them from
 *  `isSyncable` stops the doomed retries but leaves the row sitting as
 *  `sync_status: 'failed'` in the queue forever, which every "waiting to
 *  sync" count (e.g. Settings) still counts as pending work that can never
 *  drain (caught in PR review). */
export function isPermanentlyUnsyncableUrl(entry: LocalPendingBookmark): boolean {
  return (
    entry.sync_status === 'failed' &&
    typeof entry.last_error === 'string' &&
    entry.last_error.includes(URL_TOO_LONG_ERROR_TEXT)
  );
}

export function isSyncable(entry: LocalPendingBookmark): boolean {
  // Anything not yet 'synced' is eligible. 'syncing' is included so an entry
  // that an interrupted run left in-flight (e.g. the app was backgrounded or a
  // storage write threw mid-upload) is retried rather than orphaned forever.
  // The one exception is a permanently-too-long URL (above): retrying it can
  // never succeed, so excluding it here stops both the automatic sync effect
  // and an explicit "Sync now" from hammering the same doomed request.
  return entry.sync_status !== 'synced' && !isPermanentlyUnsyncableUrl(entry);
}

/**
 * Finds bookmarks stranded in a non-synced state with no queue entry to drive
 * them, and returns one upload entry per orphan so the next sync pass finishes
 * the job.
 *
 * A bookmark and its queue entry are written in two steps, so a storage hiccup
 * or the app being killed in between can leave a `pending`/`failed` bookmark
 * with nothing queued to sync it. With no entry the background loop never
 * touches it: it shows "sync pending" forever and stays un-editable (tags and
 * AI suggestions are gated until it has a remote identity). Seeded sample rows
 * that ship as `pending` are stranded the same way.
 *
 * Local-ID rows get a `create`; rows that already have a remote identity get an
 * `update`. Both are idempotent on the server (create dedupes on URL, update is
 * last-write-wins), so re-enqueuing a bookmark that actually did reach the
 * cloud is harmless. A local row with no URL is skipped: the create API needs a
 * URL (or shared text, which this app doesn't capture), so enqueuing one would
 * just swap "sync pending" for a permanently failed entry.
 */
export function reconcileOrphanedQueueEntries(
  bookmarks: Bookmark[],
  queue: LocalPendingBookmark[],
): LocalPendingBookmark[] {
  const queuedIds = new Set(queue.map((entry) => entry.local_id));
  const now = new Date().toISOString();
  const entries: LocalPendingBookmark[] = [];
  for (const bookmark of bookmarks) {
    if (bookmark.sync_status === 'synced' || queuedIds.has(bookmark.id)) {
      continue;
    }
    // Was this row EVER confirmed synced (ever_synced), even though it now
    // reads `pending` again because of a later edit whose own queue entry
    // never persisted? Rebuild it as an `update`. A genuinely new, never-
    // synced row (ever_synced unset) falls through to the `create` path below
    // instead — deliberately conservative: an `update`/`delete` against a row
    // that was never actually created remotely 404s and can get the local row
    // wrongly treated as "deleted on another device" (see isBookmarkGoneRemotely
    // in syncQueueEntry), which would silently destroy a fresh, unsynced
    // capture. The reverse mistake (re-`create`-ing an already-synced row) is
    // safe: the server's url_hash dedup resolves it as a duplicate.
    if (bookmark.ever_synced) {
      entries.push(makeMutationEntry(bookmark.id, 'update'));
      continue;
    }
    // Rebuild the create payload from the stored row — for a URL-less text note
    // this carries its body back as shared_text so it isn't stranded unsynced.
    const payload = createPayloadFromBookmark(bookmark);
    if (!isUploadableCreate(payload)) {
      continue;
    }
    entries.push({
      local_id: bookmark.id,
      remote_id: null,
      operation: 'create',
      payload,
      sync_status: 'pending',
      retry_count: 0,
      last_error: null,
      created_at: now,
      updated_at: now,
    });
  }
  return entries;
}
