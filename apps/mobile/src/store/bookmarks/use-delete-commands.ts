import {
  dropPendingEnrichmentRestores,
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  dropPendingImportCollections,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import {
  dropPendingTagOpsForBookmarks,
  type PendingTagOp
} from "@/domain/pending-tags";
import type {
  Bookmark, LocalPendingBookmark,
  SyncChangeSource
} from "@/domain/types";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { isBookmarkSyncedOnce, logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import {
  createSyncApi,
  makeMutationEntry
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  bookmarksRef: RefObject<Bookmark[] | null>;
  deletedIds: RefObject<Set<string>>;
  applyTagOps: (next: PendingTagOp[], options?: { persist?: boolean; }) => Promise<boolean>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  applyPendingImportCollections: (next: PendingImportCollection[]) => void;
  pendingImportCollectionsRef: RefObject<PendingImportCollection[]>;
  applyPendingEnrichmentRestores: (next: PendingEnrichmentRestore[]) => void;
  pendingEnrichmentRestoresRef: RefObject<PendingEnrichmentRestore[]>;
  applyTagData: (next: TagData, options?: { persist?: boolean; }) => void;
  tagDataRef: RefObject<TagData>;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  clearAiRetry: (bookmarkId: string) => void;
  syncAiRetryIds: () => void;
  clearAiServerQueued: (bookmarkId: string) => void;
  auth: ReturnType<typeof useSupabaseAuth>;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => void;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  dropAiRetryBookkeeping: (ids: readonly string[]) => void;
}

export function useDeleteCommands({
  bookmarksRef,
  deletedIds,
  applyTagOps,
  pendingTagOpsRef,
  applyPendingImportCollections,
  pendingImportCollectionsRef,
  applyPendingEnrichmentRestores,
  pendingEnrichmentRestoresRef,
  applyTagData,
  tagDataRef,
  hasSyncedOnce,
  setBookmarks,
  clearAiRetry,
  syncAiRetryIds,
  clearAiServerQueued,
  auth,
  enqueueMutation,
  setQueue,
  queueRef,
  dropAiRetryBookkeeping,
}: Dependencies) {

  const deleteBookmark = useCallback(
    (id: string) => {
      const bookmark = bookmarksRef.current?.find((b) => b.id === id);
      deletedIds.current.add(id);
      applyTagOps(
        dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, [id]),
      );
      applyPendingImportCollections(
        dropPendingImportCollections(pendingImportCollectionsRef.current, [id]),
      );
      applyPendingEnrichmentRestores(
        dropPendingEnrichmentRestores(pendingEnrichmentRestoresRef.current, [
          id,
        ]),
      );
      applyTagData({
        ...tagDataRef.current,
        bookmarkTags: tagDataRef.current.bookmarkTags.filter(
          (link) => link.bookmark_id !== id,
        ),
      });
      const hadSyncedOnce = hasSyncedOnce(id);
      setBookmarks((current) =>
        current === null ? current : current.filter((b) => b.id !== id),
      );
      bookmarksRef.current =
        bookmarksRef.current?.filter((bookmark) => bookmark.id !== id) ?? null;
      // A gone-forever row has nothing left to retry enriching — drop any
      // armed AI-retry marker so a future backoff check doesn't keep firing
      // doomed requests against a deleted bookmark.
      clearAiRetry(id);
      syncAiRetryIds();
      // Same rationale as above: a permanently-gone row has nothing left to
      // wait for from the server-side overflow queue either.
      clearAiServerQueued(id);
      // Best-effort: an image bookmark with a preview_image_url owns a real
      // object in the bookmark-images bucket. Gated on the URL itself, NOT
      // on hasSyncedOnce/ever_synced: the upload can succeed and durably set
      // preview_image_url even when the FOLLOWING createBookmark call then
      // fails (or is never retried again) — ever_synced only flips once the
      // row itself is confirmed created, so that row would otherwise never
      // be cleaned up despite genuinely owning an uploaded object.
      // Permanently deleting the row must not leave that object behind — it
      // would stay indefinitely public (this bucket is public-read by
      // design) and keep counting against storage. Fire-and-forget, matching
      // the existing best-effort network-call pattern elsewhere in this app
      // (e.g. StashSupabaseClient.signOut's server-side revoke): a failure
      // here just leaves an orphaned object, never blocks or retries the
      // bookmark delete itself. Never runs for a Trash move (trashBookmark,
      // a separate function, soft-deletes via deleted_at) — only this
      // permanent path.
      if (bookmark?.content_type === "image" && bookmark.preview_image_url && auth.session) {
        // Refresh a token that expired while the app stayed open, mirroring
        // syncNow/resetLibrary — otherwise this DELETE 401s, gets swallowed
        // by the catch below, and is never retried or queued anywhere, so
        // the object silently stays orphaned forever even though the
        // bookmark deletion itself (a separately-refreshed sync pass) can
        // still succeed.
        void (async () => {
          const session = (await auth.ensureAnonymousSession()) ?? auth.session;
          if (!session) {
            return;
          }
          await createSyncApi(session).deleteImages([id]);
        })().catch((error) =>
          logStorageError("delete bookmark image object", error),
        );
      }
      if (hadSyncedOnce) {
        // The row exists remotely: replace any queued work with a durable
        // delete mutation so the removal reaches Supabase even after restart.
        ensureRepositoryReady()
          .then(() => repository.deleteBookmark(id))
          .catch((error) => logStorageError("delete bookmark", error));
        enqueueMutation(id, "delete");
        return;
      }
      // Local-only: drop any pending queue entry so it is never created remotely.
      setQueue((current) => current.filter((entry) => entry.local_id !== id));
      queueRef.current = queueRef.current.filter(
        (entry) => entry.local_id !== id,
      );
      ensureRepositoryReady()
        .then(() =>
          Promise.all([
            repository.deleteBookmark(id),
            repository.removeQueueEntry(id),
          ]),
        )
        .catch((error) => logStorageError("delete bookmark", error));
    },
    [
      auth,
      applyPendingImportCollections,
      applyPendingEnrichmentRestores,
      applyTagData,
      applyTagOps,
      enqueueMutation,
      clearAiRetry,
      syncAiRetryIds,
      clearAiServerQueued,
      hasSyncedOnce,
    ],
  );

  const emptyTrash = useCallback(() => {
    const trashed = (bookmarksRef.current ?? []).filter(
      (b) => b.deleted_at != null,
    );
    if (trashed.length === 0) {
      return;
    }
    const ids = trashed.map((bookmark) => bookmark.id);
    const deleted = new Set(ids);
    for (const id of ids) {
      deletedIds.current.add(id);
    }

    // Persist each organization snapshot once for the whole operation. Calling
    // deleteBookmark in a loop would fan out three full-snapshot writes per row
    // onto the single native SQLite actor.
    applyTagOps(dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, ids));
    applyPendingImportCollections(
      dropPendingImportCollections(pendingImportCollectionsRef.current, ids),
    );
    applyPendingEnrichmentRestores(
      dropPendingEnrichmentRestores(pendingEnrichmentRestoresRef.current, ids),
    );
    applyTagData({
      ...tagDataRef.current,
      bookmarkTags: tagDataRef.current.bookmarkTags.filter(
        (link) => !deleted.has(link.bookmark_id),
      ),
    });
    dropAiRetryBookkeeping(ids);

    const deleteEntries = trashed
      .filter((bookmark) => isBookmarkSyncedOnce(bookmark))
      .map((bookmark) => makeMutationEntry(bookmark.id, "delete"));
    // Best-effort bulk cleanup of any uploaded bookmark-images objects —
    // same rationale as deleteBookmark's single-row cleanup above: emptying
    // Trash must not leave those objects behind (public, still counted
    // against storage) even though this row is now gone for good. Gated on
    // preview_image_url itself, not isBookmarkSyncedOnce — an upload can
    // durably succeed even when the row's own create never gets confirmed
    // (ever_synced stays false), and that row still owns a real object.
    const imageIdsToDeleteFromStorage = trashed
      .filter((bookmark) => bookmark.content_type === "image" && bookmark.preview_image_url)
      .map((bookmark) => bookmark.id);
    if (imageIdsToDeleteFromStorage.length > 0 && auth.session) {
      // Refresh a token that expired while the app stayed open, mirroring
      // syncNow/resetLibrary and deleteBookmark's identical fix above —
      // otherwise this DELETE 401s and is silently lost.
      void (async () => {
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
        if (!session) {
          return;
        }
        await createSyncApi(session).deleteImages(imageIdsToDeleteFromStorage);
      })().catch((error) => logStorageError("empty trash image objects", error));
    }
    const nextQueue = [
      ...queueRef.current.filter((entry) => !deleted.has(entry.local_id)),
      ...deleteEntries,
    ];
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    bookmarksRef.current = (bookmarksRef.current ?? []).filter(
      (bookmark) => !deleted.has(bookmark.id),
    );
    setBookmarks(
      (current) =>
        current?.filter((bookmark) => !deleted.has(bookmark.id)) ?? current,
    );

    const deleteEntryById = new Map(
      deleteEntries.map((entry) => [entry.local_id, entry]),
    );
    void ensureRepositoryReady()
      .then(async () => {
        for (const bookmark of trashed) {
          const entry = deleteEntryById.get(bookmark.id);
          if (entry) {
            await repository.enqueue(entry);
          } else {
            await repository.removeQueueEntry(bookmark.id);
          }
          await repository.deleteBookmark(bookmark.id);
        }
      })
      .catch((error) => logStorageError("empty trash", error));
  }, [
    auth,
    applyPendingImportCollections,
    applyPendingEnrichmentRestores,
    applyTagData,
    applyTagOps,
    dropAiRetryBookkeeping,
  ]);
  return { deleteBookmark, emptyTrash };
}
