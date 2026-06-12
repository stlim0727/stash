import { createBookmarkApi } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';
import type { SupabaseAuthSession } from '@/supabase/types';

export interface EntrySyncResult {
  entry: LocalPendingBookmark;
  /** Present when the local bookmark row was rewritten (local ID -> remote ID). */
  bookmarkReplacement?: { previousId: string; bookmark: Bookmark };
  /** True when the entry's work is finished and it can leave the queue. */
  removeEntry?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sync failed.';
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
      // The bookmark is gone locally; nothing left to update remotely.
      await repository.removeQueueEntry(entry.local_id);
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    }
    try {
      await api.updateBookmark(entry.local_id, {
        title: bookmark.title,
        description: bookmark.description,
        notes: bookmark.notes,
        collection_id: bookmark.collection_id,
        is_archived: bookmark.is_archived,
      });
      await repository.removeQueueEntry(entry.local_id);
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
      await repository.removeQueueEntry(entry.local_id);
      return { entry: { ...entry, sync_status: 'synced', updated_at: now }, removeEntry: true };
    } catch (error) {
      return { entry: await failEntry(repository, entry, error, now) };
    }
  }

  // operation === 'create'
  try {
    const result = await api.createBookmark(entry.payload);
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
      };
    }

    return { entry: syncedEntry };
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

/** True once a bookmark's id refers to a remote row rather than a device-local one. */
export function hasRemoteIdentity(bookmarkId: string): boolean {
  return !bookmarkId.startsWith('local-');
}

export function createSyncApi(session: SupabaseAuthSession): BookmarkApi {
  return createBookmarkApi(session);
}

export function isSyncable(entry: LocalPendingBookmark): boolean {
  return entry.sync_status === 'pending' || entry.sync_status === 'failed';
}
