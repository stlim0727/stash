import type {
  BulkAttachItem,
  BulkAttachResult
} from "@/api/bookmarks";
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import type {
  AIEnrichment,
  Bookmark
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import type { SupabaseAuthSession } from "@/supabase/types";
import { isFollowupReady } from "@/sync/automatic-retry";
import {
  BULK_CREATE_SYNC_CHUNK_SIZE,
  createSyncApi,
  syncErrorKind
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  auth: ReturnType<typeof useSupabaseAuth>;
  syncPausedRef: RefObject<boolean>;
  pendingImportCollectionsRef: RefObject<PendingImportCollection[]>;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  legacyFollowupAttemptAt: RefObject<number>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  setPendingImportCollections: Dispatch<SetStateAction<PendingImportCollection[]>>;
  tagDataRef: RefObject<TagData>;
  setTagData: Dispatch<SetStateAction<TagData>>;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  pendingEnrichmentRestoresRef: RefObject<PendingEnrichmentRestore[]>;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  setPendingEnrichmentRestores: Dispatch<SetStateAction<PendingEnrichmentRestore[]>>;
}

export function useImportOutboxSync({
  auth,
  syncPausedRef,
  pendingImportCollectionsRef,
  hasSyncedOnce,
  legacyFollowupAttemptAt,
  bookmarksRef,
  setPendingImportCollections,
  tagDataRef,
  setTagData,
  setBookmarks,
  pendingEnrichmentRestoresRef,
  setEnrichments,
  setPendingEnrichmentRestores,
}: Dependencies) {

  // Same batch-attach RPC as syncTagOps above (issue #713): group eligible
  // imported-collection intents by bookmark, chunk, and resolve-or-create each
  // collection server-side in one call per chunk instead of one
  // `createCollection`/`updateBookmark` round trip per bookmark.
  const syncPendingImportCollections =
    useCallback(async (force = false, session: SupabaseAuthSession | null = auth.session, recoverAuth = false): Promise<boolean> => {
      if (!session || syncPausedRef.current) {
        return false;
      }
      const eligible = pendingImportCollectionsRef.current.filter((item) =>
        hasSyncedOnce(item.bookmark_id) && isFollowupReady(item, Date.now(), legacyFollowupAttemptAt.current, force || (recoverAuth && item.last_error_kind === "auth")),
      );
      if (eligible.length === 0) {
        return false;
      }

      const api = createSyncApi(session);
      let mutationsPushed = false;

      // Local fast-path: an import re-run, a restore, or a manual move that
      // already landed locally must not clobber an existing assignment — drop
      // those intents without a network call. Ref/state updated immediately;
      // the SQLite write is batched once after the loop (see below) — a bulk
      // import's ~300 entries here must not each persist the whole shrinking
      // list individually.
      const itemsByBookmark = new Map<string, PendingImportCollection>();
      for (const item of eligible) {
        const currentBookmark = bookmarksRef.current?.find(
          (bookmark) => bookmark.id === item.bookmark_id,
        );
        if (currentBookmark?.collection_id) {
          const remaining = pendingImportCollectionsRef.current.filter(
            (candidate) => candidate.bookmark_id !== item.bookmark_id,
          );
          pendingImportCollectionsRef.current = remaining;
          setPendingImportCollections(remaining);
          continue;
        }
        itemsByBookmark.set(item.bookmark_id, item);
      }
      const bookmarkIds = [...itemsByBookmark.keys()];

      for (let i = 0; i < bookmarkIds.length; i += BULK_CREATE_SYNC_CHUNK_SIZE) {
        if (syncPausedRef.current) {
          break;
        }
        const chunkIds = bookmarkIds.slice(i, i + BULK_CREATE_SYNC_CHUNK_SIZE);
        const chunkItems: BulkAttachItem[] = chunkIds.map((bookmarkId) => ({
          bookmark_id: bookmarkId,
          tags: [],
          collection_name: itemsByBookmark.get(bookmarkId)!.collection_name,
        }));
        try {
          const results: BulkAttachResult[] =
            await api.bulkAttachTagsAndCollections(chunkItems);
          // Each bookmark's own SQLite row write stays immediate and
          // sequential (one row at a time — see
          // docs/architecture/sqlite-write-contention.md), but the React
          // re-renders (setBookmarks/setTagData) and the collections
          // catalog's SQLite write are batched to once per chunk instead of
          // once per bookmark. Without this, a landed chunk of 50 still
          // visibly trickles in one row at a time even though the network
          // call and the per-row writes themselves are already batched/safe
          // (bli9833 backlog, follow-up to #713/#719).
          let chunkHasNewCollection = false;
          const chunkBookmarkUpdates = new Map<string, Bookmark>();
          for (const result of results) {
            const item = itemsByBookmark.get(result.bookmark_id);
            if (!item || !result.collection) {
              continue;
            }

            if (
              !tagDataRef.current.collections.some(
                (candidate) => candidate.id === result.collection!.id,
              )
            ) {
              tagDataRef.current = {
                ...tagDataRef.current,
                collections: [...tagDataRef.current.collections, result.collection],
              };
              chunkHasNewCollection = true;
            }

            // A manual move can race an in-flight import: re-check the intent
            // is still queued (assignCollection drops it synchronously on a
            // manual reassignment) and the bookmark is still unassigned
            // before applying the server's resolved collection locally. The
            // RPC's own `collection_id is null` guard protects the remote row
            // the same way; this mirrors it for the local optimistic write.
            const intentIsCurrent = pendingImportCollectionsRef.current.some(
              (candidate) =>
                candidate.bookmark_id === item.bookmark_id &&
                candidate.created_at === item.created_at &&
                candidate.collection_name === item.collection_name,
            );
            const latest = bookmarksRef.current?.find(
              (bookmark) => bookmark.id === item.bookmark_id,
            );
            if (
              result.collection_attached &&
              intentIsCurrent &&
              latest &&
              latest.collection_id === null
            ) {
              const updated: Bookmark = {
                ...latest,
                collection_id: result.collection.id,
                updated_at: result.bookmark_updated_at ?? latest.updated_at,
              };
              await repository.updateBookmark(updated);
              bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
                bookmark.id === updated.id ? updated : bookmark,
              );
              chunkBookmarkUpdates.set(updated.id, updated);
            }

            mutationsPushed = true;
            pendingImportCollectionsRef.current =
              pendingImportCollectionsRef.current.filter(
                (candidate) => candidate.bookmark_id !== item.bookmark_id,
              );
          }

          if (chunkHasNewCollection) {
            await repository.replaceTagData(tagDataRef.current);
            setTagData(tagDataRef.current);
          }
          if (chunkBookmarkUpdates.size > 0) {
            setBookmarks(
              (current) =>
                current?.map((bookmark) =>
                  chunkBookmarkUpdates.has(bookmark.id)
                    ? chunkBookmarkUpdates.get(bookmark.id)!
                    : bookmark,
                ) ?? current,
            );
          }
          setPendingImportCollections(pendingImportCollectionsRef.current);
        } catch (error) {
          // Per-chunk failure: mark every item in this chunk failed rather
          // than parse partial success out of the RPC's returned array —
          // today's per-item failure tracking already just means "retry on
          // the next sync," so this is an acceptable, simpler first cut.
          const failedIds = new Set(chunkIds);
          const failed = pendingImportCollectionsRef.current.map((candidate) =>
            failedIds.has(candidate.bookmark_id)
              ? {
                ...candidate,
                status: "failed" as const,
                last_error_kind: syncErrorKind(error),
                retry_count: (candidate.retry_count ?? 0) + 1,
                last_attempt_at: new Date().toISOString(),
                last_error:
                  error instanceof Error ? error.message : String(error),
              }
              : candidate,
          );
          pendingImportCollectionsRef.current = failed;
          setPendingImportCollections(failed);
          recordLog(
            "warn",
            `import collection sync failed (${chunkIds.length} bookmarks): ${String(error)}`,
          );
        }
      }
      // One persist for the whole batch instead of one per item (see above).
      try {
        await repository.setMeta(
          PENDING_IMPORT_COLLECTIONS_KEY,
          JSON.stringify(pendingImportCollectionsRef.current),
        );
      } catch (error) {
        logStorageError("import collection ops", error);
      }
      return mutationsPushed;
    }, [auth.session, hasSyncedOnce]);

  // Durable outbox drive for restoring a Stash JSON backup's AI enrichment
  // snapshot (#671) — same shape as syncPendingImportCollections above, and
  // for the same reason: a bookmark must exist remotely (hasSyncedOnce)
  // before an ai_enrichments row can reference it by bookmark_id. Unlike the
  // collection outbox, there's no remote lookup/create step: restoreAIEnrichment
  // is a single atomic ON-CONFLICT-ignore write, so either outcome (created or
  // "already had one") satisfies this entry's job and it's dropped either way.
  //
  // Batched in chunks of BULK_CREATE_SYNC_CHUNK_SIZE via bulkRestoreAIEnrichment
  // (issue #719 / Sentry STASH-5K) instead of one restoreAIEnrichment HTTP call
  // + one repository.setMeta SQLite write per bookmark — a large backup import
  // (700+ enrichment snapshots) used to trickle in one at a time. Same
  // per-chunk-failure precedent as syncPendingImportCollections's #713 fix:
  // one SQLite persist for the whole drive, not one per item.
  const syncPendingEnrichmentRestores =
    useCallback(async (force = false, session: SupabaseAuthSession | null = auth.session, recoverAuth = false): Promise<boolean> => {
      if (!session || syncPausedRef.current) {
        return false;
      }
      const eligible = pendingEnrichmentRestoresRef.current.filter((item) =>
        hasSyncedOnce(item.bookmark_id) && isFollowupReady(item, Date.now(), legacyFollowupAttemptAt.current, force || (recoverAuth && item.last_error_kind === "auth")),
      );
      if (eligible.length === 0) {
        return false;
      }

      const api = createSyncApi(session);
      let mutationsPushed = false;

      for (
        let i = 0;
        i < eligible.length;
        i += BULK_CREATE_SYNC_CHUNK_SIZE
      ) {
        if (syncPausedRef.current) {
          break;
        }
        const chunk = eligible.slice(i, i + BULK_CREATE_SYNC_CHUNK_SIZE);
        const chunkIds = new Set(chunk.map((item) => item.bookmark_id));
        try {
          const created = await api.bulkRestoreAIEnrichment(
            chunk.map((item) => ({
              bookmark_id: item.bookmark_id,
              summary: item.enrichment.summary,
              topics: item.enrichment.topics,
              suggested_tags: item.enrichment.suggested_tags,
              status: item.enrichment.status,
              model: item.enrichment.model,
              confidence: item.enrichment.confidence,
            })),
          );
          mutationsPushed = true;

          if (created.length > 0) {
            // Newest enrichment for each bookmark wins (mirrors
            // requestAiEnrichment's settle handler) — safe here too since a
            // row only ever appears in the response when this call actually
            // created it (nothing else existed yet).
            const createdByBookmark = new Map(
              created.map((row) => [row.bookmark_id, row] as const),
            );
            setEnrichments((current) => [
              ...created,
              ...current.filter(
                (row) => !createdByBookmark.has(row.bookmark_id),
              ),
            ]);
            try {
              await ensureRepositoryReady();
              await repository.upsertEnrichments(created);
            } catch (error) {
              logStorageError("enrichment restore persist", error);
            }
          }

          // Every item in the chunk is done either way (created, or "already
          // had one" and silently dropped from the response) — same as the
          // single-item path.
          const remaining = pendingEnrichmentRestoresRef.current.filter(
            (candidate) => !chunkIds.has(candidate.bookmark_id),
          );
          pendingEnrichmentRestoresRef.current = remaining;
          setPendingEnrichmentRestores(remaining);
        } catch (error) {
          // Per-chunk failure: mark every item in this chunk failed rather
          // than try to parse partial success out of a thrown bulk insert —
          // matches syncPendingImportCollections's #713 precedent.
          const failed = pendingEnrichmentRestoresRef.current.map(
            (candidate) =>
              chunkIds.has(candidate.bookmark_id)
                ? {
                  ...candidate,
                  status: "failed" as const,
                  last_error_kind: syncErrorKind(error),
                  retry_count: (candidate.retry_count ?? 0) + 1,
                  last_attempt_at: new Date().toISOString(),
                  last_error:
                    error instanceof Error ? error.message : String(error),
                }
                : candidate,
          );
          pendingEnrichmentRestoresRef.current = failed;
          setPendingEnrichmentRestores(failed);
          recordLog(
            "warn",
            `enrichment restore sync failed (${chunk.length} bookmarks): ${String(error)}`,
          );
        }
      }

      // One persist for the whole batch instead of one per item (see above).
      try {
        await ensureRepositoryReady();
        await repository.setMeta(
          PENDING_ENRICHMENT_RESTORE_KEY,
          JSON.stringify(pendingEnrichmentRestoresRef.current),
        );
      } catch (error) {
        logStorageError("enrichment restore ops", error);
      }
      return mutationsPushed;
    }, [auth.session, hasSyncedOnce]);
  return { syncPendingImportCollections, syncPendingEnrichmentRestores };
}
