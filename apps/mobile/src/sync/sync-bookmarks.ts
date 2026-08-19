import { BOOKMARK_NOT_FOUND_ERROR_MESSAGE, createBookmarkApi } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import { createPayloadFromBookmark, isUploadableCreate } from '@/domain/create-payload';
import { isTransientNetworkError, isTransientSyncFailure } from '@/domain/network-errors';
import type {
  Bookmark,
  CreateBookmarkInput,
  LocalPendingBookmark,
  SyncErrorKind,
} from '@/domain/types';
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

/** Classify the failure while its runtime type is still available. A
 * SupabaseRequestError proves the server returned an HTTP response, even when
 * its body happens to contain transport-like wording such as "timed out". */
export function syncErrorKind(error: unknown): SyncErrorKind {
  if (error instanceof SupabaseRequestError) {
    return 'other';
  }
  return isTransientNetworkError(error) ? 'transient_network' : 'other';
}

/**
 * Retry count at which an ordinary stuck queue entry's health gets escalated
 * (see `applySyncQueueHealthEscalation` and its caller in store/bookmarks.tsx),
 * so a systemic sync problem — an API outage, a schema mismatch affecting
 * every upload — surfaces to the team without waiting for an in-app feedback
 * report. Deliberately low: 3 failed attempts already means automatic retry
 * alone hasn't resolved it.
 */
export const SYNC_QUEUE_HEALTH_ESCALATION_THRESHOLD = 3;

/** Offline/DNS failures are expected device state, not evidence of a broken
 * server contract. Give connectivity time to recover before escalating, while
 * still surfacing a genuinely prolonged outage. */
export const TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD = 6;

/**
 * Persist the one-time health-escalation transition on the queue entry itself.
 * Ordinary API/schema failures mark at retry 3; expected transport failures
 * wait until retry 6 (STASH-4Z). Requiring retry_count to advance prevents an
 * unattempted later bulk chunk from inheriting the attempted chunk's cause and
 * falsely alerting. The durable marker prevents duplicate alerts when failure
 * kinds change across retries or the app restarts.
 */
export function applySyncQueueHealthEscalation(
  previousEntry: LocalPendingBookmark,
  nextEntry: LocalPendingBookmark,
  escalatedAt: string,
): LocalPendingBookmark {
  if (
    previousEntry.health_escalated_at ||
    nextEntry.health_escalated_at ||
    nextEntry.sync_status !== 'failed' ||
    nextEntry.retry_count <= previousEntry.retry_count
  ) {
    return nextEntry;
  }
  const nextThreshold =
    nextEntry.last_error_kind === 'transient_network'
      ? TRANSIENT_NETWORK_HEALTH_ESCALATION_THRESHOLD
      : SYNC_QUEUE_HEALTH_ESCALATION_THRESHOLD;
  return nextEntry.retry_count >= nextThreshold
    ? { ...nextEntry, health_escalated_at: escalatedAt }
    : nextEntry;
}

/** True only for the write that first persisted the escalation marker. */
export function didSyncQueueHealthEscalate(
  previousEntry: LocalPendingBookmark,
  nextEntry: LocalPendingBookmark,
): boolean {
  return (
    previousEntry.operation === nextEntry.operation &&
    nextEntry.retry_count > previousEntry.retry_count &&
    !previousEntry.health_escalated_at &&
    Boolean(nextEntry.health_escalated_at)
  );
}

/**
 * Detects the STASH-3Y symptom ("queue count bounces/grows during a big bulk
 * sync"): a bulk-create chunk's own completed local ids that are STILL in the
 * queue after the chunk finished processing, even though nothing in this
 * chunk legitimately re-queued them.
 *
 * Deliberately id-scoped rather than a before/after total-length comparison —
 * a bulk-create chunk's processing spans several awaited storage writes, a
 * window long enough for unrelated capture/edit/delete activity elsewhere in
 * the app to legitimately change the queue's total length. Comparing totals
 * would make those false positives; comparing only this chunk's own
 * completed ids against its own re-queued ids is immune to that.
 *
 * `reenqueuedLocalIds` is the set of ids this chunk itself called
 * `enqueueMutation` for (mid-flight delete, reconcile follow-up) — those are
 * expected to still be queued and must not be flagged.
 */
