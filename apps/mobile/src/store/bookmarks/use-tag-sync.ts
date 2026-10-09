import type {
  BulkAttachItem
} from "@/api/bookmarks";
import { mockUserId } from "@/domain/mock-data";
import {
  applyPendingTagOps,
  dequeueTagOp,
  reconcileSyncedAdd,
  type PendingTagOp
} from "@/domain/pending-tags";
import { tagSlug } from "@/domain/tag-input";
import { recordLog } from "@/observability/log-buffer";
import {
  reportSyncQueueHealthEscalation
} from "@/observability/sentry";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { logStorageError, tagRetryReadyAt } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import type { SupabaseAuthSession } from "@/supabase/types";
import { canAutomaticallyRetry } from "@/sync/automatic-retry";
import {
  BULK_CREATE_SYNC_CHUNK_SIZE,
  createSyncApi,
  syncErrorKind
} from "@/sync/sync-bookmarks";
import type { RefObject } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  auth: ReturnType<typeof useSupabaseAuth>;
  syncPausedRef: RefObject<boolean>;
  offlineRef: RefObject<boolean>;
  tagSyncInFlight: RefObject<boolean>;
  tagSyncPending: RefObject<boolean>;
  tagSyncPendingForce: RefObject<boolean>;
  tagSyncPendingRecovery: RefObject<SupabaseAuthSession | null>;
  tagOpsWriteRef: RefObject<Promise<boolean>>;
  tagJournalHealthyRef: RefObject<boolean>;
  tagJournalRetryAtRef: RefObject<number>;
  applyTagOps: (next: PendingTagOp[], options?: { persist?: boolean; }) => Promise<boolean>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  resetEpoch: RefObject<number>;
  authRef: RefObject<ReturnType<typeof useSupabaseAuth>>;
  reconciledCacheUserIdRef: RefObject<string | null>;
  pendingTagHealthReportsRef: RefObject<Map<string, PendingTagOp>>;
  hasSyncedOnce: (bookmarkId: string) => boolean;
  applyTagData: (next: TagData, options?: { persist?: boolean; }) => void;
  tagDataRef: RefObject<TagData>;
  broadcastSyncNudgeRef: RefObject<(() => void) | null>;
  syncInFlight: RefObject<boolean>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
}

