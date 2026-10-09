import type {
  EnrichmentMetadataHint
} from "@/api/bookmarks";
import {
  AI_ENRICHMENT_BURST_TOAST_MIN
} from "@/domain/ai-enrichment-burst";
import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import {
  MAX_UPLOAD_IMAGE_BYTES,
  canonicalizeImageMimeType,
  isCloudUploadImageMime,
  mimeTypeForImageUri
} from "@/domain/image-share";
import { type LibrarySyncFlow } from "@/domain/library-sync-status";
import { mockUserId } from "@/domain/mock-data";
import {
  applyPendingTagOps,
  retireConfirmedTagRemovals,
  type PendingTagOp
} from "@/domain/pending-tags";
import { sameRecordSnapshot } from "@/domain/record-snapshot";
import type {
  AIEnrichment,
  Bookmark, LocalPendingBookmark, SyncChangeSource
} from "@/domain/types";
import { recordLog } from "@/observability/log-buffer";
import {
  reportQueueReconcileMismatch,
  reportSyncQueueHealthEscalation,
} from "@/observability/sentry";
import {
  recordSlowSegment
} from "@/observability/slow-segment-log";
import {
  localFileSizeBytes,
  uploadImageFile
} from "@/storage/image-store";
import { repository } from "@/storage/repository";
import type {
  CreateSyncCompletion,
  IdentityRekeyState,
  TagData,
} from "@/storage/types";
import { PENDING_AI_TRIGGER_KEY } from '@/store/bookmarks/constants';
import { captureSyncRecovery, logStorageError, makeBookmarkId, mergeById, retryStorageWrite } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AiRetryState } from '@/store/bookmarks/types';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { createSupabaseClient } from "@/supabase/client";
import { trackSyncStatus } from "@/supabase/sync-status-tracker";
import type { SupabaseAuthSession } from "@/supabase/types";
import {
  applyAccountTransition,
  readCacheOwner,
} from "@/sync/account-transition";
import { canAutomaticallyRetry, isPullReady } from "@/sync/automatic-retry";
import {
  PullPausedError,
  pullRemoteChanges
} from "@/sync/pull-bookmarks";
import {
  recordBulkChunkStarted,
  recordCreateCompleted,
  recordReconcileNeeded,
} from "@/sync/reconcile-diagnostics";
import {
  BULK_CREATE_SYNC_CHUNK_SIZE,
  IMAGE_TOO_LARGE_ERROR_TEXT,
  IMAGE_UNSUPPORTED_FORMAT_ERROR_TEXT,
  applySyncQueueHealthEscalation,
  createNeedsReconcileUpdate,
  createSyncApi,
  didSyncQueueHealthEscalate,
  findStaleQueueEntries,
  hasBulkCreateResultKey,
  isRowSpecificPermanentSyncErrorText,
  isSyncable,
  mergeSyncedBookmarkFields,
  planDeletedMidFlightCleanup,
  removeQueueEntryIfNotSuperseded,
  syncCreateQueueEntryBatch,
  syncErrorKind,
  syncQueueEntry
} from "@/sync/sync-bookmarks";
import {
  noteSyncEntryStatus
} from "@/sync/sync-status-diagnostics";
import Constants from "expo-constants";
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback
} from "react";
import { Platform } from "react-native";

interface Dependencies {
  libraryResetInFlightRef: RefObject<boolean>;
  syncInFlight: RefObject<boolean>;
  syncPendingRef: RefObject<boolean>;
  syncPendingForceRef: RefObject<boolean>;
  localCreateFlushesInFlight: RefObject<number>;
  auth: ReturnType<typeof useSupabaseAuth>;
  syncPausedRef: RefObject<boolean>;
  offlineRef: RefObject<boolean>;
  reconcileAccountTransition: (currentUser: { id: string; isAnonymous: boolean; }) => Promise<boolean>;
  authRef: RefObject<ReturnType<typeof useSupabaseAuth>>;
  setReconciledCacheUserId: (userId: string | null) => void;
  setIsSyncing: Dispatch<SetStateAction<boolean>>;
  authRecoveryPendingRef: RefObject<boolean>;
  librarySyncFlowRef: RefObject<LibrarySyncFlow>;
  syncCredentialsRef: RefObject<{ userId: string; accessToken: string; } | null>;
  credentialsWereUsedRef: RefObject<boolean>;
  bookmarksRef: RefObject<Bookmark[] | null>;
  queueRef: RefObject<LocalPendingBookmark[]>;
  setBookmarks: Dispatch<SetStateAction<Bookmark[] | null>>;
  setQueue: Dispatch<SetStateAction<LocalPendingBookmark[]>>;
  deletedIds: RefObject<Set<string>>;
  enqueueMutation: (bookmarkId: string, operation: "update" | "delete", source?: SyncChangeSource, fields?: string[]) => void;
  serializeTagWork: <T>(work: () => Promise<T>) => Promise<T>;
  rekeyBookmarkIdentity: (idMap: Map<string, string>, options?: { persist?: boolean; carryTags?: boolean; serialized?: boolean; }) => Promise<IdentityRekeyState>;
  pendingUserTitleEdits: RefObject<Set<string>>;
  pendingGeneratedTitleUpdates: RefObject<Set<string>>;
  markPendingAiTrigger: (id: string) => void;
  bulkReconcileInFlight: RefObject<number>;
  pendingAiTrigger: RefObject<Set<string>>;
  syncPendingImportCollections: (force?: boolean, session?: SupabaseAuthSession | null, recoverAuth?: boolean) => Promise<boolean>;
  syncPendingEnrichmentRestores: (force?: boolean, session?: SupabaseAuthSession | null, recoverAuth?: boolean) => Promise<boolean>;
  syncTagOps: (force?: boolean, session?: SupabaseAuthSession | null, recoverAuth?: boolean) => Promise<boolean>;
  pendingTagOpsRef: RefObject<PendingTagOp[]>;
  syncRunFailureRef: RefObject<{ kind: ReturnType<typeof syncErrorKind>; at: number; attempts: number; userId: string | null; } | null>;
  enrichmentsRef: RefObject<AIEnrichment[]>;
  unseenSuggestionIdsRef: RefObject<ReadonlySet<string>>;
  addUnseenSuggestion: (enrichment: AIEnrichment, next: Set<string>) => boolean;
  aiEnriching: RefObject<Set<string>>;
  aiSuggestionsModeRef: RefObject<AiSuggestionsMode>;
  aiRetryState: RefObject<Record<string, AiRetryState>>;
  clearAiRetry: (bookmarkId: string) => void;
  aiServerQueued: RefObject<Set<string>>;
  clearAiServerQueued: (bookmarkId: string) => void;
  applyUnseenSuggestions: (next: ReadonlySet<string>) => void;
  syncAiRetryIds: () => void;
  aiBurstTokenSeq: RefObject<number>;
  setAiEnrichmentBurstToast: Dispatch<SetStateAction<{ count: number; token: number; } | null>>;
  setEnrichments: Dispatch<SetStateAction<AIEnrichment[]>>;
  applyTagOps: (next: PendingTagOp[], options?: { persist?: boolean; }) => Promise<boolean>;
  tagDataRef: RefObject<TagData>;
  setTagData: Dispatch<SetStateAction<TagData>>;
  setLastPulledAt: Dispatch<SetStateAction<string | null>>;
  setSyncRunFailure: Dispatch<SetStateAction<{ kind: ReturnType<typeof syncErrorKind>; at: number; attempts: number; userId: string | null; } | null>>;
  autoAcceptEnrichmentRef: RefObject<((bookmarkId: string, enrichment: AIEnrichment) => Promise<void>) | null>;
  syncNowRef: RefObject<((options?: { force?: boolean; }) => Promise<boolean>) | null>;
  broadcastSyncNudgeRef: RefObject<(() => void) | null>;
  checkAiRetriesRef: RefObject<(() => void) | null>;
  requestAiEnrichment: (bookmarkId: string, source?: "auto" | "manual" | "preview", overrideMetadata?: EnrichmentMetadataHint) => Promise<string | null>;
  setLoadedAccountUserId?: (userId: string | null) => void;
  setAccountLibraryFailureUserId?: (userId: string | null) => void;
}