export function findStaleQueueEntries(
  completedLocalIds: Iterable<string>,
  reenqueuedLocalIds: ReadonlySet<string>,
  queueLocalIds: Iterable<string>,
): string[] {
  const stillQueued = new Set(queueLocalIds);
  const stale: string[] = [];
  for (const id of completedLocalIds) {
    if (!reenqueuedLocalIds.has(id) && stillQueued.has(id)) {
      stale.push(id);
    }
  }
  return stale;
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
  const failedEntry = applySyncQueueHealthEscalation(entry, {
    ...entry,
    sync_status: 'failed',
    retry_count: entry.retry_count + 1,
    last_error: errorMessage(error),
    last_error_kind: syncErrorKind(error),
    last_attempt_at: now,
    updated_at: now,
  }, now);
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
  if (!latestAtUpload) {
    return entry.payload;
  }
  const payload: CreateBookmarkInput = {
    ...entry.payload,
    title: latestAtUpload.title ?? undefined,
    notes: latestAtUpload.notes ?? undefined,
    ...(latestAtUpload.deleted_at ? { deleted_at: latestAtUpload.deleted_at } : {}),
  };
  if (latestAtUpload.site_name !== null) {
    payload.site_name = latestAtUpload.site_name;
  }
  if (latestAtUpload.favicon_url !== null) {
    payload.favicon_url = latestAtUpload.favicon_url;
  }
  if (latestAtUpload.preview_image_url !== null) {
    payload.preview_image_url = latestAtUpload.preview_image_url;
  }
  if (latestAtUpload.metadata_status !== 'pending') {
    payload.metadata_status = latestAtUpload.metadata_status;
  }
  if (entry.payload.enrichment_policy) {
    payload.enrichment_policy = entry.payload.enrichment_policy;
  }
  return payload;
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
  // Image creates need an upload-then-create step this bulk path has no room
  // for (one request, no per-row side effect) — the caller must route them
  // through syncQueueEntry instead. Fail loudly rather than let one slip
  // through and get created without ever uploading its binary.
  if (entries.some((entry) => entry.payload.content_type === 'image')) {
    throw new Error('Bulk create sync does not support image bookmarks; use syncQueueEntry.');
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
      last_error_kind: null,
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
        removeEntry: true,
      });
      continue;
    }

    results.push({
      entry: syncedEntry,
      uploadedPayload: uploadedPayloads[index],
      originalLocalId: output.bookmark_id !== entry.local_id ? entry.local_id : undefined,
      removeEntry: true,
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
  /**
   * Uploads an image-only bookmark's binary to Storage and resolves its
   * public URL — required only for a `create` entry whose bookmark is
   * `content_type: 'image'` with a `local_image_uri` still needing upload
   * (`preview_image_url` still null). Injected (rather than importing a
   * native file API here) so this module stays platform-free and testable
   * under the Node runner via a fake; the real implementation lives in
   * `storage/image-store.native.ts` + `api/bookmarks.ts`'s
   * `imageUploadTarget`, wired together in `store/bookmarks.tsx`. Omitted
   * entirely on a platform with no uploader (web) — an image create that
   * needs one then fails cleanly instead of silently mis-syncing.
   */
  uploadImage?: (bookmark: Bookmark) => Promise<string>,
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
  // An image-only bookmark's row must never be created server-side before
  // its binary has genuinely landed (STASH-65 invariant — see
  // isLocalOnlyBookmark below). Upload first, splice the resulting URL into
  // the payload, THEN create. `!preview_image_url` makes this step-and-skip
  // idempotent across retries: once uploaded, a later retry (e.g. the
  // createBookmark call itself failing) sees it already set and moves
  // straight to create without re-uploading the same binary.
  let uploadedImageUrl: string | undefined;
  const bookmarkForUpload = getBookmark(entry.local_id);
  if (
    bookmarkForUpload?.content_type === 'image' &&
    bookmarkForUpload.local_image_uri &&
    !bookmarkForUpload.preview_image_url
  ) {
    if (!uploadImage) {
      return {
        entry: await failEntry(
          repository,
          entry,
          new Error('Image upload is not available on this platform.'),
          now,
        ),
      };
    }
    try {
      uploadedImageUrl = await uploadImage(bookmarkForUpload);
      // Persist immediately (not just carried in `payload` below) so a later
      // retry never re-uploads the same binary even if the create call that
      // follows fails. Re-read the row rather than reusing the pre-upload
      // `bookmarkForUpload` snapshot: the upload can take several seconds,
      // long enough for a concurrent title/notes edit to land in storage —
      // writing the stale snapshot here would silently revert it (see the
      // "full-row storage writes should re-read the freshest row" rule in
      // AGENTS.md's Known Traps). Falls back to the snapshot only if the row
      // is somehow gone from the live accessor by now.
      const freshestBookmark = getBookmark(entry.local_id) ?? bookmarkForUpload;
      await repository.updateBookmark({
        ...freshestBookmark,
        preview_image_url: uploadedImageUrl,
      });
    } catch (error) {
      return { entry: await failEntry(repository, entry, error, now) };
    }
  }

  // Send the LATEST user-authored fields, not the payload captured at save
  // time: the user may have edited title/notes before this upload ran.
  const payload = createUploadPayload(entry, getBookmark);
  if (uploadedImageUrl) {
    // createUploadPayload's own getBookmark() re-read may not reflect the
    // repository write above yet (it's backed by in-memory state, which can
    // lag a direct repository write) — set explicitly rather than relying on
    // that race resolving in our favor.
    payload.preview_image_url = uploadedImageUrl;
    payload.content_type = 'image';
  }
  try {
    const result = await api.createBookmark(payload);
    const syncedEntry: LocalPendingBookmark = {
      ...entry,
      remote_id: result.bookmark_id,
      sync_status: 'synced',
      last_error: null,
      last_error_kind: null,
      updated_at: now,
    };
    await repository.updateQueueEntry(syncedEntry);
    const finishCreate = async (): Promise<boolean> => {
      try {
        await removeQueueEntryIfNotSuperseded(repository, syncedEntry);
        return true;
      } catch {
        return false;
      }
    };

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
        // Guarantee the local row reflects what was actually just uploaded,
        // even if `localBookmark` (read from in-memory state) hadn't yet
        // caught up to the direct repository write above.
        ...(uploadedImageUrl ? { preview_image_url: uploadedImageUrl } : {}),
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
      const removeEntry = await finishCreate();
      return {
        entry: syncedEntry,
        bookmarkUpdate: syncedBookmark,
        uploadedPayload: payload,
        originalLocalId: isDuplicateSwap ? entry.local_id : undefined,
        removeEntry,
      };
    }

    const removeEntry = await finishCreate();
    return {
      entry: syncedEntry,
      uploadedPayload: payload,
      originalLocalId: result.bookmark_id !== entry.local_id ? entry.local_id : undefined,
      removeEntry,
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
 * url/title/notes, and the freshly-created remote row defaults to no collection,
 * active (not archived, not trashed), pending status. If the local row diverged
 * while the create was in flight because of a user-authored change — archived,
 * filed, edited, or TRASHED — those changes haven't reached the cloud yet, so
 * reconcile them with one follow-up update.
 *
 * Critically includes `deleted_at`: a bookmark trashed before it gained a
 * remote id uploads as an active create, so without this the cloud row stays
 * live and resurrects on other devices on the next pull. The `description`
 * clause covers text notes, whose body uploads as `shared_text` and lands in
 * the remote row's `description`: if the user edited the note before the create
 * ran, the body diverged and must be re-pushed too.
 *
 * Generated metadata fields deliberately do not trigger this predicate. Title
 * reconciliation needs an explicit user-edit signal from the caller because a
 * fetched page title is stored with `title_is_derived === false` too.
 */
export function createNeedsReconcileUpdate(
  persisted: Bookmark,
  uploadedPayload: CreateBookmarkInput | undefined,
  options: { titleChangedByUser?: boolean } = {},
): boolean {
  const uploadedTitle = uploadedPayload?.title ?? null;
  const titleNeedsReconcile =
    persisted.title !== uploadedTitle && options.titleChangedByUser === true;
  return (
    persisted.deleted_at !== null ||
    persisted.is_archived ||
    persisted.collection_id !== null ||
    titleNeedsReconcile ||
    persisted.notes !== (uploadedPayload?.notes ?? null) ||
    persisted.description !== (uploadedPayload?.shared_text ?? null)
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
    last_error_kind: null,
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

/**
 * True for a bookmark that is marked `sync_status: 'synced'` purely as a
 * local "no cloud work pending" bookkeeping choice, NOT because it was ever
 * actually confirmed by the server. Image bookmarks are the current case:
 * their binary upload is deferred (see `Bookmark.local_image_uri`), so
 * `addBookmark` marks them `synced` with a real UUID id and never enqueues
 * them (store/bookmarks.tsx). That combination is otherwise indistinguishable
 * from a genuinely cloud-confirmed row to `hasRemoteIdentity` + `sync_status`
 * checks, which caused STASH-65: the pull's remote-deletion diff treated a
 * freshly captured image bookmark — absent from the server by design — as
 * "deleted on another device" and deleted it locally within seconds of
 * capture. Every "is this row a confirmed cloud row" check must exclude
 * these rows alongside the existing seed/sample-row exclusion.
 *
 * `content_type: 'image'` alone is NOT sufficient: the server schema and
 * `RemoteBookmark` both allow an image row to be genuinely cloud-owned (an
 * imported row, a public-api-created one, or a future synced-image row —
 * `remoteToBookmark` in api/bookmarks.ts stamps any pulled row `ever_synced:
 * true` regardless of content_type). `ever_synced` is only ever set by a
 * confirmed pull or a confirmed upload response — never by local capture —
 * so requiring it to be unset is what actually distinguishes "never touched
 * the server" from "a real cloud image row this device just hasn't edited
 * since its last confirmed sync."
 */
export function isLocalOnlyBookmark(bookmark: Bookmark): boolean {
  return bookmark.content_type === 'image' && bookmark.ever_synced !== true;
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

/** A bulk-chunk request fails as a whole even when only one row in it is
 *  actually bad (e.g. one legacy too-long URL), so the caller can't blindly
 *  copy that shared error message onto every entry in the chunk — this text
 *  is a row-specific fact, not a chunk-wide one. Exported so the bulk-create
 *  failure handler can detect it BEFORE attributing an error to any entry,
 *  and fall back to per-entry sync to isolate which row actually caused it
 *  instead of misclassifying the rest of the chunk as permanently unsyncable
 *  too (caught in PR review). */
export function isRowSpecificPermanentSyncErrorText(message: string): boolean {
  return message.includes(URL_TOO_LONG_ERROR_TEXT);
}

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
    isRowSpecificPermanentSyncErrorText(entry.last_error)
  );
}

/**
 * Wall-clock backoff (ms) required since a `failed` upload entry's last
 * attempt before an automatic retry may pick it up again, indexed by the
 * entry's `retry_count` (1 = failed once, 2 = failed twice, ...). Mirrors the
 * shape of `AI_RETRY_BACKOFF_MS` (store/bookmarks.tsx) but on a much shorter
 * clock: an upload is cheap, time-sensitive work the user is waiting to reach
 * the cloud, where the AI schedule paces an expensive, quota-metered
 * background job. Caps at the last entry so an entry stuck failing forever
 * settles into a steady retry cadence instead of growing unbounded.
 *
 * Without this, `isSyncable` let ANY non-synced, non-permanently-broken entry
 * back into the next upload batch unconditionally — so a `syncNow` triggered
 * for an unrelated reason (a new save, a tag edit, an enrichment-driven
 * update) immediately re-attempted every already-failed entry too, with no
 * gap between attempts. During an outage (e.g. Sentry STASH-4Z's DNS
 * resolution failure) or a large import this produced an unthrottled retry
 * loop and a queue/sync count that visibly oscillated instead of settling.
 */
export const UPLOAD_RETRY_BACKOFF_MS: readonly number[] = [
  5_000, // after the 1st failed attempt
  15_000, // after the 2nd
  30_000, // after the 3rd
  60_000, // after the 4th
  2 * 60_000, // after the 5th
  5 * 60_000, // after the 6th and every attempt beyond (cap)
];

/**
 * A DNS/transport failure (device offline, host unresolved, connection
 * reset — see `isTransientNetworkError`) will keep failing with near
 * certainty until connectivity actually returns, unlike a one-off server
 * error that might already be resolved. Retrying it on the same short
 * cadence as an ordinary failure just burns battery/network on guaranteed-
 * doomed requests, so it earns a longer wait instead.
 */
const TRANSIENT_NETWORK_BACKOFF_MULTIPLIER = 3;

/** How long a `failed` entry must still wait before its next automatic retry. */
export function uploadRetryBackoffMs(entry: LocalPendingBookmark): number {
  if (entry.retry_count <= 0) {
    return 0;
  }
  const index = Math.min(entry.retry_count - 1, UPLOAD_RETRY_BACKOFF_MS.length - 1);
  const base = UPLOAD_RETRY_BACKOFF_MS[index]!;
  return isTransientSyncFailure(entry) ? base * TRANSIENT_NETWORK_BACKOFF_MULTIPLIER : base;
}

export interface IsSyncableOptions {
  /** Clock to evaluate backoff against. Defaults to `Date.now()`; tests pass
   *  an explicit value for determinism. */
  now?: number;
  /**
   * Skip the backoff check entirely — for an explicit, user-initiated retry
   * (the Settings "Sync now" tap; see `syncNow`'s `force` option), which is
   * exactly the escape hatch the backoff is meant to leave open. Automatic
   * triggers (a save, the debounced auto-sync effect, a realtime nudge) must
   * NOT set this, or the backoff they're gated by never has any effect.
   * Never bypasses the permanently-unsyncable-URL check above — that failure
   * can never succeed no matter who asks.
   */
  ignoreBackoff?: boolean;
}

export function isSyncable(entry: LocalPendingBookmark, options: IsSyncableOptions = {}): boolean {
  // Anything not yet 'synced' is eligible. 'syncing' is included so an entry
  // that an interrupted run left in-flight (e.g. the app was backgrounded or a
  // storage write threw mid-upload) is retried rather than orphaned forever.
  // The one exception is a permanently-too-long URL (above): retrying it can
  // never succeed, so excluding it here stops both the automatic sync effect
  // and an explicit "Sync now" from hammering the same doomed request.
  if (entry.sync_status === 'synced' || isPermanentlyUnsyncableUrl(entry)) {
    return false;
  }
  if (options.ignoreBackoff) {
    return true;
  }
  // Only a `failed` entry with a recorded last attempt is backoff-gated.
  // `pending`/`syncing` entries (never failed, or mid-flight) are always
  // eligible, and an entry with no `last_attempt_at` — never failed before,
  // or a pre-backoff queue row already on a device — is treated as
  // immediately retryable rather than blocked.
  if (entry.sync_status !== 'failed' || !entry.last_attempt_at) {
    return true;
  }
  const now = options.now ?? Date.now();
  const readyAt = new Date(entry.last_attempt_at).getTime() + uploadRetryBackoffMs(entry);
  return now >= readyAt;
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
 * cloud is harmless. A URL-less row is only skipped when it's ALSO not a text
 * note and not an image: `isUploadableCreate`/`createPayloadFromBookmark`
 * (domain/create-payload.ts) rebuild a text note's body as `shared_text` and
 * an image row as `content_type: 'image'` (its binary, if not yet uploaded,
 * is uploaded by `syncQueueEntry` itself once this entry is picked up — see
 * its `uploadImage` parameter), so both are genuinely reconcilable. Only a
 * row with none of url/shared_text-body/image is skipped, since enqueuing one
 * would just swap "sync pending" for a permanently failed entry.
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
      last_error_kind: null,
      created_at: now,
      updated_at: now,
    });
  }
  return entries;
}
