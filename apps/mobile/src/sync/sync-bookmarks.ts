import { createBookmarkApi } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import { createPayloadFromBookmark, isUploadableCreate } from '@/domain/create-payload';
import type { Bookmark, CreateBookmarkInput, LocalPendingBookmark } from '@/domain/types';
import { recordLog } from '@/observability/log-buffer';
import type { BookmarkRepository } from '@/storage/types';
import { SupabaseRequestError } from '@/supabase/client';
import type { SupabaseAuthSession } from '@/supabase/types';

export interface EntrySyncResult {
  entry: LocalPendingBookmark;
  /** Present when the local bookmark row was rewritten (local ID -> remote ID). */
  bookmarkReplacement?: { previousId: string; bookmark: Bookmark };
  /** True when the entry's work is finished and it can leave the queue. */
  removeEntry?: boolean;
  /** For creates: what was actually sent, so callers can reconcile later edits. */
  uploadedPayload?: CreateBookmarkInput;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sync failed.';
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
  if (!stored || stored.operation === entry.operation) {
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
  await repository.updateQueueEntry(failedEntry);
  return failedEntry;
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

/**
 * Performs one queue entry's remote operation. All three are safe to retry:
 * `create` is idempotent on the server (URL dedupe + unique-conflict
 * handling), `update` re-sends the bookmark's current user-editable fields
 * (last write wins), and `delete` treats an already-deleted row as success.
 * Failures stay in the queue as retryable with the error recorded.
 *
 * `getBookmark` must return the LATEST local row — not a snapshot — so
 * concurrent enrichment or edits are never overwritten by stale data.
 *
 * `hasPendingCreate(localId)` reports whether a not-yet-synced `create` entry
 * for the same local id is still in the queue. It decides what to do with an
 * `update`/`delete` that still targets a device-local id (see the guard below).
 */
export async function syncQueueEntry(
  api: BookmarkApi,
  repository: BookmarkRepository,
  entry: LocalPendingBookmark,
  getBookmark: (id: string) => Bookmark | undefined,
  hasPendingCreate: (localId: string) => boolean = () => false,
): Promise<EntrySyncResult> {
  const now = new Date().toISOString();

  // Final guard before anything leaves the device: an `update`/`delete` must
  // target a row that exists remotely. If its id is still a device-local
  // (`local-…`) or seeded (`bookmark-…`) id, sending the op would push a
  // non-UUID into a Postgres `uuid` column and the server 400s ("invalid input
  // syntax for type uuid"), wedging the entry in a retry loop (issue #237).
  //
  // What to do depends on whether reconciliation is genuinely coming. A pending
  // `create` for the same local id WILL re-key this entry onto the remote id
  // once it lands, so DEFER (leave it pending, untouched) and let it ride behind
  // that create. But if there is no such create — an orphaned mutation whose
  // create already settled, can never succeed, or was never enqueued — nothing
  // will ever re-key it. Returning it `pending` then hot-loops the auto-sync
  // effect (which re-fires on any `pending` entry), so resolve it instead:
  //   - delete: the row never reached the server (its id is still local) and the
  //     local delete already happened, so there is nothing to delete remotely —
  //     remove the queue entry so it leaves cleanly.
  //   - update: the bookmark's `create` never reached the server, yet an `update`
  //     needs a remote row to target — so it can NEVER succeed and just re-fails
  //     every pass, stranding the bookmark as "sync failed" forever (visible in
  //     the queue with a climbing retry count). The local row still exists, so
  //     RECOVER by promoting this entry to a `create`: rebuild the create payload
  //     from the row and fall through to the create path below, which uploads it
  //     (idempotent on URL — a duplicate reuses the existing row), re-keys the
  //     bookmark onto its new remote id, and lets the caller reconcile any
  //     diverged fields. Only when the row is gone, or can't be expressed as a
  //     create (no URL and no text), is there nothing to upload — settle then.
  if (entry.operation !== 'create') {
    // Mirror exactly what each branch sends to the server: `update` targets
    // `local_id`, `delete` targets `remote_id ?? local_id`.
    const targetId =
      entry.operation === 'delete' ? entry.remote_id ?? entry.local_id : entry.local_id;
    if (!hasRemoteIdentity(targetId)) {
      if (hasPendingCreate(entry.local_id)) {
        // Reconcilable: a create is coming to swap this onto its remote id.
        return { entry: { ...entry, sync_status: 'pending' } };
      }
      if (entry.operation === 'delete') {
        // Nothing exists remotely; the local delete already ran. Settle.
        await removeQueueEntryIfNotSuperseded(repository, entry);
        return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
      }
      // Orphaned update — promote to a create so the bookmark can finally reach
      // the server (see the comment above for why a bare update can't).
      const localRow = getBookmark(entry.local_id);
      if (!localRow) {
        // The row is gone locally; there is nothing left to update or create.
        await removeQueueEntryIfNotSuperseded(repository, entry);
        return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
      }
      const rebuiltPayload = createPayloadFromBookmark(localRow);
      if (!isUploadableCreate(rebuiltPayload)) {
        // No URL and no text body: a create can't carry it. Settle as `failed`
        // (does NOT re-fire the auto-sync loop) so it stops hot-looping while
        // still retrying on the next save or a manual Sync.
        return {
          entry: await failEntry(
            repository,
            entry,
            new Error('Cannot sync: bookmark has no remote identity yet.'),
            now,
          ),
        };
      }
      // Rewrite this entry into a `create` and let the create path below run it.
      // Keeps the same local_id key so the queue row is replaced, not duplicated.
      entry = {
        ...entry,
        operation: 'create',
        payload: rebuiltPayload,
        sync_status: 'pending',
        last_error: null,
      };
    }
  }

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
        const syncedBookmark: Bookmark = { ...bookmark, sync_status: 'synced', updated_at: now };
        await repository.updateBookmark(syncedBookmark);
        return {
          entry: { ...entry, sync_status: 'synced', updated_at: now },
          bookmarkReplacement: { previousId: bookmark.id, bookmark: syncedBookmark },
          removeEntry: true,
        };
      }
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    } catch (error) {
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
  const latestAtUpload = getBookmark(entry.local_id);
  const payload: CreateBookmarkInput = latestAtUpload
    ? {
        ...entry.payload,
        title: latestAtUpload.title ?? undefined,
        notes: latestAtUpload.notes ?? undefined,
      }
    : entry.payload;
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
    if (localBookmark) {
      const syncedBookmark: Bookmark = {
        ...localBookmark,
        id: result.bookmark_id,
        sync_status: 'synced',
        updated_at: now,
      };
      await repository.replaceBookmark(localBookmark.id, syncedBookmark);
      return {
        entry: syncedEntry,
        bookmarkReplacement: { previousId: localBookmark.id, bookmark: syncedBookmark },
        uploadedPayload: payload,
      };
    }

    return { entry: syncedEntry, uploadedPayload: payload };
  } catch (error) {
    const failedEntry = await failEntry(repository, entry, error, now);
    const localBookmark = getBookmark(entry.local_id);
    if (localBookmark && localBookmark.sync_status !== 'failed') {
      const failedBookmark: Bookmark = { ...localBookmark, sync_status: 'failed' };
      await repository.updateBookmark(failedBookmark);
      return {
        entry: failedEntry,
        bookmarkReplacement: { previousId: localBookmark.id, bookmark: failedBookmark },
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
 * True once a bookmark's id refers to a remote row rather than a device-local
 * one. Remote IDs are Supabase-generated UUIDs; device-local IDs (`local-…`)
 * and seeded sample IDs (`bookmark-…`) are not, and must never be targeted by
 * remote mutations.
 */
export function hasRemoteIdentity(bookmarkId: string): boolean {
  return UUID_PATTERN.test(bookmarkId);
}

export function createSyncApi(session: SupabaseAuthSession): BookmarkApi {
  return createBookmarkApi(session);
}

export function isSyncable(entry: LocalPendingBookmark): boolean {
  // Anything not yet 'synced' is eligible. 'syncing' is included so an entry
  // that an interrupted run left in-flight (e.g. the app was backgrounded or a
  // storage write threw mid-upload) is retried rather than orphaned forever.
  return entry.sync_status !== 'synced';
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
/** A local→remote identity swap computed for a synced-leftover queue entry. */
export interface LeftoverSwap {
  localId: string;
  reconciled: Bookmark;
}

/**
 * Identifies synced queue leftovers that still need a local-ID → remote-ID
 * swap on the bookmark row. A `create` marks its queue entry `synced` (with
 * the new remote_id) BEFORE swapping the local bookmark ID; if the app was
 * killed between those writes the queue entry survives but the bookmark is
 * still under the old local-* id. This pure planner finds those stragglers —
 * the caller applies the swaps and removes the queue entries.
 */
export function planLeftoverReconciliation(
  leftovers: LocalPendingBookmark[],
  bookmarks: Bookmark[],
): LeftoverSwap[] {
  const swaps: LeftoverSwap[] = [];
  for (const leftover of leftovers) {
    const remoteId = leftover.remote_id;
    if (!remoteId || remoteId === leftover.local_id) continue; // update/delete leftover, or already reconciled
    const localRow = bookmarks.find((b) => b.id === leftover.local_id);
    if (!localRow) continue; // swap already completed — row is under the remote id
    swaps.push({ localId: leftover.local_id, reconciled: { ...localRow, id: remoteId, sync_status: 'synced' } });
  }
  return swaps;
}

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
    if (hasRemoteIdentity(bookmark.id)) {
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
