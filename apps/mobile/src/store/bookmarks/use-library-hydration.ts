import {
  AI_SUGGESTIONS_MODE_PREF_KEY,
  parseAiSuggestionsMode,
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import { mockUserId } from "@/domain/mock-data";
import { isYoutubeAvailabilityCandidate } from "@/domain/page-metadata";
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  parsePendingEnrichmentRestores,
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  parsePendingImportCollections,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import {
  applyPendingTagOps,
  type PendingTagOp
} from "@/domain/pending-tags";
import { parseStringSetMap } from "@/domain/string-set-map";
import { sanitizeTagData } from "@/domain/tag-data";
import type {
  AIEnrichment,
  Bookmark, LocalPendingBookmark,
  SyncChangeSource
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import { repairStalledCollectionRlsEntries } from "@/sync/account-transition";
import { armHydrationWatchdog } from "@/observability/hydration-watchdog";
import { repository } from "@/storage/repository";
import type {
  TagData
} from "@/storage/types";
import { AI_RETRY_STATE_KEY, AI_SERVER_QUEUED_KEY, DISMISSED_FOLDERS_KEY, PENDING_AI_PREVIEW_REFRESH_KEY, PENDING_AI_TRIGGER_KEY, PENDING_TAG_OPS_KEY, REVIEWED_SUGGESTIONS_KEY, REVIEWED_SUMMARIES_KEY, SYNC_PAUSED_KEY, UNSEEN_SUGGESTIONS_KEY } from '@/store/bookmarks/constants';
import { logStorageError, mergeById, parseAiRetryState, parseIdSet, parseTagOps } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AiRetryState } from '@/store/bookmarks/types';
import {
  LAST_PULLED_AT_KEY
} from "@/sync/pull-bookmarks";
import {
  reconcileOrphanedQueueEntries
} from "@/sync/sync-bookmarks";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useEffect
} from "react";

interface Dependencies {
  aiSuggestionsModeRef: RefObject<AiSuggestionsMode>;
  setAiSuggestionsModeState: Dispatch<SetStateAction<AiSuggestionsMode>>;
  syncPausedRef: RefObject<boolean>;
  setSyncPausedState: Dispatch<SetStateAction<boolean>>;
  pendingAiTrigger: RefObject<Set<string>>;
  pendingAiPreviewRefresh: RefObject<Set<string>>;
  aiRetryState: RefObject<Record<string, AiRetryState>>;
  setAiRetryIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  aiServerQueued: RefObject<Set<string>>;
  setAiServerQueuedIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  unseenSuggestionIdsRef: RefObject<ReadonlySet<string>>;
  setUnseenSuggestionIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => void;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  setPendingTagOps: Dispatch<SetStateAction<PendingTagOp[]>>;
  pendingImportCollectionsRef: RefObject<PendingImportCollection[]>;
  setPendingImportCollections: Dispatch<SetStateAction<PendingImportCollection[]>>;
  pendingEnrichmentRestoresRef: RefObject<PendingEnrichmentRestore[]>;
  setPendingEnrichmentRestores: Dispatch<SetStateAction<PendingEnrichmentRestore[]>>;
  tagDataRef: RefObject<TagData>;
  setTagData: Dispatch<SetStateAction<TagData>>;
  setLastPulledAt: Dispatch<SetStateAction<string | null>>;
  setLoadError: Dispatch<SetStateAction<boolean>>;
}