export function useSyncCoordinator({
  libraryResetInFlightRef,
  syncInFlight,
  syncPendingRef,
  syncPendingForceRef,
  localCreateFlushesInFlight,
  auth,
  syncPausedRef,
  offlineRef,
  reconcileAccountTransition,
  authRef,
  setReconciledCacheUserId,
  setIsSyncing,
  authRecoveryPendingRef,
  librarySyncFlowRef,
  syncCredentialsRef,
  credentialsWereUsedRef,
  bookmarksRef,
  queueRef,
  setBookmarks,
  setQueue,
  deletedIds,
  enqueueMutation,
  serializeTagWork,
  rekeyBookmarkIdentity,
  pendingUserTitleEdits,
  pendingGeneratedTitleUpdates,
  markPendingAiTrigger,
  bulkReconcileInFlight,
  pendingAiTrigger,
  syncPendingImportCollections,
  syncPendingEnrichmentRestores,
  syncTagOps,
  pendingTagOpsRef,
  syncRunFailureRef,
  enrichmentsRef,
  unseenSuggestionIdsRef,
  addUnseenSuggestion,
  aiEnriching,
  aiSuggestionsModeRef,
  aiRetryState,
  clearAiRetry,
  aiServerQueued,
  clearAiServerQueued,
  applyUnseenSuggestions,
  syncAiRetryIds,
  aiBurstTokenSeq,
  setAiEnrichmentBurstToast,
  setEnrichments,
  applyTagOps,
  tagDataRef,
  setTagData,
  setLastPulledAt,
  setSyncRunFailure,
  autoAcceptEnrichmentRef,
  syncNowRef,
  broadcastSyncNudgeRef,
  checkAiRetriesRef,
  requestAiEnrichment,
  setLoadedAccountUserId,
  setAccountLibraryFailureUserId,
}: Dependencies) {

  const syncNow = useCallback(
    async (options?: { force?: boolean }): Promise<boolean> => {
      const force = options?.force === true;
      if (libraryResetInFlightRef.current) return false;
      if (syncInFlight.current) {
        syncPendingRef.current = true;
        syncPendingForceRef.current ||= force;
        return false;
      }
      if (localCreateFlushesInFlight.current > 0) {
        syncPendingRef.current = true;
        syncPendingForceRef.current ||= force;
        return false;
      }
      if (!auth.session) {
        return false;
      }
      if (syncPausedRef.current || offlineRef.current) {
        // Even while paused, a real account switch must never leave the
        // previous account's cached bookmarks visible under the new session —
        // the pause toggle hiding a cross-account data leak instead of
        // preventing one (Sentry STASH-3K review). The read below is cheap and
        // deliberately NOT guarded by syncInFlight: the auto-sync effect below
        // re-fires syncNow on every queue change, and a paused queue never
        // drains — so this runs often, and holding syncInFlight for the whole
        // check would starve resetLibrary's own busy-guard, which reads the
        // same flag (Sentry STASH-3K review, reported after shipping the first
        // version of this fix: "reset says busy" never cleared because the
        // lock was almost always held). The lock is only taken for the
        // reconcile itself, which is rare (self-terminates after one run) and
        // does write local state.
        const sessionUser = auth.session.user;
        try {
          await ensureRepositoryReady();
          const owner = await readCacheOwner(repository);
          if (owner?.id !== sessionUser.id || owner.isAnonymous !== (sessionUser.is_anonymous !== false)) {
            syncInFlight.current = true;
            try {
              await reconcileAccountTransition({ id: sessionUser.id, isAnonymous: sessionUser.is_anonymous !== false });
            } finally {
              syncInFlight.current = false;
            }
          } else if (authRef.current.userId === sessionUser.id) {
            setReconciledCacheUserId(sessionUser.id);
          }
        } catch (error) {
          if (authRef.current.userId === sessionUser.id) setAccountLibraryFailureUserId?.(sessionUser.id);
          logStorageError("paused account transition", error);
        }
        if (syncPausedRef.current) syncPendingRef.current = true;
        return false;
      }
      syncInFlight.current = true;
      setIsSyncing(true);
      let mutationsPushed = false;
      let syncFailed = 0;
      const recoveryRequested = authRecoveryPendingRef.current;
      try {
        await ensureRepositoryReady();
        // Re-ensure the session so a token that expired while the app stayed
        // open is refreshed before we sync; otherwise every entry would fail
        // against a stale bearer token until restart.
        const refreshRejectedSession = force && librarySyncFlowRef.current.phase === "sign_in";
        const restoredSession = await auth.ensureAnonymousSession(refreshRejectedSession);
        // A failed forced refresh must preserve the provider's expiry/error state,
        // never retry with the bearer token the server already rejected.
        if (refreshRejectedSession && !restoredSession) return false;
        const session = restoredSession ?? auth.session;
        const currentUser = {
          id: session.user.id,
          isAnonymous: session.user.is_anonymous !== false,
        };

        // Account ownership must be reconciled before selecting upload work.
        // Afterwards reload the durable snapshot: React state/ref updates from
        // the transition are not guaranteed to commit before this same sync run
        // continues, and using the captured queue could upload account A's work
        // with account B's token.
        const accountReady = await reconcileAccountTransition(currentUser);
        if (!accountReady) {
          return false;
        }
        // Successful sign-in/refresh is recovery for stale auth failures only,
        // after durable account ownership has been reconciled. No null refresh
        // or fallback bearer may authorize this bypass. Consume it once so a
        // fresh 401 remains blocked until another actual credential recovery.
        const priorCredentials = syncCredentialsRef.current;
        const recoverAuth = !!restoredSession && (recoveryRequested ||
          (!!priorCredentials && (priorCredentials.userId !== session.user.id || priorCredentials.accessToken !== session.access_token)));
        const durableBookmarks = await repository.listBookmarks();
        const durableQueue = await repository.listQueue();
        if (restoredSession) {
          syncCredentialsRef.current = { userId: session.user.id, accessToken: session.access_token };
          credentialsWereUsedRef.current = true;
        }
        if (recoverAuth) authRecoveryPendingRef.current = false;
        // Repository reads allocate fresh arrays/rows even when nothing has
        // changed. Publishing those references unconditionally made every sync
        // pass invalidate the whole Bookmarks context and re-render the large
        // Inbox; STASH-K captured 1.2–3.8s `react-cycle` segments plus RN's
        // "VirtualizedList ... slow to update" warning with one queued mutation.
        // Keep refs fresh for this run, but do not render an identical snapshot.
        const bookmarksChanged = !sameRecordSnapshot(
          bookmarksRef.current ?? [],
          durableBookmarks,
        );
        const queueChanged = !sameRecordSnapshot(queueRef.current, durableQueue);
        bookmarksRef.current = durableBookmarks;
        queueRef.current = durableQueue;
        if (bookmarksChanged) setBookmarks(durableBookmarks);
        if (queueChanged) setQueue(durableQueue);

        // Upload-then-pull: even with nothing to upload, the pull still runs.
        // Defer creates whose metadata is still fetching, so that metadata rides
        // along with the create payload instead of syncing twice.
        const syncable = durableQueue.filter((entry) => {
          // Only an explicit manual request bypasses retry eligibility and
          // backoff. Unrelated saves/nudges/reconnects must not retry terminal
          // auth, permission, or exhausted ordinary failures.
          if (!force && !(recoverAuth && entry.last_error_kind === "auth") && entry.sync_status === "failed" &&
            !canAutomaticallyRetry(entry.last_error_kind, entry.retry_count)) {
            return false;
          }
          if (!isSyncable(entry, { ignoreBackoff: force || (recoverAuth && entry.last_error_kind === "auth") })) {
            return false;
          }
          if (entry.operation === "create") {
            const bookmark = bookmarksRef.current?.find(
              (candidate) => candidate.id === entry.local_id,
            );
            if (bookmark && bookmark.metadata_status === "pending") {
              return false;
            }
          }
          return true;
        });
        const pendingCreateCount = syncable.filter(
          (entry) => entry.operation === "create",
        ).length;
        if (pendingCreateCount > 10) {
          recordLog(
            "info",
            `sync: uploading ${pendingCreateCount} pending create(s) (queue total ${durableQueue.length})`,
          );
        }

        // Await user's language preference publication before uploading bookmarks,
        // so server triggers (like dispatch_ai_enrichment) enrich in the user's
        // chosen language instead of racing and defaulting to English (Comment 1).
        if (syncable.length > 0 && typeof authRef.current.awaitLocalePublication === "function") {
          await authRef.current.awaitLocalePublication();
        }

        const api = createSyncApi(session);
        const createdIdsSyncedThisRun = new Set<string>();
        const getLatestBookmark = (id: string) =>
          bookmarksRef.current?.find((bookmark) => bookmark.id === id);
        // Injected into syncQueueEntry's create branch for an image-only
        // bookmark that still needs its binary uploaded. Reads straight off
        // the durable local file (uploadImageFile streams it directly, never
        // through this function's own memory) and resolves the public
        // Storage URL syncQueueEntry then sends as preview_image_url.
        const uploadBookmarkImage = async (bookmark: Bookmark): Promise<string> => {
          if (!bookmark.local_image_uri) {
            throw new Error("Image bookmark has no local file to upload.");
          }
          // Checked BEFORE ever attempting the network call: the file's
          // size can't change between retries, so if it's over the bucket's
          // own limit it will fail identically forever. IMAGE_TOO_LARGE_ERROR_TEXT
          // is what makes this a permanent (never-retried, drained-from-the-
          // visible-queue) failure rather than an ordinary one — see
          // isPermanentlyUnsyncableUrl in sync/sync-bookmarks.ts. The image
          // itself is unaffected either way: it was already saved and
          // renders locally the moment it was captured.
          const sizeBytes = localFileSizeBytes(bookmark.local_image_uri);
          if (sizeBytes > MAX_UPLOAD_IMAGE_BYTES) {
            const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(1);
            const limitMb = (MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024)).toFixed(0);
            throw new Error(
              `Image is ${sizeMb}MB, which ${IMAGE_TOO_LARGE_ERROR_TEXT} of ${limitMb}MB.`,
            );
          }
          // The real MIME type recorded at capture time is authoritative —
          // prefer it always. Only a row captured before that field existed
          // falls back to guessing from the local file's extension, which
          // can mislabel an unmapped format's Content-Type (acceptable only
          // as a legacy-compat fallback, not the primary path).
          const reportedContentType =
            bookmark.local_image_mime_type ?? mimeTypeForImageUri(bookmark.local_image_uri);
          // canonicalizeImageMimeType normalizes a real-but-nonstandard alias
          // (e.g. some providers report `image/jpg` for a plain JPEG) to the
          // single form the bucket's allowlist actually contains — without
          // this, an honestly-labeled but non-canonical Content-Type would
          // still be permanently rejected by Storage on every retry.
          const contentType = canonicalizeImageMimeType(reportedContentType);
          if (!isCloudUploadImageMime(contentType)) {
            throw new Error(
              `${contentType}: ${IMAGE_UNSUPPORTED_FORMAT_ERROR_TEXT}. Image kept on this device; save as PNG or JPEG to sync.`,
            );
          }
          const target = api.imageUploadTarget(bookmark.id, contentType);
          await uploadImageFile(bookmark.local_image_uri, target.uploadUrl, target.headers);
          return target.publicUrl;
        };
        const applySyncEntryResult = async (
          entry: LocalPendingBookmark,
          result: Awaited<ReturnType<typeof syncQueueEntry>>,
          // STASH-69 investigation: the local_id `noteSyncEntryStatus` should
          // credit an outcome to — usually just `entry.local_id`, except a
          // duplicate-swap adopts a DIFFERENT id (`merged.id` below), to which
          // any open failure episode is separately re-keyed via
          // rekeyBookmarkIdentity/remapSyncStatusIdentity. A plain return
          // value can't carry this to the caller's catch block if THIS
          // function throws after the swap (e.g. rekeyBookmarkIdentity's own
          // awaited writes failing) — the caller would then record the
          // failure against the stale pre-swap id, missing the moved episode
          // the same way a premature 'synced' call would (Codex review on
          // #765). Written to on every reassignment, read by the caller
          // whether this function returns or throws.
          idTracker: { current: string },
        ): Promise<string | false> => {
          if (result.entry.sync_status === "failed") {
            syncFailed += 1;
            // STASH-69 investigation: recorded unconditionally, before any of
            // the branching below — safe to call every pass regardless of
            // outcome (idempotent past the first occurrence). The 'synced'
            // side is deliberately NOT recorded here — see the call site's
            // own comment on why (Codex review on #765: recording it this
            // early risked double-counting one bookmark if this function
            // later threw after this point).
            noteSyncEntryStatus(
              entry.local_id,
              "failed",
              entry.operation,
              result.entry.last_error_kind,
            );
          }
          if (didSyncQueueHealthEscalate(entry, result.entry)) {
            reportSyncQueueHealthEscalation({
              operation: entry.operation,
              retryCount: result.entry.retry_count,
              lastError: result.entry.last_error,
              errorKind: result.entry.last_error_kind,
            });
          }

          if (result.uploadedPayload !== undefined) {
            // STASH-3Y diagnostics: `uploadedPayload` being defined is
            // unconditional proof this create already succeeded remotely
            // (sync-bookmarks.ts only sets it after a successful
            // api.createBookmark call) — record it here, before any of the
            // branching below (deleted-mid-flight, no local row to merge)
            // that would otherwise skip it. Whether it also needed a
            // reconcile follow-up is recorded separately, later, only once
            // that's actually determined — see recordReconcileNeeded.
            recordCreateCompleted();
          }

          // Deleted while a create/update was in flight: don't resurrect it.
          // Undo the rows syncQueueEntry just persisted and best-effort delete
          // the remote copy so the user's delete wins end to end.
          if (
            entry.operation !== "delete" &&
            deletedIds.current.has(entry.local_id)
          ) {
            const replacementId = result.bookmarkUpdate?.id;
            ensureRepositoryReady()
              .then(() =>
                Promise.all([
                  replacementId
                    ? repository.deleteBookmark(replacementId)
                    : Promise.resolve(),
                  // Superseded-aware: a durable delete entry enqueued for this
                  // bookmark while we were uploading must NOT be removed here.
                  removeQueueEntryIfNotSuperseded(repository, entry),
                ]),
              )
              .catch((error) =>
                logStorageError("post-delete sync cleanup", error),
              );
            // See planDeletedMidFlightCleanup's doc comment for the full
            // reasoning — a prior version of this check only enqueued a
            // remote delete for the STASH-3Q duplicate-swap case, silently
            // leaving the far more common same-id case's cloud row
            // undeleted and resurrectable by a later pull; and nothing at
            // all cleaned up an already-uploaded image's Storage object.
            // `uploadedImageUrl` (unlike `uploadedPayload`) is set whether
            // the create itself went on to succeed or fail — a createBookmark
            // failure after a successful upload still leaves a real Storage
            // object that needs the same cleanup.
            const cleanupPlan = planDeletedMidFlightCleanup(
              result.entry.remote_id,
              result.uploadedImageUrl,
              entry.local_id,
            );
            if (cleanupPlan.remoteIdToDelete) {
              // Durable (not best-effort): survives app exit and request
              // failures; the next sync pass processes it. enqueueMutation
              // replaces any prior queue entry for this id rather than
              // duplicating one (see its own comment), so this is safe
              // even when deleteBookmark already queued its own delete
              // moments ago (the already-synced-update case).
              enqueueMutation(cleanupPlan.remoteIdToDelete, "delete");
            }
            if (cleanupPlan.imageIdToCleanUp) {
              // Best-effort — a failure just leaves an orphaned object,
              // never blocks this cleanup. `api` is this run's already
              // session-refreshed instance (see the top of syncNow), not
              // raw auth.session.
              api
                .deleteImages([cleanupPlan.imageIdToCleanUp])
                .catch((error) =>
                  logStorageError("post-delete sync image cleanup", error),
                );
            }
            return false;
          }

          // P1: the create's own request landed successfully, but the live
          // identity changed WHILE it was in flight (checked again inside
          // syncQueueEntry, after the response — see landedUnderDepartedIdentity's
          // own doc comment for why the pre-dispatch check alone can't close
          // this window). The row now has a REAL cloud identity, just under
          // the DEPARTED account — route it through the exact same rehome
          // machinery an account transition uses (fresh id, cleared image
          // URL/owner, tag/import/enrichment/AI-retry re-key) instead of
          // trusting this as a normal confirmed sync, which would durably
          // misattribute a real cloud row to whichever identity is live now.
          if (result.landedUnderDepartedIdentity) {
            // Real durable work happened this pass (a fresh create was
            // enqueued via rehome below), same as any other removeEntry
            // case — matches the semantics mutationsPushed represents
            // elsewhere for a broadcastSyncNudge and this pass's own
            // return value.
            mutationsPushed = true;
            const staleRow = getLatestBookmark(entry.local_id);
            if (staleRow) {
              await serializeTagWork(() => applyAccountTransition(
                {
                  kind: "switch",
                  rehome: [staleRow],
                  drop: [],
                  dropQueue: [],
                  resetWatermark: false,
                },
                repository,
                setBookmarks,
                setQueue,
                makeBookmarkId,
                ensureRepositoryReady,
                {
                  rehome: (idMap) =>
                    rekeyBookmarkIdentity(idMap, { persist: false, carryTags: true, serialized: true }),
                },
              ));
            } else {
              // No local row left to rehome (e.g. a separate concurrent
              // delete that deletedIds.current's own check above didn't
              // catch for some other reason) — nothing to move, but the
              // now-permanently-stale queue entry must still not linger.
              // Durable removal lives HERE (not inside syncQueueEntry, on
              // purpose — see its own comment): there's no atomic replace
              // happening alongside it in this branch to fold it into, so a
              // plain standalone removal is safe and carries no crash-window
              // risk the way removing it before an in-progress rehome would.
              setQueue((current) => {
                const nextQueue = current.filter(
                  (queued) => queued.local_id !== entry.local_id,
                );
                queueRef.current = nextQueue;
                return nextQueue;
              });
              ensureRepositoryReady()
                .then(() => repository.removeQueueEntry(entry.local_id))
                .catch((error) =>
                  logStorageError(
                    "post-landed-under-departed-identity queue cleanup",
                    error,
                  ),
                );
            }
            return false;
          }

          setQueue((current) => {
            const nextQueue = result.removeEntry
              ? current.filter((queued) => queued.local_id !== entry.local_id)
              : current.map((queued) =>
                queued.local_id === entry.local_id ? result.entry : queued,
              );
            queueRef.current = nextQueue;
            return nextQueue;
          });
          if (result.removeEntry) {
            mutationsPushed = true;
          }
          if (result.removedBookmarkId) {
            // The row was deleted on another device while this device's
            // queued edit could never land (see sync-bookmarks.ts). Drop it
            // from in-memory state too — the repository row is already gone.
            const removedId = result.removedBookmarkId;
            if (bookmarksRef.current) {
              bookmarksRef.current = bookmarksRef.current.filter((bookmark) => bookmark.id !== removedId);
            }
            setBookmarks((current) =>
              (current ?? []).filter((bookmark) => bookmark.id !== removedId),
            );
          }
          if (result.bookmarkUpdate) {
            const update = result.bookmarkUpdate;
            // Normally the same row we started with — EXCEPT a create that
            // resolved as a duplicate of an existing different row (STASH-3Q),
            // where `update.id` is that existing row's id and `originalLocalId`
            // is where the in-memory/stored row still sits under its old id.
            const lookupId = result.originalLocalId ?? update.id;
            // The update was built from a snapshot taken before the upload.
            // Enrichment may have completed in the meantime, so apply only the
            // sync-owned fields (id + status) onto the LATEST row instead of
            // writing the stale snapshot back.
            //
            // Compute `merged` from the ref SYNCHRONOUSLY — never from inside the
            // setBookmarks updater. A functional updater doesn't run until React's
            // next render, so reading a variable it assigns right after the call
            // sees the pre-update value (null). That silently skipped this whole
            // block, so neither the metadata-reconciliation update nor the AI
            // auto-trigger ever fired after a create synced.
            const latest = bookmarksRef.current?.find(
              (bookmark) => bookmark.id === lookupId,
            );
            const merged: Bookmark | null = latest
              ? mergeSyncedBookmarkFields(latest, update)
              : null;
            if (merged) {
              // Collapse onto the destination id: a pull that already inserted
              // this bookmark under the existing row's id would otherwise
              // coexist with the just-swapped row as a same-id duplicate.
              if (bookmarksRef.current) {
                bookmarksRef.current = bookmarksRef.current.filter((b) => b.id === lookupId || b.id !== merged.id).map((b) => b.id === lookupId ? merged : b);
              }
              setBookmarks((current) =>
                (current ?? [])
                  .filter(
                    (bookmark) =>
                      bookmark.id === lookupId || bookmark.id !== merged.id,
                  )
                  .map((bookmark) =>
                    bookmark.id === lookupId ? merged : bookmark,
                  ),
              );
              ensureRepositoryReady()
                .then(() => repository.updateBookmark(merged))
                .catch((error) => logStorageError("post-sync merge", error));

              if (
                result.originalLocalId &&
                result.originalLocalId !== merged.id
              ) {
                idTracker.current = merged.id;
                // Re-key tag/AI-retry state the same way account rehoming does
                // — otherwise a tag added (or a rehome carried over) in the
                // window before this duplicate-swap silently never uploads,
                // parked on the now-dead original id.
                await rekeyBookmarkIdentity(
                  new Map([[result.originalLocalId, merged.id]]),
                );
              }

              // `uploadedPayload` is set IFF a create just uploaded — whether
              // the entry began as a `create` or was promoted from an orphaned
              // `update` (a bookmark whose create never reached the server). Use
              // it, not `entry.operation`, so a promoted create reconciles and
              // AI-triggers too: the loop's `entry.operation` is still 'update'.
              const createUploaded = result.uploadedPayload !== undefined;
              if (createUploaded) {
                createdIdsSyncedThisRun.add(merged.id);
              }
              // The create payload only carries url/title/notes, and the remote
              // row defaults to no generated metadata + pending status + active.
              // If the local row has since diverged — archived, filed into a
              // collection, edited, enriched, or TRASHED while the create was
              // uploading — reconcile with a follow-up update so those changes
              // reach the cloud. Without the `deleted_at` arm, a bookmark trashed
              // before it had a remote id would stay live in the cloud and
              // resurrect on other devices.
              if (createUploaded) {
                // STASH-3Y diagnostics: same reconcile path as the bulk chunk
                // loop below, just one entry at a time (single-create
                // fallback). Completion itself was already recorded
                // unconditionally near the top of this function — this only
                // records *why*, once reconcile is confirmed needed.
                const payload = result.uploadedPayload;
                const titleChangedDuringCreate =
                  pendingUserTitleEdits.current.has(lookupId) ||
                  pendingUserTitleEdits.current.has(merged.id) ||
                  pendingGeneratedTitleUpdates.current.has(lookupId) ||
                  pendingGeneratedTitleUpdates.current.has(merged.id);
                const isDuplicateSwap =
                  Boolean(result.originalLocalId) &&
                  result.originalLocalId !== merged.id;
                if (
                  createNeedsReconcileUpdate(merged, payload, {
                    titleChangedByUser: titleChangedDuringCreate,
                  })
                ) {
                  const reasons: Record<string, number> = {};
                  if (isDuplicateSwap) reasons.duplicate_swap = 1;
                  if (merged.deleted_at !== null) reasons.deleted_at = 1;
                  if (merged.is_archived) reasons.is_archived = 1;
                  if (
                    (merged.collection_id ?? null) !==
                    (payload?.collection_id ?? null)
                  ) {
                    reasons.collection_id = 1;
                  }
                  if (
                    merged.title !== (payload?.title ?? null) &&
                    titleChangedDuringCreate
                  ) {
                    reasons.title = 1;
                  }
                  if (merged.notes !== (payload?.notes ?? null))
                    reasons.notes = 1;
                  if (merged.description !== (payload?.shared_text ?? null))
                    reasons.description = 1;
                  recordReconcileNeeded(reasons);
                  recordLog(
                    "info",
                    `single create reconcile: ${JSON.stringify(reasons)}`,
                  );
                  enqueueMutation(merged.id, "update");
                }
                pendingUserTitleEdits.current.delete(lookupId);
                pendingUserTitleEdits.current.delete(merged.id);
                pendingGeneratedTitleUpdates.current.delete(lookupId);
                pendingGeneratedTitleUpdates.current.delete(merged.id);
              }
              // A brand-new bookmark just gained a remote identity: queue AI
              // suggestions for it. We DON'T fire immediately — the background
              // OpenGraph fetch may still be in flight, and enriching against a
              // bare URL yields nothing. The effect below fires once this
              // bookmark's metadata enrichment has settled.
              if (createUploaded) {
                markPendingAiTrigger(merged.id);
              }
              mutationsPushed = true;
            }
          }
          // STASH-69 investigation: no `bookmarkUpdate` means the create
          // succeeded remotely but this device never had (or already lost)
          // a local bookmark row to merge it onto — the bulk path's
          // `queueOnlyEntries` is the identical case, also excluded there.
          // No local row ever existed to show a sync status to the user, so
          // it's not evidence either way for STASH-69 (Codex review on
          // #765).
          return result.bookmarkUpdate ? idTracker.current : false;
        };
        const applyBulkCreateChunkResults = async (
          chunk: LocalPendingBookmark[],
          results: Awaited<ReturnType<typeof syncCreateQueueEntryBatch>>,
        ) => {
          if (results.length > 0) {
            // STASH-3Y diagnostics: recorded unconditionally, before any of the
            // per-entry branching below (deleted-mid-flight, no local row to
            // merge) that can make the *rest* of this function skip an entry,
            // or even return early if the whole chunk hits one of those. Every
            // result syncCreateQueueEntryBatch returns already represents a
            // create that succeeded remotely (see the comment on
            // completedLocalIds.add below).
            recordBulkChunkStarted(results.length);
          }
          // STASH-K: bracketed rather than wrapped in a closure so the region's
          // own declarations stay in scope for the rest of this function. Nothing
          // between here and the record call awaits, so the elapsed time IS
          // JS-thread block time — the quantity the loop-stall watchdog measures
          // from the outside. This loop is O(chunk x library) via the
          // `preUploadSnapshot.find` below, so it is a prime suspect for a stall
          // reported with a large queue.
          const collectStartedAt = Date.now();
          const completedLocalIds = new Set<string>();
          const completions: CreateSyncCompletion[] = [];
          const queueOnlyEntries: LocalPendingBookmark[] = [];
          type UploadedPayload = NonNullable<
            (typeof results)[number]["uploadedPayload"]
          >;
          // Keyed by lookupId (originalLocalId ?? update.id) rather than pushed
          // alongside `merged` in this first loop — the reconcile check that
          // consumes this needs to run against the FRESHEST row, after the
          // durable await below, not this pre-await snapshot (see there).
          const uploadedPayloadByLookupId = new Map<string, UploadedPayload>();
          const rekeyedIds = new Map<string, string>();
          const preUploadSnapshot = bookmarksRef.current ?? [];

          for (
            let resultIndex = 0;
            resultIndex < results.length;
            resultIndex += 1
          ) {
            const entry = chunk[resultIndex]!;
            const result = results[resultIndex]!;

            if (
              entry.operation !== "delete" &&
              deletedIds.current.has(entry.local_id)
            ) {
              const replacementId = result.bookmarkUpdate?.id;
              ensureRepositoryReady()
                .then(() =>
                  Promise.all([
                    replacementId
                      ? repository.deleteBookmark(replacementId)
                      : Promise.resolve(),
                    removeQueueEntryIfNotSuperseded(repository, entry),
                  ]),
                )
                .catch((error) =>
                  logStorageError("post-delete sync cleanup", error),
                );
              if (
                result.entry.remote_id &&
                result.entry.remote_id !== entry.local_id
              ) {
                enqueueMutation(result.entry.remote_id, "delete");
              }
              continue;
            }

            // Every result syncCreateQueueEntryBatch returns is a completed
            // create — it never emits a "retry later" state per entry the way
            // syncQueueEntry does (a batch failure throws instead, caught by
            // this call's try/catch above), so it never sets removeEntry.
            // Gating on that field here (as this used to) silently skipped
            // every bulk-created entry: the queue entry was never cleared, the
            // bookmark was never marked synced, and nothing was ever persisted
            // — the exact cause of the reported "sync stuck re-uploading the
            // same batch forever" bug (Sentry STASH-3V/3X and others).
            completedLocalIds.add(entry.local_id);

            if (!result.bookmarkUpdate) {
              // A create can succeed with no local bookmark to update — e.g.
              // the bookmark's own durable write failed independently earlier.
              // Its queue row has no bookmark to merge, but it must still be
              // cleared durably below, or it lingers unchanged and gets
              // re-uploaded after the next restart.
              queueOnlyEntries.push(entry);
              continue;
            }

            const update = result.bookmarkUpdate;
            const lookupId = result.originalLocalId ?? update.id;
            const latest = preUploadSnapshot.find(
              (bookmark) => bookmark.id === lookupId,
            );
            if (!latest) {
              continue;
            }
            const merged: Bookmark = {
              ...latest,
              id: update.id,
              sync_status: update.sync_status,
              ever_synced: update.ever_synced,
              updated_at: update.updated_at,
            };
            completions.push({
              bookmark: merged,
              entry,
              originalLocalId: result.originalLocalId,
            });
            if (
              result.originalLocalId &&
              result.originalLocalId !== merged.id
            ) {
              rekeyedIds.set(result.originalLocalId, merged.id);
            }

            if (result.uploadedPayload !== undefined) {
              uploadedPayloadByLookupId.set(lookupId, result.uploadedPayload);
            }
          }

          recordSlowSegment(
            "bulk-chunk-collect",
            Date.now() - collectStartedAt,
          );

          if (completedLocalIds.size === 0) {
            return;
          }

          // Persist durably BEFORE reflecting completion in memory. If this
          // throws, the in-memory queue must stay untouched (entries still
          // 'syncing', which the auto-sync effect retries the same as
          // 'pending') — otherwise the current session would show an empty
          // queue and stop retrying while the durable queue still has these
          // entries pending, until the next app restart reloads the real state.
          await ensureRepositoryReady();
          try {
            if (repository.completeCreateSyncBatch) {
              await repository.completeCreateSyncBatch(completions);
            } else {
              await Promise.all(
                completions.flatMap(({ bookmark, entry, originalLocalId }) => {
                  const isSwap =
                    Boolean(originalLocalId) && originalLocalId !== bookmark.id;
                  return [
                    ...(isSwap
                      ? [repository.deleteBookmark(originalLocalId!)]
                      : []),
                    // insertBookmark (not updateBookmark) for a swap: the
                    // destination id is new to this device, and updateBookmark
                    // only replaces a row already stored under that id (see
                    // syncQueueEntry's identical fix in sync-bookmarks.ts).
                    isSwap
                      ? repository.insertBookmark(bookmark)
                      : repository.updateBookmark(bookmark),
                    removeQueueEntryIfNotSuperseded(repository, entry),
                  ];
                }),
              );
            }
            await Promise.all(
              queueOnlyEntries.map((entry) =>
                removeQueueEntryIfNotSuperseded(repository, entry),
              ),
            );
          } catch (error) {
            logStorageError("bulk create sync completion", error);
            return;
          }

          mutationsPushed = true;

          // Re-derive the in-memory merge from the CURRENT bookmarks, not the
          // pre-upload snapshot above — the user may have edited, trashed, or
          // permanently deleted one of these rows while this chunk's network
          // round-trip and the durable persist above were in flight, and that
          // newer state must win over the stale snapshot (mirrors
          // applySyncEntryResult's identical discipline for the single-entry
          // path — see its "computed synchronously from the ref" comment).
          // STASH-K: same bracketing as `bulk-chunk-collect` above — an
          // await-free region whose elapsed time is JS-thread block time. This
          // one re-filters and re-maps the whole library once per completion
          // (see the collapse-onto-destination-id step below), so its cost grows
          // with chunk size x library size.
          const mergeStartedAt = Date.now();
          let nextBookmarks = bookmarksRef.current ?? [];
          // Collected rather than enqueued/triggered inline: enqueueMutation's
          // own setQueue call would otherwise run BEFORE the completedLocalIds
          // cleanup below and get wiped out by it (that filter doesn't
          // distinguish a freshly re-added delete/update entry from the
          // original completed create entry it's meant to clear).
          const deletedMidFlightIds: string[] = [];
          const followUpUpdates: Bookmark[] = [];
          const pendingAiIds: string[] = [];
          // STASH-3Y guard: every id this chunk itself re-queues (mid-flight
          // delete, reconcile follow-up) so findStaleQueueEntries below can
          // tell "legitimately re-queued" apart from "leftover from a bug".
          const reenqueuedIdsThisChunk = new Set<string>();
          // STASH-3Y diagnostics: which field(s) triggered createNeedsReconcileUpdate,
          // tallied (not per-row — this chunk can run hundreds of times in one
          // bulk import) so a future report shows WHY the queue grew back after
          // a chunk finished, instead of guessing again. Remove once STASH-3Y's
          // actual cause is confirmed and fixed.
          const reconcileReasonTally: Record<string, number> = {};
          const queueLenBeforeChunk = queueRef.current.length;
          for (const {
            bookmark: update,
            entry: completedEntry,
            originalLocalId,
          } of completions) {
            const lookupId = originalLocalId ?? update.id;
            // Deleted while the upload/durable-persist was in flight: the
            // user's delete may have run before this row's sync_status flip
            // landed, so `deleteBookmark` saw it as never-synced and skipped
            // enqueuing a remote delete. This row is now confirmed to exist
            // remotely under `update.id` (this sync just created/updated it),
            // so finish that cleanup here instead of resurrecting it. The
            // actual persist runs sequentially, below, once all of this
            // chunk's completions are known (STASH-3B/3N precedent) — firing
            // it inline here would stack up to a chunk's worth of simultaneous
            // native calls onto the single serialized SQLite connection.
            if (
              deletedIds.current.has(lookupId) ||
              deletedIds.current.has(update.id)
            ) {
              deletedMidFlightIds.push(update.id);
              continue;
            }
            const latest = nextBookmarks.find(
              (bookmark) => bookmark.id === lookupId,
            );
            if (!latest) {
              continue;
            }
            // STASH-69 investigation: recorded here, not in the earlier
            // per-result loop — this point is reached only once the durable
            // persist above has actually succeeded AND this specific entry
            // wasn't deleted mid-flight/missing its local row, so it's the
            // earliest place this bookmark can truthfully be said to have
            // reached 'synced'. Recording it any earlier risked counting an
            // entry whose durable completion later failed entirely (Codex
            // review on #765) — those stay 'syncing' and get retried, which
            // would otherwise double-count them on that retry.
            if (update.sync_status === "synced") {
              noteSyncEntryStatus(lookupId, "synced", completedEntry.operation);
              captureSyncRecovery(completedEntry);
            }
            const merged: Bookmark = {
              ...latest,
              id: update.id,
              sync_status: update.sync_status,
              ever_synced: update.ever_synced,
              updated_at: update.updated_at,
            };
            // Collapse onto the destination id (see applySyncEntryResult) so a
            // pull that already inserted this bookmark under the existing row's
            // id doesn't end up sharing that id with a second entry.
            nextBookmarks = nextBookmarks
              .filter(
                (bookmark) =>
                  bookmark.id === lookupId || bookmark.id !== merged.id,
              )
              .map((bookmark) =>
                bookmark.id === lookupId ? merged : bookmark,
              );

            const uploadedPayload = uploadedPayloadByLookupId.get(lookupId);
            if (uploadedPayload !== undefined) {
              // Checked against `merged` (the FRESH row, just recomputed
              // above) rather than the pre-await snapshot — an edit made while
              // completeCreateSyncBatch was awaiting wouldn't enqueue its own
              // update (hasSyncedOnce was still false at edit time), so this
              // reconcile check is the only remaining path that can push it;
              // checking the stale snapshot would silently drop it, and a
              // later pull could then overwrite it with the older uploaded
              // values (caught in PR review).
              const titleChangedDuringCreate =
                pendingUserTitleEdits.current.has(lookupId) ||
                pendingUserTitleEdits.current.has(merged.id) ||
                pendingGeneratedTitleUpdates.current.has(lookupId) ||
                pendingGeneratedTitleUpdates.current.has(merged.id);
              const isDuplicateSwap =
                Boolean(originalLocalId) && originalLocalId !== merged.id;
              if (
                createNeedsReconcileUpdate(merged, uploadedPayload, {
                  titleChangedByUser: titleChangedDuringCreate,
                })
              ) {
                followUpUpdates.push(merged);
                const reasons: Record<string, number> = {};
                if (isDuplicateSwap) reasons.duplicate_swap = 1;
                if (merged.deleted_at !== null) reasons.deleted_at = 1;
                if (merged.is_archived) reasons.is_archived = 1;
                if (
                  (merged.collection_id ?? null) !==
                  (uploadedPayload.collection_id ?? null)
                ) {
                  reasons.collection_id = 1;
                }
                if (
                  merged.title !== (uploadedPayload.title ?? null) &&
                  titleChangedDuringCreate
                ) {
                  reasons.title = 1;
                }
                if (merged.notes !== (uploadedPayload.notes ?? null))
                  reasons.notes = 1;
                if (
                  merged.description !== (uploadedPayload.shared_text ?? null)
                )
                  reasons.description = 1;
                recordReconcileNeeded(reasons);
                for (const [reason, count] of Object.entries(reasons)) {
                  reconcileReasonTally[reason] =
                    (reconcileReasonTally[reason] ?? 0) + count;
                }
              }
              pendingUserTitleEdits.current.delete(lookupId);
              pendingUserTitleEdits.current.delete(merged.id);
              pendingGeneratedTitleUpdates.current.delete(lookupId);
              pendingGeneratedTitleUpdates.current.delete(merged.id);
              if (uploadedPayload.enrichment_policy !== "skip") {
                pendingAiIds.push(merged.id);
              }
            }
          }
          bookmarksRef.current = nextBookmarks;
          setBookmarks(nextBookmarks);
          setQueue((current) =>
            current.filter((queued) => !completedLocalIds.has(queued.local_id)),
          );
          // Mirrored synchronously (same rationale as enqueueMutation's own
          // queueRef write below) so findStaleQueueEntries reads an accurate
          // queue at the end of this function instead of racing the `useEffect`
          // that normally mirrors `queue` -> queueRef after the next render.
          queueRef.current = queueRef.current.filter(
            (queued) => !completedLocalIds.has(queued.local_id),
          );
          recordSlowSegment("bulk-chunk-merge", Date.now() - mergeStartedAt);
          recordLog(
            "info",
            `bulk create chunk: ${completedLocalIds.size} completed, queue ${queueLenBeforeChunk} -> ` +
            `~${queueLenBeforeChunk - completedLocalIds.size + followUpUpdates.length + deletedMidFlightIds.length}` +
            ` (reconcile ${followUpUpdates.length}, deletedMidFlight ${deletedMidFlightIds.length},` +
            ` reasons ${JSON.stringify(reconcileReasonTally)})`,
          );

          if (rekeyedIds.size > 0) {
            // A create in this chunk resolved as a duplicate of an existing
            // different row (STASH-3Q) — re-key tag/AI-retry state the same
            // way account rehoming does, or it silently never uploads, parked
            // on the now-dead original id. Installed BEFORE the follow-up
            // persist loops below (not after) — those loops now await real
            // SQLite writes in sequence, and an in-flight metadata enrichment
            // or an open Detail route still holding the original id needs the
            // alias resolvable for that whole window, not just once this
            // chunk's persistence finally settles (caught in PR review).
            await rekeyBookmarkIdentity(rekeyedIds);
          }
          for (const localId of completedLocalIds) {
            createdIdsSyncedThisRun.add(rekeyedIds.get(localId) ?? localId);
          }

          // Covers the AI-marker persist below AND both follow-up loops: the
          // queue has no pending/syncing entries for this chunk's ids between
          // completedLocalIds being filtered out (above) and their
          // replacement 'update'/'delete' mutations being enqueued (inside
          // these loops) — a window that now spans real, sequential SQLite
          // writes, INCLUDING the awaited marker-persist write immediately
          // below. The 400ms AI-dispatch interval (see below) checks this
          // flag so it doesn't mistake any part of that gap for "sync
          // settled" and start firing AI requests during it — incremented
          // before the marker persist, not just before the two loops, since
          // that write can itself outlast one dispatch tick (caught in PR
          // review).
          bulkReconcileInFlight.current += 1;
          try {
            // Persisted BEFORE the follow-up loops below (not after), same
            // reason as rekeyBookmarkIdentity above: completeCreateSyncBatch
            // already marked every one of these creates synced and removed its
            // create queue entry, so if the app exits while a later entry's
            // reconcile write is still in flight, there is no other path left
            // to recreate a missed durable AI-trigger marker on restart — a
            // successfully created bookmark would then permanently miss its
            // automatic AI suggestions (caught in PR review). Only the marker
            // is persisted here; actual dispatch stays gated on enrichment
            // settling, same as before. Adds every id to the ref first (cheap,
            // synchronous) and persists ONCE, awaited — calling
            // markPendingAiTrigger per id instead would fire that many
            // independent, un-awaited setMeta writes onto the single serialized
            // SQLite actor, recreating the exact fan-out contention this PR
            // exists to fix (caught in PR review). Calls repository.setMeta
            // directly (not persistPendingAiTrigger, which swallows its own
            // failure and resolves anyway) wrapped in retryStorageWrite, so a
            // failed write here is actually retried and visibly logged on
            // total failure, instead of silently "succeeding" on the first
            // attempt (caught in PR review).
            if (pendingAiIds.length > 0) {
              for (const id of pendingAiIds) {
                pendingAiTrigger.current.add(id);
              }
              try {
                await retryStorageWrite(async () => {
                  await ensureRepositoryReady();
                  await repository.setMeta(
                    PENDING_AI_TRIGGER_KEY,
                    JSON.stringify([...pendingAiTrigger.current]),
                  );
                });
              } catch (error) {
                logStorageError("ai trigger queue", error);
              }
            }
            if (deletedMidFlightIds.length > 0) {
              // Sequential on purpose (STASH-3B/3N precedent, see
              // docs/architecture/sqlite-write-contention.md): a chunk with many
              // mid-flight deletes fired concurrently would stack that many
              // simultaneous native calls onto the single serialized SQLite
              // connection. Each id's local row is deleted durably BEFORE its
              // remote-delete mutation is queued (not after) — queueing first
              // and a crash before the local delete lands would leave a 'delete'
              // queue entry whose row was never actually removed locally, which
              // resurrects it once that entry finishes syncing (caught in PR
              // review). Awaited here, not fire-and-forget, so the outer
              // per-chunk loop above can't start the next chunk's own persist
              // chain concurrently with this one. Each id isolated in its own
              // try/catch — completeCreateSyncBatch already durably persisted
              // and dequeued every one of these, so a storage failure on one
              // must not also cost the rest of the chunk their delete (caught in
              // PR review). Retried (retryStorageWrite) rather than given up on
              // after a single failure: nothing else will ever retry this
              // specific delete once completeCreateSyncBatch has dequeued the
              // create, and enqueueing the remote delete without the local row
              // actually gone would be premature — the remote copy would be
              // deleted while the local row silently survives and resurrects on
              // restart (caught in PR review).
              for (const id of deletedMidFlightIds) {
                try {
                  await ensureRepositoryReady();
                  await retryStorageWrite(() => repository.deleteBookmark(id));
                  enqueueMutation(id, "delete");
                  reenqueuedIdsThisChunk.add(id);
                } catch (error) {
                  logStorageError("post-delete sync cleanup", error);
                }
              }
            }
            if (followUpUpdates.length > 0) {
              // completeCreateSyncBatch already wrote the pre-await snapshot
              // durably; if a concurrent edit is what made this reconcile
              // necessary, that edit only lives in-memory until this write
              // lands. Without it, exiting before the queued 'update' below
              // actually syncs would reload the stale row on restart — and the
              // 'update' queue entry carries no field snapshot of its own (it
              // derives its payload from whatever bookmark is loaded at sync
              // time), so the edit would be permanently lost, not just delayed
              // (caught in PR review). Sequential, not fired per-entry
              // concurrently (STASH-3B/3N precedent, see
              // docs/architecture/sqlite-write-contention.md) — a chunk that
              // reconciles many entries at once would otherwise stack that many
              // simultaneous native calls onto the single serialized SQLite
              // connection. Re-reads each row from bookmarksRef.current right
              // before its own write (not the snapshot captured when this chunk
              // started) — these writes now take real wall-clock time in
              // sequence, so a later entry's row may have been edited again
              // while an earlier entry's write was still in flight, and writing
              // the stale snapshot would clobber that edit (caught in PR
              // review). Persisted durably before its own mutation is queued
              // (not after), for the same crash-ordering reason as the
              // mid-flight-delete loop above. Awaited here, not fire-and-forget,
              // so the outer per-chunk loop above can't start the next chunk's
              // own persist chain concurrently with this one. Each entry
              // isolated in its own try/catch, same reason as the mid-flight
              // delete loop above. Retried (retryStorageWrite) rather than given
              // up on after a single failure — nothing else will ever retry
              // this specific reconcile write once completeCreateSyncBatch has
              // already dequeued the create, and enqueueing the 'update'
              // mutation without it landing would just push the stale
              // pre-reconcile row (the update mutation carries no field
              // snapshot of its own — see above) rather than recovering
              // anything (caught in PR review).
              for (const bookmark of followUpUpdates) {
                try {
                  // deletedIds.current (set synchronously by deleteBookmark) is
                  // checked in addition to bookmarksRef.current, not instead of
                  // it — deleteBookmark's setBookmarks call only reaches
                  // bookmarksRef.current via a separate effect after React
                  // commits, so a delete landing right before this check could
                  // still show the row as present there if that effect hasn't
                  // flushed yet (caught in PR review). bookmarksRef.current
                  // itself stays the read source for the write below: writers
                  // like applyBookmarkUpdate deliberately keep it synchronously
                  // current (see its own comment) specifically so a later
                  // reconcile pass here doesn't clobber a fresh edit — reading
                  // durable storage directly instead would race that same
                  // writer's own fire-and-forget persist and can read BEFORE
                  // it lands, which is a worse version of the same problem.
                  const isGone = () =>
                    deletedIds.current.has(bookmark.id) ||
                    !bookmarksRef.current?.some((b) => b.id === bookmark.id);
                  if (isGone()) {
                    // No longer present — permanently deleted since this chunk
                    // started. Falling back to the stale pre-delete snapshot
                    // would resurrect it (writing it back via updateBookmark)
                    // and the 'update' mutation below would supersede the
                    // delete's own queued mutation, silently undoing the user's
                    // delete (caught in PR review). The delete flow already owns
                    // this row's remote-delete cleanup — nothing to reconcile.
                    continue;
                  }
                  await ensureRepositoryReady();
                  // Re-reads bookmarksRef.current inside EVERY retry attempt,
                  // not once before calling retryStorageWrite — an ordinary edit
                  // (or the row being deleted) landing during a retry's delay
                  // must not be overwritten by a snapshot captured before that
                  // attempt even started (caught in PR review). A row that's
                  // gone by the time a retry runs no-ops rather than throwing —
                  // there's nothing left to write, and throwing would just
                  // burn the remaining retry attempts on a row that will never
                  // come back.
                  await retryStorageWrite(() => {
                    if (deletedIds.current.has(bookmark.id)) {
                      return Promise.resolve();
                    }
                    const latest = bookmarksRef.current?.find(
                      (b) => b.id === bookmark.id,
                    );
                    return latest
                      ? repository.updateBookmark(latest)
                      : Promise.resolve();
                  });
                  // Recheck AFTER the (possibly long, now-retried) write: the
                  // user may have permanently deleted this same bookmark WHILE
                  // it was in flight. deleteBookmark already queued its own
                  // 'delete' mutation for it; unconditionally enqueueing
                  // 'update' here would supersede that queued delete and
                  // resurrect the row exactly like the stale-snapshot case above
                  // — just from a race inside this write instead of before it
                  // started (caught in PR review).
                  if (isGone()) {
                    continue;
                  }
                  enqueueMutation(bookmark.id, "update");
                  reenqueuedIdsThisChunk.add(bookmark.id);
                } catch (error) {
                  logStorageError("post-sync reconcile persist", error);
                }
              }
            }
            const staleQueueEntries = findStaleQueueEntries(
              completedLocalIds,
              reenqueuedIdsThisChunk,
              queueRef.current.map((queued) => queued.local_id),
            );
            if (staleQueueEntries.length > 0) {
              reportQueueReconcileMismatch({
                staleCount: staleQueueEntries.length,
                chunkCompletedCount: completedLocalIds.size,
                reenqueuedCount: reenqueuedIdsThisChunk.size,
              });
            }
          } finally {
            bulkReconcileInFlight.current -= 1;
          }
        };
        const bulkSyncedLocalIds = new Set<string>();
        const bulkCreateEntries = syncable.filter(
          (entry) =>
            entry.operation === "create" &&
            !deletedIds.current.has(entry.local_id) &&
            // Image creates need an upload-then-create step the bulk batch
            // endpoint has no room for — always routed through the per-entry
            // loop below instead (see syncCreateQueueEntryBatch's own guard).
            entry.payload.content_type !== "image" &&
            hasBulkCreateResultKey(entry) &&
            isSyncable(entry, { ignoreBackoff: force || (recoverAuth && entry.last_error_kind === "auth") }),
        );
        if (bulkCreateEntries.length > 1) {
          for (
            let index = 0;
            index < bulkCreateEntries.length;
            index += BULK_CREATE_SYNC_CHUNK_SIZE
          ) {
            // Re-checked every chunk: pausing mid-import must stop the
            // remaining chunks from uploading, not just block the next
            // syncNow call.
            if (syncPausedRef.current) {
              break;
            }
            const chunk = bulkCreateEntries.slice(
              index,
              index + BULK_CREATE_SYNC_CHUNK_SIZE,
            );
            const chunkIds = new Set(chunk.map((entry) => entry.local_id));
            try {
              setQueue((current) =>
                current.map((queued) =>
                  chunkIds.has(queued.local_id)
                    ? { ...queued, sync_status: "syncing" }
                    : queued,
                ),
              );
              const results = await syncCreateQueueEntryBatch(
                api,
                chunk,
                getLatestBookmark,
                // authRef, not `auth` — see authRef's own doc comment above
                // for why: this closure can still be running long after the
                // render that created it, and `auth` itself would stay
                // frozen at whatever it was then. Same reasoning as the
                // single-entry syncQueueEntry call below.
                () => authRef.current.session?.user.id ?? null,
              );
              await applyBulkCreateChunkResults(chunk, results);
              for (const entry of chunk) {
                bulkSyncedLocalIds.add(entry.local_id);
              }
            } catch (error) {
              // Only this chunk failed — mark just its entries 'failed' (with
              // retry accounting, like any other sync failure) and stop trying
              // further chunks this run, since a bulk-endpoint failure likely
              // affects them too. Entries in later, never-attempted chunks are
              // untouched (still 'pending') and picked up by the next pass —
              // no separate "preserve bulk mode" bookkeeping needed: a 'failed'
              // entry is still bulk-eligible (isSyncable), so it naturally
              // retries via bulk again next time.
              const message =
                error instanceof Error ? error.message : String(error);
              // A batch request fails as a whole even when only ONE row in it
              // is actually bad (e.g. a legacy too-long URL) — the error text
              // is a fact about that one row, not the other 49. Copying it onto
              // every entry would make `isPermanentlyUnsyncableUrl` wrongly
              // exclude the rest of the chunk from sync forever (caught in PR
              // review). Instead, leave this chunk's entries untouched here and
              // let them fall through to the per-entry loop below, which will
              // isolate the real offender by getting each row's own error.
              const isRowSpecificError =
                isRowSpecificPermanentSyncErrorText(message);

              if (!isRowSpecificError) {
                const failedAt = new Date().toISOString();
                const failureKind = syncErrorKind(error);
                recordLog(
                  "warn",
                  `bulk create sync failed for a chunk of ${chunk.length} (${message})`,
                );

                // Every other remaining, untried bulk-eligible entry is marked
                // 'failed' too (retry_count left UNCHANGED, since it was never
                // actually attempted) rather than left 'pending'. Leaving them
                // 'pending' satisfies the auto-sync effect's retrigger
                // condition, so the instant this run ends it calls syncNow()
                // again — and that call tries THIS SAME already-failed chunk
                // first, recreating a continuous retry loop for the duration
                // of a real outage instead of waiting for the next natural
                // trigger (a save, app foreground, manual Sync now), exactly
                // like every other failed entry already does (caught in PR
                // review).
                // Only entries strictly AFTER this chunk are untried — anything
                // before `index` already succeeded in an earlier iteration of
                // this same loop (a prior failure would have `break`ed out
                // already) and was cleared from the queue. Filtering the whole
                // of `bulkCreateEntries` by "not in this chunk" wrongly
                // included those already-completed entries too, flipping their
                // bookmarks back to 'failed' below even though they have no
                // queue entry left to retry (caught in PR review).
                const untriedEntries = bulkCreateEntries.slice(
                  index + chunk.length,
                );

                const failedEntries = new Map<string, LocalPendingBookmark>();
                for (const entry of chunk) {
                  const failedEntry = applySyncQueueHealthEscalation(entry, {
                    ...entry,
                    sync_status: "failed",
                    retry_count: entry.retry_count + 1,
                    last_error: message,
                    last_error_kind: failureKind,
                    // These entries were actually attempted (the failed bulk
                    // request), so the retry backoff clock starts now — see
                    // isSyncable/uploadRetryBackoffMs. The untried entries below
                    // deliberately do NOT get this: they never made a request,
                    // so they keep whatever backoff state (if any) they already
                    // had instead of newly earning one.
                    last_attempt_at: failedAt,
                    updated_at: failedAt,
                  }, failedAt);
                  failedEntries.set(entry.local_id, failedEntry);
                }
                for (const entry of untriedEntries) {
                  const failedEntry = applySyncQueueHealthEscalation(entry, {
                    ...entry,
                    sync_status: "failed",
                    last_error:
                      "Not attempted: an earlier chunk in this bulk sync failed.",
                    // Preserve the attempted chunk's actual cause instead of
                    // re-classifying this synthetic message as a separate
                    // application failure (PR #744 review).
                    last_error_kind: failureKind,
                    updated_at: failedAt,
                  }, failedAt);
                  failedEntries.set(entry.local_id, failedEntry);
                }
                syncFailed += failedEntries.size;
                // STASH-69 investigation: a bulk-create chunk failure marks
                // every entry in it (plus untried later entries) 'failed' in
                // one shot — a real, likely source of "it always fails
                // first" reports on a multi-item import. A later successful
                // retry of these SAME entries (while at least two remain
                // bulk-eligible) goes through applyBulkCreateChunkResults's
                // own 'synced' call, not the per-entry loop — see there.
                for (const [localId, failedEntry] of failedEntries) {
                  noteSyncEntryStatus(
                    localId,
                    "failed",
                    failedEntry.operation,
                    failedEntry.last_error_kind,
                  );
                }

                try {
                  await ensureRepositoryReady();
                  // One listQueue() read for the whole batch, not one per entry —
                  // the native backend does a full ordered SELECT + deserialize
                  // of every queued payload on each call, so calling it per-entry
                  // scans the whole queue up to hundreds of times over for one
                  // failure.
                  const storedByLocalId = new Map(
                    (await repository.listQueue()).map((queued) => [
                      queued.local_id,
                      queued,
                    ]),
                  );
                  for (const entry of [...chunk, ...untriedEntries]) {
                    // The listQueue() snapshot above is taken once for the
                    // whole batch, so a permanent delete that lands on a
                    // later (untried) entry AFTER the snapshot but BEFORE this
                    // iteration reaches it wouldn't show up in `stored` —
                    // writing this failed state back would resurrect the
                    // durable queue row deleteBookmark just removed. Checked
                    // against the live ref (never stale), not the snapshot.
                    if (deletedIds.current.has(entry.local_id)) {
                      continue;
                    }
                    const stored = storedByLocalId.get(entry.local_id);
                    if (!stored || stored.updated_at !== entry.updated_at) {
                      continue;
                    }
                    const failedEntry = failedEntries.get(entry.local_id)!;
                    await repository.updateQueueEntry(failedEntry);
                    // Escalate immediately once the retry_count has landed
                    // durably — untouched (untried) entries always compare
                    // equal here and never cross the threshold, so this is
                    // naturally a no-op for them. Reported right after the
                    // queue write (not after the cosmetic bookmark write
                    // below), or a bookmark-write failure would jump to the
                    // outer catch and permanently lose this entry's one-time
                    // escalation even though its retry_count already persisted
                    // (caught in PR review).
                    if (didSyncQueueHealthEscalate(entry, failedEntry)) {
                      reportSyncQueueHealthEscalation({
                        operation: failedEntry.operation,
                        retryCount: failedEntry.retry_count,
                        lastError: failedEntry.last_error,
                        errorKind: failedEntry.last_error_kind,
                      });
                    }
                    const bookmark = getLatestBookmark(entry.local_id);
                    if (bookmark && bookmark.sync_status !== "failed") {
                      await repository.updateBookmark({
                        ...bookmark,
                        sync_status: "failed",
                      });
                    }
                  }
                } catch (persistError) {
                  logStorageError("bulk create failure persist", persistError);
                }

                setQueue((current) =>
                  current.map(
                    (queued) => failedEntries.get(queued.local_id) ?? queued,
                  ),
                );
                setBookmarks((current) =>
                  (current ?? []).map((bookmark) =>
                    failedEntries.has(bookmark.id) &&
                      bookmark.sync_status !== "failed"
                      ? { ...bookmark, sync_status: "failed" }
                      : bookmark,
                  ),
                );
              } else {
                recordLog(
                  "warn",
                  `bulk create sync failed for a chunk of ${chunk.length} with a row-specific ` +
                  `error (${message}); falling back to per-entry sync to isolate the offending row`,
                );
              }

              // Keep every remaining bulk-eligible entry from OTHER, untried
              // chunks out of the per-entry fallback loop below — otherwise a
              // bulk-endpoint outage during a 561-item import falls through to
              // hundreds of sequential single-create requests in this same run
              // instead of waiting for the next bulk retry (they're now marked
              // 'failed' above, same as this chunk, rather than left 'pending').
              // This chunk's own entries are excluded from that protection only
              // when the failure was row-specific, so the per-entry loop can
              // isolate the real offender instead of every entry in the chunk
              // being misclassified together.
              for (const entry of bulkCreateEntries) {
                if (isRowSpecificError && chunkIds.has(entry.local_id)) {
                  continue;
                }
                bulkSyncedLocalIds.add(entry.local_id);
              }
              break;
            }
          }
        }

        for (const entry of syncable) {
          // Same rationale as the bulk-chunk loop above: re-check every entry so
          // pausing mid-run stops the remaining queue from uploading.
          if (syncPausedRef.current) {
            break;
          }
          if (bulkSyncedLocalIds.has(entry.local_id)) {
            continue;
          }
          // Deleted while this run was queued up: skip creates/updates for it.
          // Delete entries are exactly how that deletion reaches the server,
          // so they must still run.
          if (
            entry.operation !== "delete" &&
            deletedIds.current.has(entry.local_id)
          ) {
            continue;
          }

          // A storage/repository failure on one entry must not abort the whole
          // run and strand this (and every later) entry at 'syncing' forever.
          // Mark just this entry failed so the next pass retries it.
          // STASH-69 investigation: tracks applySyncEntryResult's effective
          // id across a throw, not just a normal return — see its own
          // parameter doc comment (Codex review on #765).
          const idTracker = { current: entry.local_id };
          try {
            setQueue((current) =>
              current.map((queued) =>
                queued.local_id === entry.local_id
                  ? { ...queued, sync_status: "syncing" }
                  : queued,
              ),
            );

            const result = await syncQueueEntry(
              api,
              repository,
              entry,
              getLatestBookmark,
              uploadBookmarkImage,
              // P1, round 8/10: `api` (and its `.userId`) was built once at
              // the top of this sync cycle — this reads the LIVE signed-in
              // user id fresh, at the exact moment syncQueueEntry checks it,
              // so a sign-out mid-flight (the logout effect runs
              // independently and doesn't wait for an in-flight sync) is
              // caught before a create ever gets durably confirmed under the
              // departed identity. `authRef.current`, NOT the closed-over
              // `auth` — see authRef's own doc comment above for why a plain
              // `auth` read here would silently defeat this whole check: this
              // closure (and the syncNow invocation it belongs to) can still
              // be running well after the render that created it, and `auth`
              // itself stays frozen at whatever it was then.
              () => authRef.current.session?.user.id ?? null,
            );
            const appliedLocalId = await applySyncEntryResult(entry, result, idTracker);
            // STASH-69 investigation: recorded only once applySyncEntryResult
            // has actually FINISHED without throwing — a create can reach
            // 'synced' in `result` yet still end up durably marked 'failed'
            // below (e.g. rekeyBookmarkIdentity's repository writes failing
            // mid-function for a duplicate-adoption swap), and recording it
            // any earlier risked double-counting the same bookmark once here
            // and again on its eventual real retry (Codex review on #765).
            // Uses the returned id, not entry.local_id — applySyncEntryResult
            // returns `false` for a result it rejected/diverted entirely
            // (deleted mid-flight, landed under a departed identity), and a
            // duplicate-swap adopts a DIFFERENT id, to which any open failure
            // episode was already separately re-keyed (Codex review on #765).
            if (appliedLocalId && result.entry.sync_status === "synced") {
              noteSyncEntryStatus(appliedLocalId, "synced", entry.operation);
              captureSyncRecovery(entry);
            }
          } catch (error) {
            logStorageError("sync entry", error);
            syncFailed += 1;
            const failedAt = new Date().toISOString();
            const failed: LocalPendingBookmark = {
              ...entry,
              sync_status: "failed",
              retry_count: entry.retry_count + 1,
              last_error:
                error instanceof Error ? error.message : "Sync failed.",
              last_error_kind: syncErrorKind(error),
              last_attempt_at: failedAt,
              updated_at: failedAt,
            };
            // STASH-69 investigation: a thrown syncQueueEntry never produces
            // a `result`, so applySyncEntryResult's own note call never runs
            // for this entry — without this, a real 'failed' status durably
            // persisted just below would be entirely invisible to this
            // diagnostic (Codex review on #765). Uses idTracker.current, not
            // entry.local_id — if applySyncEntryResult threw AFTER already
            // re-keying onto a duplicate-swap's adopted id, that's the id any
            // open failure episode now actually lives under (Codex review on
            // #765, round 2).
            noteSyncEntryStatus(
              idTracker.current,
              "failed",
              entry.operation,
              failed.last_error_kind,
            );
            setQueue((current) =>
              current.map((queued) =>
                queued.local_id === entry.local_id ? failed : queued,
              ),
            );
            ensureRepositoryReady()
              .then(() => repository.updateQueueEntry(failed))
              .catch((persistError) =>
                logStorageError("sync entry fail-persist", persistError),
              );
          }
        }
        if (syncable.length > 0) {
          recordLog(
            syncFailed > 0 ? "warn" : "info",
            `sync: cycle done entries=${syncable.length} failed=${syncFailed}`,
          );
        }

        // Imported collection names are a separate durable outbox because a
        // bookmark must exist remotely before it can reference a cloud collection.
        const importCollectionsSynced = await syncPendingImportCollections(force, session, recoverAuth);
        if (importCollectionsSynced) {
          mutationsPushed = true;
        }

        // Same reasoning, same seam: a restored AI enrichment snapshot (#671)
        // needs its bookmark's remote id resolved first too.
        const enrichmentRestoresSynced = await syncPendingEnrichmentRestores(force, session, recoverAuth);
        if (enrichmentRestoresSynced) {
          mutationsPushed = true;
        }

        // Upload any queued local-first tag ops before pulling, so the pull's
        // server snapshot already reflects them.
        const tagsSynced = await syncTagOps(force, session, recoverAuth);
        if (tagsSynced) {
          mutationsPushed = true;
        }
        if (
          pendingTagOpsRef.current.some((op) =>
            !op.confirmed && createdIdsSyncedThisRun.has(op.bookmark_id),
          )
        ) {
          // A fast repository can finish create persistence before the synced
          // bookmark ref is visible to syncTagOps. Re-drive once after this run;
          // unlike an effect over every pending tag op, this cannot hot-loop a
          // genuine tag API failure.
          syncPendingRef.current = true;
        }

        // Pull phase: bring down remote changes (other devices, cloud AI
        // enrichment). Local rows with queued work are never overwritten.
        // Re-checked here (not just at entry) so pausing mid-run — after the
        // account reconciliation above but before this point — still skips it.
        const pullFailure = syncRunFailureRef.current;
        const pullReady = isPullReady(pullFailure?.userId === session.user.id ? pullFailure : null, Date.now(), force || (recoverAuth && pullFailure?.kind === "auth"));
        if (!syncPausedRef.current && pullReady) {
          try {
            const getQueuedWorkIds = () => new Set([
              ...deletedIds.current,
              ...queueRef.current.filter((entry) => entry.sync_status !== "synced")
                .map((entry) => entry.local_id),
            ]);
            const result = await pullRemoteChanges(
              api,
              repository,
              () => bookmarksRef.current ?? [],
              (bookmarkId) =>
                deletedIds.current.has(bookmarkId) ||
                queueRef.current.some(
                  (queued) =>
                    queued.local_id === bookmarkId &&
                    queued.sync_status !== "synced",
                ),
              currentUser,
              () => !syncPausedRef.current,
              getQueuedWorkIds,
            );
            if (authRef.current.userId === currentUser.id) {
              setLoadedAccountUserId?.(currentUser.id);
              setAccountLibraryFailureUserId?.(null);
            }
            // STASH-7A: the pull's storage awaits can span a local batch move.
            // Recheck the outbox at publication time so an older snapshot never
            // rolls back the optimistic edit while its upload is still pending.
            const queuedWorkIds = getQueuedWorkIds();
            const upserts = result.upserts.filter((row) => !queuedWorkIds.has(row.id));
            const deletions = result.deletions.filter((id) => !queuedWorkIds.has(id));
            if (upserts.length > 0 || deletions.length > 0) {
              const upsertIds = new Set(
                upserts.map((bookmark) => bookmark.id),
              );
              const removed = new Set(deletions);
              if (bookmarksRef.current) {
                bookmarksRef.current = [
                  ...bookmarksRef.current.filter(
                    (bookmark) =>
                      !upsertIds.has(bookmark.id) && !removed.has(bookmark.id),
                  ),
                  ...upserts,
                ];
              }
              setBookmarks((current) => [
                ...(current ?? []).filter(
                  (bookmark) =>
                    !upsertIds.has(bookmark.id) && !removed.has(bookmark.id),
                ),
                ...upserts,
              ]);
            }
            // STASH-4P: enrichments this device never itself requested (the
            // background overflow worker's output, or another device's) used to
            // skip auto_accept entirely — only the direct-dispatch path
            // (requestAiEnrichment's own settle handler, above) applied it.
            // Collected below (when non-empty) and applied once the pull's
            // tagData merge further down has landed, rather than inline:
            // applying it mid-loop would race acceptSuggestedTags's
            // fire-and-forget syncTagOps against this same pull's own "re-layer
            // pending tag ops over the fresh server snapshot" step, and could
            // lose the just-applied tag if the upload happens to finish first.
            const workerAutoAcceptTargets: AIEnrichment[] = [];
            if (result.enrichments.length > 0) {
              // Flag enrichments that arrived unwitnessed (a server-side trigger's
              // result, or another device's) for the Inbox banner. Flag a row when
              // it's brand new OR a genuine update — the edge function upserts on
              // `bookmark_id` and keeps the same enrichment id, so a re-enrichment
              // from another device reuses the id; gating on id novelty alone would
              // miss those changed suggestions. Compare `updated_at` so a true update
              // flags while the pull's watermark-overlap re-fetch of an *unchanged*
              // row (same timestamp) doesn't re-surface a suggestion already seen.
              const knownById = new Map(
                enrichmentsRef.current.map(
                  (enrichment) => [enrichment.id, enrichment] as const,
                ),
              );
              let anyRetryCleared = false;
              const nextUnseenSuggestions = new Set(
                unseenSuggestionIdsRef.current,
              );
              let unseenSuggestionsChanged = false;
              // STASH #578 Phase 2: extend the burst-completion toast (STASH #574
              // Phase 1, `AI_ENRICHMENT_BURST_TOAST_MIN`) to also cover
              // enrichments this sync pull delivered that this device didn't
              // itself just dispatch — the background worker's (or another
              // device's) output. Count only rows genuinely new/updated to this
              // device (isNewOrNewer below) AND not currently attributed to this
              // device's own direct-dispatch loop (aiEnriching.current): a
              // direct dispatch's own successful response already lands in
              // enrichmentsRef with the SAME updated_at before this pull can ever
              // see it again (the watermark overlap re-fetches it, but isNewOrNewer
              // is then false), so this in-flight check only matters for the rare
              // race where a pull observes a row before this device's own
              // in-flight request settles — without it, that one row would get
              // double-counted (once here, once by the direct-dispatch settle
              // handler below).
              let workerDrivenCount = 0;
              for (const enrichment of result.enrichments) {
                const known = knownById.get(enrichment.id);
                const isNewOrNewer =
                  !known || enrichment.updated_at > known.updated_at;
                if (isNewOrNewer) {
                  unseenSuggestionsChanged =
                    addUnseenSuggestion(
                      enrichment,
                      nextUnseenSuggestions,
                    ) || unseenSuggestionsChanged;
                  if (!aiEnriching.current.has(enrichment.bookmark_id)) {
                    workerDrivenCount += 1;
                  }
                  if (aiSuggestionsModeRef.current === "auto_accept") {
                    workerAutoAcceptTargets.push(enrichment);
                  }
                }
                // This bookmark now has an enrichment row through some path other
                // than this device's own requestAiEnrichment call — a server-side
                // trigger, or another device's request, pulled down by normal
                // sync. Clear any armed retry marker so checkAiRetries doesn't
                // keep firing a redundant ai-enrich request for a bookmark that's
                // actually already enriched. Gate on the same new-or-newer check
                // as the unseen-suggestions flag above: the pull's watermark has a
                // ~5-minute overlap window and can re-return the same
                // already-known, unchanged row on a later pull. Without this
                // gate, that re-delivery would clear a retry marker that a
                // separate, later failed refresh attempt legitimately armed —
                // even though nothing new actually arrived.
                if (
                  isNewOrNewer &&
                  enrichment.bookmark_id in aiRetryState.current
                ) {
                  clearAiRetry(enrichment.bookmark_id);
                  anyRetryCleared = true;
                }
                // Parallel check for the confirmed-server-queued marker (see
                // AI_SERVER_QUEUED_KEY) — this is the PRIMARY way it's expected
                // to clear in practice: the background overflow worker's
                // delivered result lands right here via ordinary sync. Same
                // watermark-overlap gate as the retry-marker check above, and for
                // the same reason: a stale re-delivery of an already-known,
                // unchanged row must not be mistaken for a fresh arrival.
                if (
                  isNewOrNewer &&
                  aiServerQueued.current.has(enrichment.bookmark_id)
                ) {
                  clearAiServerQueued(enrichment.bookmark_id);
                }
              }
              if (unseenSuggestionsChanged) {
                applyUnseenSuggestions(nextUnseenSuggestions);
              }
              if (anyRetryCleared) {
                syncAiRetryIds();
              }
              // Second producer into the same consumer state as the direct-dispatch
              // drain loop's toast (below): same threshold, same shape, just a
              // different source of "N bookmarks summarized & tagged" completions.
              if (workerDrivenCount >= AI_ENRICHMENT_BURST_TOAST_MIN) {
                aiBurstTokenSeq.current += 1;
                setAiEnrichmentBurstToast({
                  count: workerDrivenCount,
                  token: aiBurstTokenSeq.current,
                });
              }
              setEnrichments((current) =>
                mergeById(
                  result.enrichments,
                  current,
                  (enrichment) => enrichment.id,
                ),
              );
            }
            // Re-layer any still-unsynced local tag ops over the fresh server
            // snapshot so optimistic tags aren't dropped by the wholesale replace.
            const remainingTagOps = retireConfirmedTagRemovals(
              pendingTagOpsRef.current, result.tagData, result.tagSnapshotReplaced,
            );
            if (remainingTagOps.length !== pendingTagOpsRef.current.length) {
              await applyTagOps(remainingTagOps);
            }
            const mergedTagData = applyPendingTagOps(
              result.tagData,
              pendingTagOpsRef.current,
              auth.userId ?? mockUserId,
            );
            tagDataRef.current = mergedTagData;
            setTagData(mergedTagData);
            setLastPulledAt(result.pulledAt);
            if (authRef.current.userId === auth.userId) setSyncRunFailure(null);
            // Applied only now that this pull's own tagData merge above has
            // landed (see the comment where these are collected) — in
            // auto_accept mode, a worker-driven (or another device's)
            // enrichment's suggestions get applied here just like a
            // direct-dispatch enrichment already does in requestAiEnrichment.
            for (const enrichment of workerAutoAcceptTargets) {
              try {
                await autoAcceptEnrichmentRef.current?.(
                  enrichment.bookmark_id,
                  enrichment,
                );
              } catch (error) {
                recordLog(
                  "warn",
                  `ai-enrich auto_accept (sync) failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          } catch (error) {
            if (error instanceof PullPausedError) {
              recordLog("info", "pull: stopped after sync was paused");
            } else {
              if (authRef.current.userId === auth.userId) {
                setSyncRunFailure((previous) => ({
                  userId: auth.userId, kind: syncErrorKind(error), at: Date.now(), attempts: (previous?.attempts ?? 0) + 1,
                }));
              }
              if (authRef.current.userId === currentUser.id) setAccountLibraryFailureUserId?.(currentUser.id);
              logStorageError("pull", error);
            }
          }
        }

        // Best-effort per-sync stamp for the admin dashboard (GH #687):
        // records app_version + last_synced_at once a full pass (upload +
        // pull) actually completes — never on an early return above (no
        // session, paused, already in flight, account-transition not ready).
        // Fire-and-forget: trackSyncStatus never throws, but constructing the
        // client here can (e.g. missing Supabase config), so this is wrapped
        // too — a failed stamp is simply retried on the next successful pass
        // and must never surface as a "sync run" failure for the pass that
        // actually just succeeded.
        try {
          if (pullReady && !syncPausedRef.current) void trackSyncStatus({
            client: createSupabaseClient(),
            session,
            runtime: {
              appVersion: Constants.expoConfig?.version,
              platform: Platform.OS,
            },
            now: new Date().toISOString(),
          });
        } catch (error) {
          recordLog(
            "warn",
            `sync status stamp failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } catch (error) {
        if (authRef.current.userId === auth.userId) {
          setSyncRunFailure((previous) => ({
            userId: auth.userId, kind: syncErrorKind(error), at: Date.now(), attempts: (previous?.attempts ?? 0) + 1,
          }));
        }
        if (authRef.current.userId === auth.userId) setAccountLibraryFailureUserId?.(auth.userId);
        logStorageError("sync run", error);
      } finally {
        syncInFlight.current = false;
        setIsSyncing(false);
        if (syncPendingRef.current) {
          syncPendingRef.current = false;
          const pendingForce = syncPendingForceRef.current;
          syncPendingForceRef.current = false;
          setTimeout(() => {
            void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
          }, 50);
        }
      }
      if (mutationsPushed) {
        broadcastSyncNudgeRef.current?.();
        checkAiRetriesRef.current?.();
      }
      return mutationsPushed;
    },
    [
      auth,
      enqueueMutation,
      requestAiEnrichment,
      syncTagOps,
      syncPendingImportCollections,
      syncPendingEnrichmentRestores,
      addUnseenSuggestion,
      applyUnseenSuggestions,
      reconcileAccountTransition,
    ],
  );
  return { syncNow };
}
