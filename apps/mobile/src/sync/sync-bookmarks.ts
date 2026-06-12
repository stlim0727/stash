import { createBookmarkApi } from '@/api/bookmarks';
import type { BookmarkApi } from '@/api/bookmarks';
import type { Bookmark, LocalPendingBookmark } from '@/domain/types';
import type { BookmarkRepository } from '@/storage/types';
import type { SupabaseAuthSession } from '@/supabase/types';

export interface EntrySyncResult {
  entry: LocalPendingBookmark;
  /** Present when the local bookmark row was rewritten (local ID -> remote ID). */
  bookmarkReplacement?: { previousId: string; bookmark: Bookmark };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Sync failed.';
}

/**
 * Uploads one queue entry via createBookmark, which is idempotent on the
 * server (URL dedupe + unique-conflict handling), so retries cannot create
 * duplicate remote rows. The local bookmark row adopts the remote ID and a
 * synced status; failures stay in the queue as retryable with the error
 * recorded.
 */
export async function syncQueueEntry(
  api: BookmarkApi,
  repository: BookmarkRepository,
  entry: LocalPendingBookmark,
  localBookmark: Bookmark | undefined,
): Promise<EntrySyncResult> {
  const now = new Date().toISOString();

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
    const failedEntry: LocalPendingBookmark = {
      ...entry,
      sync_status: 'failed',
      retry_count: entry.retry_count + 1,
      last_error: errorMessage(error),
      updated_at: now,
    };
    await repository.updateQueueEntry(failedEntry);

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

export function createSyncApi(session: SupabaseAuthSession): BookmarkApi {
  return createBookmarkApi(session);
}

export function isSyncable(entry: LocalPendingBookmark): boolean {
  return entry.sync_status === 'pending' || entry.sync_status === 'failed';
}