export function useLibraryHydration({
  aiSuggestionsModeRef,
  setAiSuggestionsModeState,
  syncPausedRef,
  setSyncPausedState,
  pendingAiTrigger,
  pendingAiPreviewRefresh,
  aiRetryState,
  setAiRetryIds,
  aiServerQueued,
  setAiServerQueuedIds,
  unseenSuggestionIdsRef,
  setUnseenSuggestionIds,
  enqueueMutation,
  setBookmarks,
  setQueue,
  setEnrichments,
  pendingTagOpsRef,
  setPendingTagOps,
  pendingImportCollectionsRef,
  setPendingImportCollections,
  pendingEnrichmentRestoresRef,
  setPendingEnrichmentRestores,
  tagDataRef,
  setTagData,
  setLastPulledAt,
  setLoadError,
}: Dependencies) {

  useEffect(() => {
    let cancelled = false;
    // Observe (never abort) the cold-start load: if it wedges — the Android
    // background-handle SQLite stall, or any await that never resolves — the
    // Inbox stays stuck on its loading state with no crash and no event
    // (Sentry STASH-F). The watchdog makes that stall self-report; `phase`
    // gives the report a coarse, non-identifying hint of how far we got.
    let phase = "opening";
    const disarmWatchdog = armHydrationWatchdog({ describe: () => phase });
    (async () => {
      // Opening SQLite can fail transiently right after a warm relaunch (the
      // native handle is briefly invalid). Retry a few times before falling
      // back to read-only sample data, so a momentary hiccup doesn't strand the
      // user on the storage-error banner.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          phase = `attempt ${attempt}: opening`;
          await ensureRepositoryReady();
          phase = `attempt ${attempt}: reading`;
          const readAllMeta = async (): Promise<Record<string, string | null>> => {
            if (typeof repository.getAllMeta === "function") {
              return repository.getAllMeta();
            }
            const [
              storedPulledAt,
              storedTagOpsRaw,
              storedImportCollectionsRaw,
              storedEnrichmentRestoresRaw,
              storedAiTriggerRaw,
              storedAiPreviewRefreshRaw,
              storedAiRetryRaw,
              storedAiServerQueuedRaw,
              storedReviewedRaw,
              storedUnseenRaw,
              storedDismissedFoldersRaw,
              storedReviewedSummariesRaw,
              storedAiSuggestionsModeRaw,
              storedSyncPausedRaw,
            ] = await Promise.all([
              repository.getMeta(LAST_PULLED_AT_KEY),
              repository.getMeta(PENDING_TAG_OPS_KEY),
              repository.getMeta(PENDING_IMPORT_COLLECTIONS_KEY),
              repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY),
              repository.getMeta(PENDING_AI_TRIGGER_KEY),
              repository.getMeta(PENDING_AI_PREVIEW_REFRESH_KEY),
              repository.getMeta(AI_RETRY_STATE_KEY),
              repository.getMeta(AI_SERVER_QUEUED_KEY),
              repository.getMeta(REVIEWED_SUGGESTIONS_KEY),
              repository.getMeta(UNSEEN_SUGGESTIONS_KEY),
              repository.getMeta(DISMISSED_FOLDERS_KEY),
              repository.getMeta(REVIEWED_SUMMARIES_KEY),
              repository.getMeta(AI_SUGGESTIONS_MODE_PREF_KEY),
              repository.getMeta(SYNC_PAUSED_KEY),
            ]);
            return {
              [LAST_PULLED_AT_KEY]: storedPulledAt,
              [PENDING_TAG_OPS_KEY]: storedTagOpsRaw,
              [PENDING_IMPORT_COLLECTIONS_KEY]: storedImportCollectionsRaw,
              [PENDING_ENRICHMENT_RESTORE_KEY]: storedEnrichmentRestoresRaw,
              [PENDING_AI_TRIGGER_KEY]: storedAiTriggerRaw,
              [PENDING_AI_PREVIEW_REFRESH_KEY]: storedAiPreviewRefreshRaw,
              [AI_RETRY_STATE_KEY]: storedAiRetryRaw,
              [AI_SERVER_QUEUED_KEY]: storedAiServerQueuedRaw,
              [REVIEWED_SUGGESTIONS_KEY]: storedReviewedRaw,
              [UNSEEN_SUGGESTIONS_KEY]: storedUnseenRaw,
              [DISMISSED_FOLDERS_KEY]: storedDismissedFoldersRaw,
              [REVIEWED_SUMMARIES_KEY]: storedReviewedSummariesRaw,
              [AI_SUGGESTIONS_MODE_PREF_KEY]: storedAiSuggestionsModeRaw,
              [SYNC_PAUSED_KEY]: storedSyncPausedRaw,
            };
          };

          const [
            storedBookmarks,
            storedQueue,
            storedEnrichments,
            storedTagData,
            metaMap,
          ] = await Promise.all([
            repository.listBookmarks(),
            repository.listQueue(),
            repository.listEnrichments(),
            repository.listTagData(),
            readAllMeta(),
          ]);

          const storedPulledAt = metaMap[LAST_PULLED_AT_KEY] ?? null;
          const storedTagOpsRaw = metaMap[PENDING_TAG_OPS_KEY] ?? null;
          const storedImportCollectionsRaw = metaMap[PENDING_IMPORT_COLLECTIONS_KEY] ?? null;
          const storedEnrichmentRestoresRaw = metaMap[PENDING_ENRICHMENT_RESTORE_KEY] ?? null;
          const storedAiTriggerRaw = metaMap[PENDING_AI_TRIGGER_KEY] ?? null;
          const storedAiPreviewRefreshRaw = metaMap[PENDING_AI_PREVIEW_REFRESH_KEY] ?? null;
          const storedAiRetryRaw = metaMap[AI_RETRY_STATE_KEY] ?? null;
          const storedAiServerQueuedRaw = metaMap[AI_SERVER_QUEUED_KEY] ?? null;
          const storedReviewedRaw = metaMap[REVIEWED_SUGGESTIONS_KEY] ?? null;
          const storedUnseenRaw = metaMap[UNSEEN_SUGGESTIONS_KEY] ?? null;
          const storedDismissedFoldersRaw = metaMap[DISMISSED_FOLDERS_KEY] ?? null;
          const storedReviewedSummariesRaw = metaMap[REVIEWED_SUMMARIES_KEY] ?? null;
          const storedAiSuggestionsModeRaw = metaMap[AI_SUGGESTIONS_MODE_PREF_KEY] ?? null;
          const storedSyncPausedRaw = metaMap[SYNC_PAUSED_KEY] ?? null;
          if (!cancelled) {
            // Re-hydrate the AI-suggestions mode so the auto-trigger gate and
            // auto_accept behavior are correct from the very first render, not
            // just after the user revisits Settings.
            const storedAiSuggestionsMode = parseAiSuggestionsMode(
              storedAiSuggestionsModeRaw,
            );
            aiSuggestionsModeRef.current = storedAiSuggestionsMode;
            setAiSuggestionsModeState(storedAiSuggestionsMode);
            // Re-hydrate the sync-paused pref so a review left mid-way (app
            // closed before turning it back off) doesn't silently resume
            // uploading on the next launch.
            const storedSyncPaused = storedSyncPausedRaw === "true";
            syncPausedRef.current = storedSyncPaused;
            setSyncPausedState(storedSyncPaused);
            // Re-hydrate deferred AI triggers so a bookmark whose create synced
            // before the app was killed still gets auto suggestions once its
            // metadata enrichment settles (the effect below picks it up).
            for (const id of parseIdSet(storedAiTriggerRaw)) {
              pendingAiTrigger.current.add(id);
            }
            pendingAiPreviewRefresh.current = parseIdSet(
              storedAiPreviewRefreshRaw,
            );
            // Re-hydrate the AI-suggestion retry bookkeeping so a backoff that
            // elapsed while the app was closed can fire right away (the
            // cold-launch retry check below reads this ref).
            aiRetryState.current = parseAiRetryState(storedAiRetryRaw);
            setAiRetryIds(new Set(Object.keys(aiRetryState.current)));
            // Re-hydrate the confirmed-server-queued set so a bookmark queued
            // before the app was killed still shows the calm "queued" note
            // instead of reverting to looking never-asked.
            aiServerQueued.current = parseIdSet(storedAiServerQueuedRaw);
            setAiServerQueuedIds(new Set(aiServerQueued.current));
            // Re-hydrate the "unseen AI suggestions" set so a suggestion that
            // landed in a session the user never returned to still drives the
            // Inbox banner on this launch.
            const storedUnseen = parseIdSet(storedUnseenRaw);
            unseenSuggestionIdsRef.current = storedUnseen;
            setUnseenSuggestionIds(storedUnseen);

            // One-time migration: migrate legacy local-only metadata to bookmark fields
            const legacyReviewedTags = parseStringSetMap(storedReviewedRaw);
            const legacyDismissedFolders = parseStringSetMap(
              storedDismissedFoldersRaw,
            );
            const legacyReviewedSummaries = parseStringSetMap(
              storedReviewedSummariesRaw,
            );

            let migratedBookmarks = storedBookmarks;

            if (
              Object.keys(legacyReviewedTags).length > 0 ||
              Object.keys(legacyDismissedFolders).length > 0 ||
              Object.keys(legacyReviewedSummaries).length > 0
            ) {
              migratedBookmarks = storedBookmarks.map((bookmark) => {
                const tags = legacyReviewedTags[bookmark.id] ?? [];
                const folders = legacyDismissedFolders[bookmark.id] ?? [];
                const summaries = legacyReviewedSummaries[bookmark.id] ?? [];

                if (
                  tags.length > 0 ||
                  folders.length > 0 ||
                  summaries.length > 0
                ) {
                  const updated: Bookmark = {
                    ...bookmark,
                    dismissed_suggested_tags: [
                      ...new Set([
                        ...(bookmark.dismissed_suggested_tags ?? []),
                        ...tags,
                      ]),
                    ],
                    dismissed_suggested_folders: [
                      ...new Set([
                        ...(bookmark.dismissed_suggested_folders ?? []),
                        ...folders,
                      ]),
                    ],
                    reviewed_summary_tokens: [
                      ...new Set([
                        ...(bookmark.reviewed_summary_tokens ?? []),
                        ...summaries,
                      ]),
                    ],
                    // Queue for sync to remote DB
                    sync_status: "pending",
                    ever_synced: true,
                    updated_at: new Date().toISOString(),
                  };
                  ensureRepositoryReady()
                    .then(() => repository.updateBookmark(updated))
                    .catch((error) =>
                      logStorageError(
                        "migrate legacy suggestion metadata",
                        error,
                      ),
                    );
                  enqueueMutation(updated.id, "update", "suggestion_review", ["dismissed_suggested_tags", "dismissed_suggested_folders", "reviewed_summary_tokens"]);
                  return updated;
                }
                return bookmark;
              });

              // Clear legacy meta values
              ensureRepositoryReady()
                .then(async () => {
                  await repository.setMeta(REVIEWED_SUGGESTIONS_KEY, "{}");
                  await repository.setMeta(DISMISSED_FOLDERS_KEY, "{}");
                  await repository.setMeta(REVIEWED_SUMMARIES_KEY, "{}");
                })
                .catch((e) =>
                  logStorageError("clear legacy suggestion keys", e),
                );
            }
            // STASH-71: Clean up any erroneously set video_unavailable flags on
            // non-candidate bookmarks (such as YouTube playlists or non-YouTube URLs)
            // stored from earlier releases. Collect cleaned row ids and persist them
            // sequentially to prevent single-connection SQLite actor queue buildup.
            // Re-read each row immediately before updating to avoid clobbering fresher
            // metadata/sync mutations applied concurrently during startup.
            const cleanedIds: string[] = [];
            const sanitizedBookmarks = migratedBookmarks.map((bookmark) => {
              if (
                bookmark.video_unavailable &&
                !isYoutubeAvailabilityCandidate(bookmark.url ?? "")
              ) {
                const cleaned: Bookmark = { ...bookmark, video_unavailable: false };
                cleanedIds.push(bookmark.id);
                return cleaned;
              }
              return bookmark;
            });

            if (cleanedIds.length > 0) {
              ensureRepositoryReady()
                .then(async () => {
                  for (const id of cleanedIds) {
                    const fresh = await repository.getBookmark(id);
                    if (fresh && fresh.video_unavailable) {
                      await repository.updateBookmark({
                        ...fresh,
                        video_unavailable: false,
                      });
                    }
                  }
                })
                .catch((e) =>
                  logStorageError("clear invalid video_unavailable on load", e),
                );
            }

            // STASH-7M: Self-heal queue entries and bookmarks stalled on PostgreSQL
            // RLS errors (HTTP 403 / permission) due to unowned collection IDs from
            // an account transition.
            let initialBookmarks = sanitizedBookmarks;
            let initialQueue = storedQueue;
            const { repairedEntries, repairedBookmarks } = repairStalledCollectionRlsEntries(
              initialBookmarks,
              initialQueue,
            );
            if (repairedEntries.length > 0 || repairedBookmarks.length > 0) {
              const repairedEntryMap = new Map(repairedEntries.map((e) => [e.local_id, e]));
              const repairedBookmarkMap = new Map(repairedBookmarks.map((b) => [b.id, b]));
              initialQueue = initialQueue.map((e) => repairedEntryMap.get(e.local_id) ?? e);
              initialBookmarks = initialBookmarks.map((b) => repairedBookmarkMap.get(b.id) ?? b);
              recordLog('warn', `sync: self-healed ${repairedEntries.length} stalled collection RLS queue entries`);
              (async () => {
                for (const b of repairedBookmarks) {
                  await repository.updateBookmark(b);
                }
                for (const e of repairedEntries) {
                  await repository.updateQueueEntry(e);
                }
              })().catch((error) => logStorageError("stalled collection RLS repair", error));
            }

            // Merge instead of replace: saves made while loading must survive.
            setBookmarks((current) =>
              current === null
                ? initialBookmarks
                : mergeById(
                    current,
                    initialBookmarks,
                    (bookmark) => bookmark.id,
                  ),
            );
            setQueue((current) =>
              mergeById(current, initialQueue, (entry) => entry.local_id),
            );
            // Self-heal stranded bookmarks: a non-synced row whose queue entry
            // never persisted (storage hiccup, or the app killed between the two
            // writes) has nothing to drive its sync and would show "sync
            // pending" forever. Re-enqueue an upload so the background loop
            // finishes it. Idempotent on the server, so it's safe to repeat.
            const orphanEntries = reconcileOrphanedQueueEntries(
              initialBookmarks,
              initialQueue,
            );
            if (orphanEntries.length > 0) {
              const orphanIds = new Set(
                orphanEntries.map((entry) => entry.local_id),
              );
              setQueue((current) => [
                ...current.filter((entry) => !orphanIds.has(entry.local_id)),
                ...orphanEntries,
              ]);
              // Sequential on purpose (Sentry STASH-3B precedent, applied here
              // after STASH-3N): a large backlog of orphaned entries uploaded
              // via Promise.all meant dozens of simultaneous native SQLite
              // calls stacking up on the single serialized connection —
              // "sqlite tail wait" depth reaching 40 with multi-second stalls
              // on every launch, on a device whose backlog never fully drains
              // within one session.
              (async () => {
                for (const entry of orphanEntries) {
                  await repository.enqueue(entry);
                }
              })().catch((error) =>
                logStorageError("orphan re-enqueue", error),
              );
            }
            setEnrichments(storedEnrichments);
            // One-time cleanup: purge blank-named tags/collections (and orphaned
            // links) a prior version may have stored, so they stop showing as
            // empty Browse chips. Persist the cleaned set back when it changed.
            const { tagData: cleanTagData, changed } =
              sanitizeTagData(storedTagData);
            if (changed) {
              void repository
                .replaceTagData(cleanTagData)
                .catch((error) => logStorageError("blank-tag cleanup", error));
            }
            // Layer not-yet-synced local tag ops on top of the cached snapshot.
            const storedBookmarkIds = new Set(
              storedBookmarks.map((bookmark) => bookmark.id),
            );
            const parsedStoredOps = parseTagOps(storedTagOpsRaw);
            const storedOps = parsedStoredOps.filter((op) =>
              storedBookmarkIds.has(op.bookmark_id),
            );
            if (storedOps.length !== parsedStoredOps.length) {
              void repository
                .setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(storedOps))
                .catch((error) => logStorageError("orphan tag ops", error));
            }
            pendingTagOpsRef.current = storedOps;
            setPendingTagOps(storedOps);
            const parsedImportCollections = parsePendingImportCollections(
              storedImportCollectionsRaw,
            );
            const storedImportCollections = parsedImportCollections.filter(
              (item) => storedBookmarkIds.has(item.bookmark_id),
            );
            if (
              storedImportCollections.length !== parsedImportCollections.length
            ) {
              void repository
                .setMeta(
                  PENDING_IMPORT_COLLECTIONS_KEY,
                  JSON.stringify(storedImportCollections),
                )
                .catch((error) =>
                  logStorageError("orphan import collection ops", error),
                );
            }
            pendingImportCollectionsRef.current = storedImportCollections;
            setPendingImportCollections(storedImportCollections);
            const parsedEnrichmentRestores = parsePendingEnrichmentRestores(
              storedEnrichmentRestoresRaw,
            );
            const storedEnrichmentRestores = parsedEnrichmentRestores.filter(
              (item) => storedBookmarkIds.has(item.bookmark_id),
            );
            if (
              storedEnrichmentRestores.length !==
              parsedEnrichmentRestores.length
            ) {
              void repository
                .setMeta(
                  PENDING_ENRICHMENT_RESTORE_KEY,
                  JSON.stringify(storedEnrichmentRestores),
                )
                .catch((error) =>
                  logStorageError("orphan enrichment restore ops", error),
                );
            }
            pendingEnrichmentRestoresRef.current = storedEnrichmentRestores;
            setPendingEnrichmentRestores(storedEnrichmentRestores);
            tagDataRef.current = applyPendingTagOps(
              cleanTagData,
              storedOps,
              mockUserId,
            );
            setTagData(tagDataRef.current);
            setLastPulledAt(storedPulledAt);
            setLoadError(false);
          }
          return;
        } catch (error) {
          if (cancelled) {
            return;
          }
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
            continue;
          }
          logStorageError("startup load", error);
          setLoadError(true);
          // Don't conjure sample bookmarks on a load failure — surface the empty
          // (errored) state instead of fake content the user never saved.
          setBookmarks((current) => current ?? []);
        }
      }
    })().finally(() => {
      // Disarm once the load settles by any path — success, terminal fallback,
      // or an unexpected throw. Idempotent with the unmount cleanup below.
      disarmWatchdog();
    });
    return () => {
      cancelled = true;
      disarmWatchdog();
    };
  }, []);
}
