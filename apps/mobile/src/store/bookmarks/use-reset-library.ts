import { CACHE_OWNER_KEY } from "@/sync/account-transition";
import {
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  type AiEnrichmentBurstQueue
} from "@/domain/ai-enrichment-burst";
import {
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import {
  type PendingTagOp
} from "@/domain/pending-tags";
import {
  type AiServerQueueSnapshot
} from "@/domain/processing-status";
import type {
  AIEnrichment,
  Bookmark, LocalPendingBookmark
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { EMPTY_TAG_DATA } from '@/store/bookmarks/constants';
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AiRetryState, type ResetLibraryResult } from '@/store/bookmarks/types';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import {
  LAST_PULLED_AT_KEY
} from "@/sync/pull-bookmarks";
import {
  createSyncApi,
  syncErrorKind
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";

interface Dependencies {
  tagSyncInFlight: RefObject<boolean>;
  tagWorkPending: RefObject<number>;
  syncInFlight: RefObject<boolean>;
  syncPausedRef: RefObject<boolean>;
  localCreateFlushesInFlight: RefObject<number>;
  auth: ReturnType<typeof useSupabaseAuth>;
  libraryResetInFlightRef: RefObject<boolean>;
  setIsResettingLibrary: Dispatch<SetStateAction<boolean>>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  resetEpoch: RefObject<number>;
  aiDispatchQueueRef: RefObject<AiEnrichmentBurstQueue>;
  deletedIds: RefObject<Set<string>>;
  idAliases: RefObject<Map<string, string>>;
  aiRetryState: RefObject<Record<string, AiRetryState>>;
  aiServerQueued: RefObject<Set<string>>;
  pendingAiTrigger: RefObject<Set<string>>;
  pendingAiPreviewRefresh: RefObject<Set<string>>;
  aiTriggerAttempted: RefObject<Set<string>>;
  persistAiRetryState: () => Promise<void>;
  persistAiServerQueued: () => Promise<void>;
  persistPendingAiTrigger: () => Promise<void>;
  persistPendingAiPreviewRefresh: () => Promise<void>;
  syncAiRetryIds: () => void;
  syncAiServerQueuedIds: () => void;
  setAiServerQueueSnapshot: Dispatch<SetStateAction<readonly AiServerQueueSnapshot[] | null>>;
  applyUnseenSuggestions: (next: ReadonlySet<string>) => void;
  applyTagOps: (next: PendingTagOp[], options?: { persist?: boolean; }) => Promise<boolean>;
  applyPendingImportCollections: (next: PendingImportCollection[]) => void;
  applyPendingEnrichmentRestores: (next: PendingEnrichmentRestore[]) => void;
  applyTagData: (next: TagData, options?: { persist?: boolean; }) => void;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  setLastPulledAt: Dispatch<SetStateAction<string | null>>;
  syncRunFailureRef: RefObject<{ kind: ReturnType<typeof syncErrorKind>; at: number; attempts: number; userId: string | null; } | null>;
  setSyncRunFailure: Dispatch<SetStateAction<{ kind: ReturnType<typeof syncErrorKind>; at: number; attempts: number; userId: string | null; } | null>>;
  syncPendingRef: RefObject<boolean>;
  syncPendingForceRef: RefObject<boolean>;
  authRecoveryPendingRef: RefObject<boolean>;
}

export function useResetLibrary({
  tagSyncInFlight,
  tagWorkPending,
  syncInFlight,
  syncPausedRef,
  localCreateFlushesInFlight,
  auth,
  libraryResetInFlightRef,
  setIsResettingLibrary,
  bookmarksRef,
  resetEpoch,
  aiDispatchQueueRef,
  deletedIds,
  idAliases,
  aiRetryState,
  aiServerQueued,
  pendingAiTrigger,
  pendingAiPreviewRefresh,
  aiTriggerAttempted,
  persistAiRetryState,
  persistAiServerQueued,
  persistPendingAiTrigger,
  persistPendingAiPreviewRefresh,
  syncAiRetryIds,
  syncAiServerQueuedIds,
  setAiServerQueueSnapshot,
  applyUnseenSuggestions,
  applyTagOps,
  applyPendingImportCollections,
  applyPendingEnrichmentRestores,
  applyTagData,
  setBookmarks,
  setQueue,
  setEnrichments,
  setLastPulledAt,
  syncRunFailureRef,
  setSyncRunFailure,
  syncPendingRef,
  syncPendingForceRef,
  authRecoveryPendingRef,
}: Dependencies) {

  // Destructive library reset (issue #600). Remote first: one server-side RPC
  // wipes every cloud row the user owns set-wise (no per-bookmark delete
  // entries); only once that succeeds is local state cleared — repository,
  // sync queue, tag/collection cache, enrichments, AI bookkeeping, and the
  // pull watermark — so stale queued mutations can never re-upload the
  // just-deleted data. If the local clear fails the cloud is already empty and
  // the RPC is idempotent, so the explicit recovery is to run the reset again.
  const resetLibrary = useCallback(async (): Promise<ResetLibraryResult> => {
    // If sync is paused, syncNow calls made while paused set syncInFlight
    // or syncPendingRef. Bypass syncInFlight so user can reset while paused.
    if (tagSyncInFlight.current || tagWorkPending.current > 0 || (syncInFlight.current && !syncPausedRef.current)) {
      return { ok: false, reason: "busy" };
    }
    // An import's sequential durable-write loop (Sentry: user-reported "reset
    // doesn't clear the queue in one shot") uses this separate counter, not
    // syncInFlight. Without this check, a reset landing mid-import wipes
    // storage via clearAllData() and the import's still-running loop then
    // keeps calling insertBookmark/enqueue for its remaining items — silently
    // repopulating the library right after the "clear".
    if (localCreateFlushesInFlight.current > 0) {
      return { ok: false, reason: "busy" };
    }
    if (!auth.session) {
      return { ok: false, reason: "auth" };
    }
    // Take the sync-in-flight slot so a background sync can't upload or pull
    // mid-wipe; syncNow calls made meanwhile no-op onto syncPendingRef.
    syncInFlight.current = true;
    libraryResetInFlightRef.current = true;
    setIsResettingLibrary(true);
    // Snapshot BEFORE the wipe below clears bookmarksRef — used only for the
    // best-effort Storage cleanup once the remote wipe actually succeeds.
    // Gated on preview_image_url itself, not isBookmarkSyncedOnce/ever_synced
    // — see deleteBookmark's identical comment above.
    const imageIdsToDeleteFromStorage = (bookmarksRef.current ?? [])
      .filter((bookmark) => bookmark.content_type === "image" && bookmark.preview_image_url)
      .map((bookmark) => bookmark.id);
    try {
      try {
        // Refresh a token that expired while the app stayed open, mirroring
        // syncNow — otherwise the RPC would 401 against a stale bearer.
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
        await createSyncApi(session).resetLibrary();
        // Best-effort: the RPC wipes the bookmarks table (and everything
        // that cascades from it), but bookmark-images objects live in
        // Storage, outside that table's FK graph, so nothing cleans them up
        // on its own. Fire-and-forget — never blocks or fails the reset
        // itself; a failure here just leaves orphaned objects, same
        // trade-off as deleteBookmark/emptyTrash's identical cleanup.
        if (imageIdsToDeleteFromStorage.length > 0) {
          createSyncApi(session)
            .deleteImages(imageIdsToDeleteFromStorage)
            .catch((error) =>
              logStorageError("library reset image objects", error),
            );
        }
      } catch (error) {
        recordLog(
          "warn",
          `library reset: remote wipe failed: ${String(error)}`,
        );
        return {
          ok: false,
          reason: "remote",
          message: error instanceof Error ? error.message : undefined,
        };
      }
      recordLog(
        "warn",
        "library reset: remote wipe succeeded; clearing local state",
      );
      // Quiesce the AI enrichment pipeline BEFORE clearing storage: drop every
      // queued (not-yet-dispatched) auto-enrichment so the drain interval can't
      // fire requests for just-deleted bookmarks, and bump the epoch so any
      // request already in flight discards its settle paths instead of writing
      // an enrichment row / arming retry bookkeeping into the cleared state.
      resetEpoch.current += 1;
      aiDispatchQueueRef.current = EMPTY_AI_ENRICHMENT_BURST_QUEUE;
      try {
        await ensureRepositoryReady();
        await repository.clearAllData();
        // Reset the pull watermark so the next sync does a clean full pull of
        // the now-empty account instead of trusting a stale window.
        await repository.setMeta(CACHE_OWNER_KEY, "");
        await repository.setMeta(LAST_PULLED_AT_KEY, "");
      } catch (error) {
        logStorageError("library reset local clear", error);
        return { ok: false, reason: "local" };
      }
      // In-memory mirrors last, after the durable writes, so a kill in between
      // re-reads the already-cleared repository on the next launch. The apply*
      // helpers also persist their (now empty) meta blobs.
      deletedIds.current.clear();
      idAliases.current.clear();
      aiRetryState.current = {};
      aiServerQueued.current.clear();
      pendingAiTrigger.current.clear();
      pendingAiPreviewRefresh.current.clear();
      aiTriggerAttempted.current.clear();
      void persistAiRetryState();
      void persistAiServerQueued();
      void persistPendingAiTrigger();
      void persistPendingAiPreviewRefresh();
      syncAiRetryIds();
      syncAiServerQueuedIds();
      // The remote wipe above cascades pending_ai_enrichment rows away with
      // their bookmarks, so the account's true server-side backlog is known
      // to be 0 now — set it directly rather than nulling it out to "not yet
      // fetched" (resetLibrary doesn't change auth.userId, so the
      // account-switch effect that would otherwise re-fetch it never fires).
      setAiServerQueueSnapshot([]);
      applyUnseenSuggestions(new Set());
      applyTagOps([]);
      applyPendingImportCollections([]);
      applyPendingEnrichmentRestores([]);
      applyTagData(EMPTY_TAG_DATA);
      setBookmarks([]);
      setQueue([]);
      setEnrichments([]);
      setLastPulledAt(null);
      syncRunFailureRef.current = null;
      setSyncRunFailure(null);
      syncPendingRef.current = false;
      syncPendingForceRef.current = false;
      authRecoveryPendingRef.current = false;
      return { ok: true };
    } finally {
      syncInFlight.current = false;
      libraryResetInFlightRef.current = false;
      setIsResettingLibrary(false);
    }
  }, [
    auth,
    applyPendingImportCollections,
    applyPendingEnrichmentRestores,
    applyTagData,
    applyTagOps,
    applyUnseenSuggestions,
    persistAiRetryState,
    persistAiServerQueued,
    persistPendingAiTrigger,
    persistPendingAiPreviewRefresh,
    syncAiRetryIds,
    syncAiServerQueuedIds,
  ]);
  return { resetLibrary };
}