export function useTagSync({
  auth,
  syncPausedRef,
  offlineRef,
  tagSyncInFlight,
  tagSyncPending,
  tagSyncPendingForce,
  tagSyncPendingRecovery,
  tagOpsWriteRef,
  tagJournalHealthyRef,
  tagJournalRetryAtRef,
  applyTagOps,
  pendingTagOpsRef,
  resetEpoch,
  authRef,
  reconciledCacheUserIdRef,
  pendingTagHealthReportsRef,
  hasSyncedOnce,
  applyTagData,
  tagDataRef,
  broadcastSyncNudgeRef,
  syncInFlight,
  syncNowRef,
}: Dependencies) {

  // Push queued tag ops to the server when online: ensure tags exist, reconcile
  // the optimistic local tag id to the server one, and drop the op on success.
  // Failures stay queued for the next sync. "add" ops for bookmarks that have
  // already synced are grouped by bookmark and pushed through the batch-attach
  // RPC in chunks of BULK_CREATE_SYNC_CHUNK_SIZE (issue #713) instead of one
  // `addTags` call per (bookmark, tag) pair — a bulk import's ~3 tags per
  // bookmark used to mean 3,000+ sequential round trips for 1,000 bookmarks
  // (Sentry STASH-5F/5G/5D). "remove" ops stay one-per-op, unchanged: imports
  // never enqueue removes, and removes are always low-volume interactive edits.
  const syncTagOps = useCallback(async (force = false, session: SupabaseAuthSession | null = auth.session, recoverAuth = false): Promise<boolean> => {
    if (!session) {
      return false;
    }
    // Tag adds/removes call this directly (not just syncNow's own call site
    // below), so the pause guard has to live here too — otherwise a tag edit
    // made while paused would upload immediately, breaking the "nothing
    // uploads until you turn this off" promise (Sentry STASH-3K review). The
    // op stays queued in pendingTagOpsRef and uploads once unpaused.
    if (syncPausedRef.current || offlineRef.current) {
      return false;
    }
    if (tagSyncInFlight.current) {
      tagSyncPending.current = true;
      tagSyncPendingForce.current ||= force;
      if (recoverAuth) tagSyncPendingRecovery.current = session;
      return false;
    }
    const pendingRecovery = tagSyncPendingRecovery.current;
    tagSyncPendingRecovery.current = null;
    recoverAuth ||= pendingRecovery?.user.id === session.user.id &&
      pendingRecovery.access_token === session.access_token;
    tagSyncInFlight.current = true;
    try {
      await tagOpsWriteRef.current;
      if (!tagJournalHealthyRef.current) {
        if (!force && Date.now() < tagJournalRetryAtRef.current) return false;
        if (!(await applyTagOps(pendingTagOpsRef.current))) return false;
      }
      const userId = session.user.id;
      const epoch = resetEpoch.current;
      const isCurrentUser = () => authRef.current.session?.user.id === userId &&
        reconciledCacheUserIdRef.current === userId && resetEpoch.current === epoch;
      if (!isCurrentUser()) return false;
      const reportPendingHealth = () => {
        if (!isCurrentUser()) return;
        for (const [id, op] of pendingTagHealthReportsRef.current) {
          const current = pendingTagOpsRef.current.find((entry) => entry.id === id);
          if (current?.health_escalated_at === op.health_escalated_at) {
            reportSyncQueueHealthEscalation({
              operation: op.op === "add" ? "assign_tag" : "remove_tag", retryCount: op.retry_count!,
              lastError: op.last_error!, errorKind: op.last_error_kind,
            });
          }
          pendingTagHealthReportsRef.current.delete(id);
        }
      };
      // A repaired journal may contain an escalation whose original write failed.
      reportPendingHealth();
      const ops = pendingTagOpsRef.current.filter((op) => {
        if (op.confirmed) return false;
        return force || (recoverAuth && op.last_error_kind === "auth") || (canAutomaticallyRetry(op.last_error_kind, op.retry_count ?? 0) && Date.now() >= tagRetryReadyAt(op));
      });

      if (ops.length === 0) {
        return false;
      }
      let mutationsPushed = false;
      const api = createSyncApi(session);

      const recordFailure = async (failedOps: PendingTagOp[], error: unknown) => {
        if (!isCurrentUser()) return;
        const failedIds = new Set(failedOps.map((op) => op.id));
        const now = new Date().toISOString();
        const kind = syncErrorKind(error);
        const escalated: PendingTagOp[] = [];
        const next = pendingTagOpsRef.current.map((op) => {
          if (!failedIds.has(op.id)) return op;
          const retryCount = (op.retry_count ?? 0) + 1;
          const threshold = kind === "transient_dns" || kind === "transient_network" ? 6 : 3;
          const failed = {
            ...op, retry_count: retryCount, last_attempt_at: now,
            last_error: String(error), last_error_kind: kind,
            ...(retryCount >= threshold && !op.health_escalated_at ? { health_escalated_at: now } : {}),
          };
          if (!op.health_escalated_at && failed.health_escalated_at) escalated.push(failed);
          return failed;
        });
        for (const op of escalated) pendingTagHealthReportsRef.current.set(op.id, op);
        if (await applyTagOps(next)) reportPendingHealth();
      };

      // The bookmark must exist remotely before its tags can be linked. Group
      // eligible "add" ops by bookmark — enqueueTagOp already guarantees at
      // most one queued op per (bookmark_id, tag slug), so each bookmark's
      // group has no duplicate tag names to worry about.
      const addOpsByBookmark = new Map<string, PendingTagOp[]>();
      for (const op of ops) {
        if (op.op !== "add" || !hasSyncedOnce(op.bookmark_id)) {
          continue;
        }
        const list = addOpsByBookmark.get(op.bookmark_id);
        if (list) {
          list.push(op);
        } else {
          addOpsByBookmark.set(op.bookmark_id, [op]);
        }
      }
      const addBookmarkIds = [...addOpsByBookmark.keys()];

      for (let i = 0; i < addBookmarkIds.length; i += BULK_CREATE_SYNC_CHUNK_SIZE) {
        if (syncPausedRef.current || !isCurrentUser()) {
          break;
        }
        const chunkIds = addBookmarkIds.slice(i, i + BULK_CREATE_SYNC_CHUNK_SIZE);
        const chunkItems: BulkAttachItem[] = chunkIds.map((bookmarkId) => ({
          bookmark_id: bookmarkId,
          tags: addOpsByBookmark.get(bookmarkId)!.map((op) => ({
            name: op.tag_name,
            source: op.source,
          })),
          collection_name: null,
        }));
        try {
          const results = await api.bulkAttachTagsAndCollections(chunkItems);
          if (!isCurrentUser()) return mutationsPushed;
          for (const result of results) {
            const opsForBookmark = addOpsByBookmark.get(result.bookmark_id);
            if (!opsForBookmark) {
              continue;
            }
            for (const serverTag of result.tags) {
              const matchingOp = opsForBookmark.find(
                (op) => tagSlug(op.tag_name) === serverTag.slug,
              );
              if (!matchingOp) {
                continue;
              }
              // persist: false — see the batch persist after this loop. A bulk
              // import's ~300 sequential ops must not each re-serialize and
              // write the whole tag catalog/queue to SQLite (that's what was
              // contending with the main sync queue's own writes).
              applyTagData(
                applyPendingTagOps(
                  reconcileSyncedAdd(tagDataRef.current, matchingOp.tag_name, serverTag),
                  pendingTagOpsRef.current,
                  auth.userId ?? mockUserId,
                ),
                { persist: false },
              );
              applyTagOps(
                dequeueTagOp(
                  pendingTagOpsRef.current,
                  result.bookmark_id,
                  matchingOp.tag_name,
                  matchingOp.id,
                ),
                { persist: false },
              );
              mutationsPushed = true;
            }
          }
        } catch (error) {
          await recordFailure(chunkIds.flatMap((id) => addOpsByBookmark.get(id)!), error);
          // Keep the ops queued; the next sync retries the whole chunk.
          recordLog(
            "warn",
            `tag sync failed (bulk add, ${chunkIds.length} bookmarks): ${String(error)}`,
          );
        }
      }

      for (const op of ops) {
        if (syncPausedRef.current || !isCurrentUser()) {
          break;
        }
        if (op.op !== "remove" || !hasSyncedOnce(op.bookmark_id)) {
          continue;
        }
        try {
          await api.removeTags({
            bookmark_id: op.bookmark_id,
            tags: [op.tag_name],
          });
          if (!isCurrentUser()) return mutationsPushed;
          // Keep an acknowledged removal until a remote snapshot confirms absence.
          applyTagOps(
            pendingTagOpsRef.current.map((current) => current.id === op.id
              ? { ...current, confirmed: true } : current),
            { persist: false },
          );
          mutationsPushed = true;
        } catch (error) {
          await recordFailure([op], error);
          // Keep the op queued; the next sync retries it.
          recordLog(
            "warn",
            `tag sync failed (${op.op} ${op.tag_name}): ${String(error)}`,
          );
        }
      }

      if (mutationsPushed) {
        // One persist for the whole batch instead of one per op (see above).
        try {
          await ensureRepositoryReady();
          await repository.replaceTagData(tagDataRef.current);
          await applyTagOps(pendingTagOpsRef.current);
        } catch (error) {
          logStorageError("tag ops", error);
        }
        broadcastSyncNudgeRef.current?.();
        if (!syncInFlight.current && pendingTagOpsRef.current.some((op) => op.confirmed)) {
          void syncNowRef.current?.().catch(() => { });
        }
      }
      return mutationsPushed;
    } finally {
      tagSyncInFlight.current = false;
      if (tagSyncPending.current) {
        tagSyncPending.current = false;
        const pendingForce = tagSyncPendingForce.current;
        tagSyncPendingForce.current = false;
        void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
      }
    }
  }, [auth.session, applyTagData, applyTagOps, hasSyncedOnce]);
  return { syncTagOps };
}
