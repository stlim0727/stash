import {
  dropPendingImportCollections,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import type { Bookmark, Collection, SyncChangeSource } from "@/domain/types";
import type {
  TagData
} from "@/storage/types";
import { useSupabaseAuth } from '@/supabase/auth-provider';
import {
  createSyncApi
} from "@/sync/sync-bookmarks";
import type { RefObject } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  pendingImportCollectionsRef: RefObject<PendingImportCollection[]>;
  applyPendingImportCollections: (next: PendingImportCollection[]) => void;
  applyBookmarkUpdate: (id: string, patch: Partial<Bookmark>, source?: SyncChangeSource) => void;
  auth: ReturnType<typeof useSupabaseAuth>;
  tagDataRef: RefObject<TagData>;
  applyTagData: (next: TagData, options?: { persist?: boolean; }) => void;
  bookmarksRef: RefObject<Bookmark[] | null>;
  clearAiRetry: (bookmarkId: string) => void;
  syncAiRetryIds: () => void;
  clearAiServerQueued: (bookmarkId: string) => void;
}

export function useCollectionCommands({
  pendingImportCollectionsRef,
  applyPendingImportCollections,
  applyBookmarkUpdate,
  auth,
  tagDataRef,
  applyTagData,
  bookmarksRef,
  clearAiRetry,
  syncAiRetryIds,
  clearAiServerQueued,
}: Dependencies) {

  const assignCollection = useCallback(
    (bookmarkId: string, collectionId: string | null, source: "user_edit" | "ai_apply" = "user_edit") => {
      // A direct user move is newer than an imported folder hint. Remove the
      // hint synchronously from the active outbox so a later retry cannot move
      // the bookmark back to its stale imported collection.
      const remaining = dropPendingImportCollections(
        pendingImportCollectionsRef.current,
        [bookmarkId],
      );
      if (remaining.length !== pendingImportCollectionsRef.current.length) {
        applyPendingImportCollections(remaining);
      }
      applyBookmarkUpdate(bookmarkId, { collection_id: collectionId }, source);
    },
    [applyBookmarkUpdate, applyPendingImportCollections],
  );

  const createCollection = useCallback(
    async (
      name: string,
    ): Promise<{ collection?: Collection; error?: string }> => {
      if (!auth.session) {
        return {
          error:
            "Collections need the cloud — Supabase is not available right now.",
        };
      }
      if (!name.trim()) {
        return { error: "Enter a collection name." };
      }
      try {
        const api = createSyncApi(auth.session);
        const created = await api.createCollection(name);
        const current = tagDataRef.current;
        applyTagData({
          ...current,
          collections: [...current.collections, created],
        });
        return { collection: created };
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "Could not create the collection.",
        };
      }
    },
    [auth, applyTagData],
  );

  const renameCollection = useCallback(
    async (
      collectionId: string,
      name: string,
    ): Promise<{ collection?: Collection; error?: string }> => {
      if (!auth.session) {
        return {
          error:
            "Collections need the cloud — Supabase is not available right now.",
        };
      }
      const trimmed = name.trim();
      if (!trimmed) {
        return { error: "Enter a collection name." };
      }
      try {
        const api = createSyncApi(auth.session);
        const updated = await api.updateCollection(collectionId, { name: trimmed });
        const current = tagDataRef.current;
        applyTagData({
          ...current,
          collections: current.collections.map((c) =>
            c.id === collectionId ? updated : c,
          ),
        });
        return { collection: updated };
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "Could not rename the collection.",
        };
      }
    },
    [auth, applyTagData],
  );

  const deleteCollections = useCallback(
    async (
      collectionIds: string[],
      action: "uncategorize" | "trash",
    ): Promise<{ error?: string }> => {
      if (!auth.session) {
        return {
          error:
            "Collections need the cloud — Supabase is not available right now.",
        };
      }
      if (collectionIds.length === 0) {
        return {};
      }
      try {
        const idSet = new Set(collectionIds);

        // Perform remote deletion first so if network/remote fails, local bookmarks
        // and collections remain completely intact without abandoned mutations in the outbox.
        const api = createSyncApi(auth.session);
        await api.deleteCollections(collectionIds, action);

        const affected = (bookmarksRef.current ?? []).filter(
          (b) => b.collection_id && idSet.has(b.collection_id),
        );
        for (const bookmark of affected) {
          if (action === "trash") {
            applyBookmarkUpdate(
              bookmark.id,
              {
                deleted_at: bookmark.deleted_at ?? new Date().toISOString(),
                collection_id: null,
              },
              "trash",
            );
            clearAiRetry(bookmark.id);
            syncAiRetryIds();
            clearAiServerQueued(bookmark.id);
          } else {
            assignCollection(bookmark.id, null);
          }
        }

        const current = tagDataRef.current;
        applyTagData({
          ...current,
          collections: current.collections.filter((c) => !idSet.has(c.id)),
        });

        return {};
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "Could not delete the collections.",
        };
      }
    },
    [
      auth,
      applyTagData,
      applyBookmarkUpdate,
      assignCollection,
      clearAiRetry,
      syncAiRetryIds,
      clearAiServerQueued,
    ],
  );

  const deleteCollection = useCallback(
    async (
      collectionId: string,
      action: "uncategorize" | "trash",
    ): Promise<{ error?: string }> => {
      return deleteCollections([collectionId], action);
    },
    [deleteCollections],
  );

  const mergeCollections = useCallback(
    async (
      sourceCollectionIds: string[],
      targetCollectionId: string,
    ): Promise<{ error?: string }> => {
      if (!auth.session) {
        return {
          error:
            "Collections need the cloud — Supabase is not available right now.",
        };
      }
      const target = tagDataRef.current.collections.find(
        (c) => c.id === targetCollectionId,
      );
      if (!target) {
        return { error: "Target collection not found." };
      }
      const sources = sourceCollectionIds.filter(
        (id) => id !== targetCollectionId,
      );
      if (sources.length === 0) {
        return {};
      }
      try {
        const sourceSet = new Set(sources);

        // Perform remote merge first so if network/remote fails, local bookmarks
        // and collections remain completely intact without abandoned mutations in the outbox.
        const api = createSyncApi(auth.session);
        await api.mergeCollections(sources, targetCollectionId);

        const affected = (bookmarksRef.current ?? []).filter(
          (b) => b.collection_id && sourceSet.has(b.collection_id),
        );
        for (const bookmark of affected) {
          assignCollection(bookmark.id, targetCollectionId);
        }

        const current = tagDataRef.current;
        applyTagData({
          ...current,
          collections: current.collections.filter((c) => !sourceSet.has(c.id)),
        });

        return {};
      } catch (error) {
        return {
          error:
            error instanceof Error
              ? error.message
              : "Could not merge the collections.",
        };
      }
    },
    [auth, applyTagData, assignCollection],
  );
  return { assignCollection, createCollection, renameCollection, deleteCollections, deleteCollection, mergeCollections };
}
