import { AI_RETRY_BACKOFF_MS, EMPTY_TAGS, EMPTY_TAG_DATA, ENRICHMENT_FETCH_CONCURRENCY, METADATA_SYNC_DEBOUNCE_MS, PENDING_TAG_OPS_KEY, SYNC_PAUSED_KEY, UNSEEN_SUGGESTIONS_KEY } from '@/store/bookmarks/constants';
import { isActiveBookmark, isBookmarkSyncedOnce, logStorageError, makeBookmarkId, parseTagOps, tagRetryReadyAt } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import { type AiRetryState, type BookmarksContextValue } from '@/store/bookmarks/types';
import { useAddBookmark } from '@/store/bookmarks/use-add-bookmark';
import { useAiEnrichmentRequest } from '@/store/bookmarks/use-ai-enrichment-request';
import { useAiRetryBookkeeping } from '@/store/bookmarks/use-ai-retry-bookkeeping';
import { useAiRetryLifecycle } from '@/store/bookmarks/use-ai-retry-lifecycle';
import { useBookmarkEdits } from '@/store/bookmarks/use-bookmark-edits';
import { useCollectionCommands } from '@/store/bookmarks/use-collection-commands';
import { useDeleteCommands } from '@/store/bookmarks/use-delete-commands';
import { useImportBookmarks } from '@/store/bookmarks/use-import-bookmarks';
import { useImportOutboxSync } from '@/store/bookmarks/use-import-outbox-sync';
import { useLibraryHydration } from '@/store/bookmarks/use-library-hydration';
import { useResetLibrary } from '@/store/bookmarks/use-reset-library';
import { useSyncCoordinator } from '@/store/bookmarks/use-sync-coordinator';
import { useTagCommands } from '@/store/bookmarks/use-tag-commands';
import { useTagSync } from '@/store/bookmarks/use-tag-sync';
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
export { AI_RATE_LIMITED } from '@/store/bookmarks/constants';
export { isBookmarkSyncedOnce } from '@/store/bookmarks/helpers';
export { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
export { type AddBookmarkResult, type ImportSummary, type ResetLibraryResult } from '@/store/bookmarks/types';


import type {
  EnrichmentMetadataHint
} from "@/api/bookmarks";
import {
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  clearBurstCompletion,
  enqueueAiEnrichmentDispatch,
  type AiEnrichmentBurstQueue
} from "@/domain/ai-enrichment-burst";
import {
  pendingSuggestedFolder,
  pendingSuggestions,
  pendingSummary,
  suggestedFolderTokens
} from "@/domain/ai-suggestions";
import {
  AI_SUGGESTIONS_MODE_PREF_KEY,
  DEFAULT_AI_SUGGESTIONS_MODE,
  serializeAiSuggestionsMode,
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import { resolveAliasedId } from "@/domain/bookmark-id-swap";
import { buildBookmarkProcessingSnapshot } from "@/domain/bookmark-processing";
import { createConcurrencyLimiter } from "@/domain/concurrency";
import { enrichBookmark } from "@/domain/enrichment";
import { buildLibrarySyncFlow } from "@/domain/library-sync-status";
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  dropPendingEnrichmentRestores,
  parsePendingEnrichmentRestores,
  rekeyPendingEnrichmentRestores,
  type PendingEnrichmentRestore
} from "@/domain/pending-enrichment-restore";
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  dropPendingImportCollections,
  parsePendingImportCollections,
  rekeyPendingImportCollections,
  type PendingImportCollection
} from "@/domain/pending-import-collections";
import {
  carryOverTagOps,
  dropPendingTagOpsForBookmarks,
  rekeyPendingTagOps,
  type PendingTagOp
} from "@/domain/pending-tags";
import {
  buildProcessingStats,
  type AiServerQueueSnapshot
} from "@/domain/processing-status";
import { sameRecordSnapshot } from "@/domain/record-snapshot";
import { acceptSuggestionBundle } from "@/domain/suggestion-actions";
import { changedSyncFields, mergeSyncChanges } from "@/domain/sync-changes";
import type { TitleBackfillPatch } from "@/domain/title-backfill";
import { planTitleBackfill } from "@/domain/title-backfill";
import type {
  AIEnrichment,
  Bookmark, LocalPendingBookmark, SuggestedTag, SyncChangeSource, Tag
} from "@/domain/types";
import { makeUuid } from "@/domain/uuid";
import { useI18n } from "@/i18n";
import { recordLog } from "@/observability/log-buffer";
import { armLoopStallWatchdog } from "@/observability/loop-stall-watchdog";
import {
  describeRecentSegments,
  recordSlowSegment,
} from "@/observability/slow-segment-log";
import { repository } from "@/storage/repository";
import { registerForForegroundState } from "@/storage/sqlite-app-lifecycle";
import type {
  IdentityRekeyState,
  TagData
} from "@/storage/types";
import { useSupabaseAuth } from "@/supabase/auth-provider";
import { useRealtimeSync } from "@/supabase/realtime";
import type { SupabaseAuthSession } from "@/supabase/types";
import {
  applyAccountTransition,
  planAccountTransition,
  planLogoutCacheClear,
  CACHE_OWNER_KEY,
  readCacheOwner,
  writeCacheOwner,
} from "@/sync/account-transition";
import { canAutomaticallyRetry, nextAutomaticSyncRetryAt } from "@/sync/automatic-retry";
import {
  LAST_PULLED_AT_KEY,
  SYNCED_USER_ANON_KEY,
  SYNCED_USER_ID_KEY
} from "@/sync/pull-bookmarks";
import {
  UPLOAD_RETRY_BACKOFF_MS,
  hasRemoteIdentity,
  isLocalOnlyBookmark,
  isPermanentlyUnsyncableUrl,
  isSyncable,
  makeMutationEntry,
  syncErrorKind,
  uploadRetryBackoffMs
} from "@/sync/sync-bookmarks";
import {
  remapSyncStatusIdentity
} from "@/sync/sync-status-diagnostics";
import { useNetworkOffline } from "@/ui/use-network-offline";

const BookmarksContext = createContext<BookmarksContextValue | null>(null);

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const auth = useSupabaseAuth();
  const [reconciledCacheUserId, setReconciledCacheUserIdState] = useState<string | null>(null);
  const reconciledCacheUserIdRef = useRef<string | null>(null);
  const setReconciledCacheUserId = useCallback((userId: string | null) => {
    reconciledCacheUserIdRef.current = userId;
    setReconciledCacheUserIdState(userId);
  }, []);
  const [accountLibraryFailureUserId, setAccountLibraryFailureUserId] = useState<string | null>(null);
  const [loadedAccountUserId, setLoadedAccountUserId] = useState<string | null>(null);
  const [accountTransfer, setAccountTransfer] = useState<{ userId: string; count: number } | null>(null);
  const dismissAccountTransfer = useCallback(() => setAccountTransfer(null), []);
  useEffect(() => {
    // A direct A → B → A switch must not reuse A's previous successful pull.
    setAccountTransfer(null);
    setLoadedAccountUserId(null);
    setAccountLibraryFailureUserId(null);
  }, [auth.userId]);
  const hideAccountCache = auth.status === "loading" || auth.status === "error" ||
    auth.status === "session_expired" ||
    ((auth.status === "authenticated" || auth.status === "anonymous") &&
      auth.userId !== reconciledCacheUserId);
  // Mirror of `auth` so an ALREADY-RUNNING async closure (syncNow and
  // everything it calls, e.g. syncQueueEntry's injected getLiveUserId) can
  // read the LATEST signed-in identity instead of the one captured when
  // that invocation started. `syncNow` is a useCallback keyed on `auth`
  // (among other deps) — React gives a brand NEW `syncNow` (closing over a
  // fresh `auth`) on the render after sign-out, but an invocation of the
  // OLD `syncNow` that's still executing keeps referencing whatever `auth`
  // its own closure captured at creation time; it never sees the new one.
  // Reading `authRef.current` instead — the same "ref mirrors state so an
  // async loop reads live, not stale" pattern bookmarksRef/queueRef already
  // use — closes that gap: the ref's `.current` is looked up fresh on every
  // access, regardless of which render's closure is doing the looking up.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const broadcastSyncNudgeRef = useRef<(() => void) | null>(null);
  const syncPendingRef = useRef(false);
  const syncPendingForceRef = useRef(false);
  const syncNowRef = useRef<((options?: { force?: boolean }) => Promise<boolean>) | null>(null);
  const checkAiRetriesRef = useRef<(() => void) | null>(null);
  const localCreateFlushesInFlight = useRef(0);
  const pendingUserTitleEdits = useRef(new Set<string>());
  // Generated source titles can also improve while a create request is in
  // flight. Track that divergence separately so post-create reconciliation
  // pushes the fetched title instead of leaving the cloud on the stale sender
  // title (STASH-6C review).
  const pendingGeneratedTitleUpdates = useRef(new Set<string>());
  // A bulk-create chunk's reconcile follow-up (deletedMidFlightIds/
  // followUpUpdates in applyBulkCreateChunkResults) removes the chunk's
  // completed 'create' entries from the queue before its own sequential
  // writes finish and re-add their replacement 'update'/'delete' entries —
  // those writes now genuinely await real SQLite calls, so that gap can
  // outlast the AI-dispatch interval's 400ms tick. Without this flag, that
  // interval would see a queue with nothing pending/syncing and wrongly
  // conclude sync had settled, firing AI requests during the exact SQLite
  // stall this file's STASH-3Y fix is meant to relieve (caught in PR
  // review).
  const bulkReconcileInFlight = useRef(0);
  // See SYNC_PAUSED_KEY above. The ref is read inside syncNow (the hot path);
  // the state exists only so Settings can display/toggle the current choice.
  const syncPausedRef = useRef(false);
  const [syncPaused, setSyncPausedState] = useState(false);
  // The active language, sent with AI enrichment requests so the model answers
  // in the user's locale (M12). Read through a ref so requestAiEnrichment stays
  // stable as the locale changes — it just picks up the latest value when fired.
  const { locale } = useI18n();
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
  const [queue, setQueue] = useState<LocalPendingBookmark[]>([]);
  const [enrichments, setEnrichments] = useState<AIEnrichment[]>([]);
  const [tagData, setTagData] = useState<TagData>(EMPTY_TAG_DATA);
  // Local-first tag add/remove operations awaiting upload. The displayed
  // tagData is the server snapshot with these layered on top.
  const [pendingTagOps, setPendingTagOps] = useState<PendingTagOp[]>([]);
  const pendingTagOpsRef = useRef<PendingTagOp[]>([]);
  const tagSyncInFlight = useRef(false);
  const tagSyncPending = useRef(false);
  const tagSyncPendingForce = useRef(false);
  const tagSyncPendingRecovery = useRef<SupabaseAuthSession | null>(null);
  const tagOpsWriteRef = useRef(Promise.resolve(true));
  const tagWorkPending = useRef(0);
  const pendingTagHealthReportsRef = useRef(new Map<string, PendingTagOp>());
  const tagJournalRetryAtRef = useRef(0);
  const tagJournalHealthyRef = useRef(true);
  const [tagJournalRetryAt, setTagJournalRetryAt] = useState(0);
  const [pendingImportCollections, setPendingImportCollections] = useState<
    PendingImportCollection[]
  >([]);
  const pendingImportCollectionsRef = useRef<PendingImportCollection[]>([]);
  // Durable outbox for restoring a Stash JSON backup's AI enrichment snapshot
  // (#671) — same shape/lifecycle as pendingImportCollections above.
  const [pendingEnrichmentRestores, setPendingEnrichmentRestores] = useState<
    PendingEnrichmentRestore[]
  >([]);
  const pendingEnrichmentRestoresRef = useRef<PendingEnrichmentRestore[]>([]);
  // Bookmark ids whose AI suggestions arrived unwitnessed (drives the Inbox
  // banner). The ref mirrors state so the arrival paths (auto enrichment, pull)
  // can read-modify-write synchronously across back-to-back updates.
  const [unseenSuggestionIds, setUnseenSuggestionIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const unseenSuggestionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null);
  const syncCredentialsRef = useRef(auth.session ? { userId: auth.session.user.id, accessToken: auth.session.access_token } : null);
  const observedCredentialsRef = useRef(syncCredentialsRef.current);
  const credentialsWereUsedRef = useRef(false);
  const observedRecoveryVersionRef = useRef(0);
  const authRecoveryPendingRef = useRef(false);
  useEffect(() => {
    if (["signed_out", "session_expired", "error"].includes(auth.status)) {
      authRecoveryPendingRef.current = true;
    } else if (auth.session && (auth.status === "authenticated" || auth.status === "anonymous")) {
      const observed = observedCredentialsRef.current;
      const used = syncCredentialsRef.current;
      const recoveryVersion = auth.credentialRecoveryVersion ?? 0;
      const serverRefreshed = recoveryVersion > observedRecoveryVersionRef.current;
      observedRecoveryVersionRef.current = recoveryVersion;
      const changed = !!observed && (observed.userId !== auth.session.user.id || observed.accessToken !== auth.session.access_token);
      // The provider can lag the session returned by ensureAnonymousSession.
      // Observe provider changes once; never compare a stale render against a
      // newer already-used bearer and repeatedly schedule recovery passes.
      if ((changed || serverRefreshed) && (!credentialsWereUsedRef.current || !used || used.userId !== auth.session.user.id || used.accessToken !== auth.session.access_token)) authRecoveryPendingRef.current = true;
      observedCredentialsRef.current = { userId: auth.session.user.id, accessToken: auth.session.access_token };
    }
  }, [auth.status, auth.session, auth.credentialRecoveryVersion]);
  const legacyFollowupAttemptAt = useRef(Date.now());
  const offline = useNetworkOffline();
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const [syncRunFailure, setSyncRunFailure] = useState<{
    kind: ReturnType<typeof syncErrorKind>; at: number; attempts: number; userId: string | null;
  } | null>(null);
  const syncRunFailureRef = useRef(syncRunFailure);
  syncRunFailureRef.current = syncRunFailure;
  useEffect(() => { setSyncRunFailure(null); }, [auth.userId]);
  const [isSyncingState, setIsSyncing] = useState(false);
  const [isSyncDebounceActive, setIsSyncDebounceActive] = useState(false);
  const isSyncing = isSyncingState || isSyncDebounceActive;
  const librarySyncFlow = useMemo(() => buildLibrarySyncFlow({
    authStatus: auth.status, offline, paused: syncPaused, syncing: isSyncing,
    queue, permanentlyUnsyncableIds: new Set(queue.filter(isPermanentlyUnsyncableUrl).map((entry) => entry.local_id)),
    blockedDependentBookmarkIds: new Set(queue.filter(isPermanentlyUnsyncableUrl).filter((entry) => !bookmarks?.some((bookmark) => bookmark.id === entry.local_id && isBookmarkSyncedOnce(bookmark))).map((entry) => entry.local_id)),
    tagOps: pendingTagOps, importCollections: pendingImportCollections,
    enrichmentRestores: pendingEnrichmentRestores, runFailure: syncRunFailure,
  }), [auth.status, offline, syncPaused, isSyncing, queue, bookmarks, pendingTagOps,
    pendingImportCollections, pendingEnrichmentRestores, syncRunFailure]);
  const librarySyncFlowRef = useRef(librarySyncFlow);
  librarySyncFlowRef.current = librarySyncFlow;
  const [isResettingLibrary, setIsResettingLibrary] = useState(false);
  const libraryResetInFlightRef = useRef(false);
  const [loadError, setLoadError] = useState(false);
  const syncInFlight = useRef(false);
  // The user id the pull effect last fired for. A sign-in (anonymous → real)
  // or account switch changes this, re-triggering a pull; null until the first
  // session is established.
  const lastSyncedUserId = useRef<string | null>(null);
  const wasAnonymousRef = useRef<boolean | null>(null);
  // Guards the logout cache-clear effect so it runs exactly once per logout
  // (the `signed_out` status persists until the next session is established).
  const loggedOutCleared = useRef(false);
  // Bookmark IDs currently being enriched, so concurrent passes (startup +
  // a fresh save) never double-process the same item.
  const enriching = useRef(new Set<string>());
  // Caps how many enrichment fetches run at once (Sentry STASH-3B): a 500+
  // bookmark import — or the startup backfill re-firing those still-pending
  // rows after a relaunch — used to launch one fetch per bookmark
  // simultaneously, and the native resource exhaustion SIGABRT-crashed the app.
  const enrichmentSlots = useRef(
    createConcurrencyLimiter(ENRICHMENT_FETCH_CONCURRENCY),
  );
  // Bookmark IDs with an AI enrichment request in flight, so an auto-trigger
  // and a manual "Suggest with AI" tap never fire duplicate requests.
  const aiEnriching = useRef(new Set<string>());
  // Freshly created bookmarks awaiting their first auto AI enrichment. We hold
  // them here until metadata enrichment settles (see the effect below) so the
  // model never reasons about a bare, not-yet-enriched URL. Mirrored durably in
  // meta (PENDING_AI_TRIGGER_KEY) so the trigger survives an app kill during the
  // metadata-fetch window. Cleared only once enrichment succeeds.
  const pendingAiTrigger = useRef(new Set<string>());
  const pendingAiPreviewRefresh = useRef(new Set<string>());
  // Ids already attempted this session, so the effect doesn't re-fire on every
  // render while a marker lingers (e.g. after a failed request). In-memory on
  // purpose: a fresh launch retries a marker that never succeeded.
  const aiTriggerAttempted = useRef(new Set<string>());
  // Durable per-bookmark AI-enrichment retry bookkeeping (see AiRetryState):
  // the ref is the source of truth read by the backoff checks; `aiRetryIds` is
  // a reactive mirror of its keys, refreshed only once a `requestAiEnrichment`
  // call fully settles (in its `finally`, alongside the isEnriching flip) so
  // `hadPriorEnrichmentAttempt`/`isAiSuggestionPostponed` never observe an
  // in-between frame where the bookkeeping changed but isEnriching hasn't yet.
  const aiRetryState = useRef<Record<string, AiRetryState>>({});
  const [aiRetryIds, setAiRetryIds] = useState<ReadonlySet<string>>(new Set());
  // Durable per-bookmark "confirmed server-queued" marker (see
  // AI_SERVER_QUEUED_KEY): the ref is the source of truth, `aiServerQueuedIds`
  // a reactive mirror — but unlike aiRetryState/aiRetryIds above, the mirror
  // is refreshed immediately inside markAiServerQueued/clearAiServerQueued
  // rather than deferred to a caller's settle handler, since this marker is
  // presence-only (no per-id record to keep in lockstep with an isEnriching
  // flip) and is set/cleared from places with no equivalent "same frame" flip
  // to align with.
  const aiServerQueued = useRef<Set<string>>(new Set());
  const [aiServerQueuedIds, setAiServerQueuedIds] = useState<
    ReadonlySet<string>
  >(new Set());
  // Account-wide server overflow work, including rows created by another
  // device or by a server trigger. `null` means this account has not been
  // fetched yet; local confirmed IDs remain available as the offline floor.
  const [aiServerQueueSnapshot, setAiServerQueueSnapshot] = useState<
    readonly AiServerQueueSnapshot[] | null
  >(null);
  // Reactive mirror of `aiEnriching` so the UI can show an ambient "filling in"
  // placeholder while a request (auto-triggered or manual) is in flight.
  const [enrichingIds, setEnrichingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Subset of `enrichingIds` started by an explicit user action, so the UI can
  // give direct button feedback for a manual tap while keeping the auto-trigger
  // silent (it should just fill suggestions in, not look like a blocking wait).
  const [manualEnrichingIds, setManualEnrichingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  const [previewRefreshingIds, setPreviewRefreshingIds] = useState<
    ReadonlySet<string>
  >(new Set());
  // Tombstones for deleted local bookmarks. The sync loop iterates over a
  // snapshot, so a delete that lands mid-run must be visible to it — both
  // before uploading an entry and before applying an upload's result.
  const deletedIds = useRef(new Set<string>());
  // Maps a bookmark's *former* id to the id it was re-keyed onto. A freshly
  // captured row adopts its remote id when its create syncs, and an
  // anonymous→real re-home swaps it for a new local id — both change the id out
  // from under any holder of the old one. The reported case: open a just-shared
  // bookmark's Detail (navigated with the local id), then its create syncs
  // moments later and `getBookmark(localId)` would read "not found". Following
  // this alias keeps the screen pointed at the live row across the swap.
  const idAliases = useRef(new Map<string, string>());
  // Mirror of the bookmarks state so async loops can read the LATEST rows
  // instead of the stale closure captured when they started.
  const bookmarksRef = useRef<Bookmark[] | null>(null);
  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);
  // Guards checkVideoAvailability against firing twice for the same bookmark
  // while its first check is still in flight (e.g. a rapid remount).
  const videoAvailabilityCheckingRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<LocalPendingBookmark[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  const tagDataRef = useRef<TagData>(EMPTY_TAG_DATA);
  useEffect(() => {
    tagDataRef.current = tagData;
  }, [tagData]);
  // Mirror of the enrichments state so the edit path can read the LATEST rows
  // synchronously when deciding whether to mark suggestions stale.
  const enrichmentsRef = useRef<AIEnrichment[]>([]);
  useEffect(() => {
    enrichmentsRef.current = enrichments;
  }, [enrichments]);
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);
  const requestAiEnrichmentRef = useRef<
    | ((
      bookmarkId: string,
      source?: "auto" | "manual" | "preview",
      overrideMetadata?: EnrichmentMetadataHint,
    ) => Promise<string | null>)
    | null
  >(null);
  // Set once `autoAcceptEnrichment` is defined below (it needs
  // acceptSuggestedTags/assignCollection/createCollection, all declared after
  // requestAiEnrichment) — mirrors the requestAiEnrichmentRef pattern just
  // above for the same forward-reference reason.
  const autoAcceptEnrichmentRef = useRef<
    ((bookmarkId: string, enrichment: AIEnrichment) => Promise<void>) | null
  >(null);
  // The user's AI-suggestions mode (STASH #573): gates the three automatic
  // enrichment-trigger call sites (never the manual "Suggest with AI" tap) and
  // drives auto_accept below. The ref is the source of truth read inside
  // callbacks/effects so a live Settings change takes effect immediately
  // without needing every effect to depend on the reactive value; `aiSuggestionsMode`
  // state exists only so Settings can display the current choice.
  const aiSuggestionsModeRef = useRef<AiSuggestionsMode>(
    DEFAULT_AI_SUGGESTIONS_MODE,
  );
  const [aiSuggestionsMode, setAiSuggestionsModeState] =
    useState<AiSuggestionsMode>(DEFAULT_AI_SUGGESTIONS_MODE);
  // Staggered dispatch queue for automatic AI-enrichment triggers (STASH #574
  // Phase 1) — see `domain/ai-enrichment-burst.ts`. Only the two background
  // "trigger for a batch of ids" call sites route through this; the single-
  // bookmark preview-refresh follow-up trigger fires immediately as before,
  // since it's a direct continuation of a user-initiated action, not a burst.
  const aiDispatchQueueRef = useRef<AiEnrichmentBurstQueue>(
    EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  );
  const aiDispatchInFlight = useRef(false);
  // Bumped only at an account boundary (real-account switch, sign-out cache
  // clear) — NOT by emptyTrash, which also drops ids but must never abort an
  // unrelated in-flight dispatch for a different, still-active bookmark. The
  // drain loop below snapshots this at dispatch start and discards the
  // settle's burst-queue update/toast if it moved meanwhile: otherwise a
  // dispatch account A started can still settle after a switch to B and
  // count toward B's burst total (#691, found in STASH-4Y review).
  const aiDispatchEpoch = useRef(0);
  // STASH-4K follow-up: epoch ms until which the auto drain below pauses
  // dispatching entirely, armed whenever a 429 reveals the per-user quota is
  // exhausted (see AI_QUOTA_DAILY_COOLDOWN_MS). 0 means no cooldown.
  const aiQuotaCooldownUntil = useRef(0);
  // Bumped by resetLibrary once the remote wipe succeeds. requestAiEnrichment
  // snapshots it at entry and discards its settle paths (enrichment write /
  // retry arming / server-queued confirmation) if the epoch moved meanwhile —
  // otherwise an in-flight AI request racing a library reset would resurrect
  // enrichment rows or arm retry bookkeeping for bookmarks the reset just
  // deleted (PR #604 review).
  const resetEpoch = useRef(0);
  // Reactive signal for the "N bookmarks summarized & tagged" completion toast.
  // `token` is a monotonic counter (not just `count`) so two consecutive bursts
  // with the same count still re-fire the toast-showing effect — a same-value
  // update alone is a React no-op for an effect keyed on it (see the graph-view
  // snap-back trap in AGENTS.md's Known Traps).
  const [aiEnrichmentBurstToast, setAiEnrichmentBurstToast] = useState<{
    count: number;
    token: number;
  } | null>(null);
  const aiBurstTokenSeq = useRef(0);

  // Reactive mirror of a 429's reason + accurate reset time, for display only
  // (Settings backlog row, feedback diagnostics) — separate from
  // `aiQuotaCooldownUntil` above, which stays capped at its own fixed 10/30min
  // ceiling for the drain loop's internal gating and would understate a real
  // daily-limit wait if reused for display. Cleared once `retryAt` passes (see
  // the drain-loop interval below) or on account switch.
  const [aiQuotaExceeded, setAiQuotaExceeded] = useState<{
    reason: string;
    retryAt: number;
  } | null>(null);

  // Pause or resume sync. Turning it on makes syncNow no-op (see the guard
  // inside it) so queued work sits still — long enough to delete unwanted
  // rows locally before they ever reach the network (a local-only delete
  // never enqueues a network call; see deleteBookmark). Turning it off
  // immediately flushes whatever is queued rather than waiting for the next
  // trigger.
  const setSyncPaused = useCallback((paused: boolean) => {
    syncPausedRef.current = paused;
    setSyncPausedState(paused);
    ensureRepositoryReady()
      .then(() =>
        repository.setMeta(SYNC_PAUSED_KEY, paused ? "true" : "false"),
      )
      .catch((error) => logStorageError("sync paused pref", error));
    if (!paused) {
      // Consume any "pending" signal a blocked attempt left while paused —
      // the direct call below already satisfies it. Left alone, the run's
      // own finally block would still see it set and schedule a redundant
      // extra sync 50ms later (Sentry STASH-3K review).
      syncPendingRef.current = false;
      const pendingForce = syncPendingForceRef.current;
      syncPendingForceRef.current = false;
      void syncNowRef.current?.({ force: pendingForce }).catch(() => { });
    }
  }, []);

  // Change + durably persist the AI-suggestions mode. The ref updates
  // synchronously so the very next auto-trigger check (even one already
  // mid-flight in the same tick) observes the new mode.
  const setAiSuggestionsMode = useCallback((mode: AiSuggestionsMode) => {
    aiSuggestionsModeRef.current = mode;
    setAiSuggestionsModeState(mode);
    ensureRepositoryReady()
      .then(() =>
        repository.setMeta(
          AI_SUGGESTIONS_MODE_PREF_KEY,
          serializeAiSuggestionsMode(mode),
        ),
      )
      .catch((error) => logStorageError("ai suggestions mode", error));
  }, []);

  // STASH #574 Phase 1: dismiss the "N bookmarks summarized & tagged" toast
  // signal once it's been shown.
  const dismissAiEnrichmentBurstToast = useCallback(() => {
    setAiEnrichmentBurstToast(null);
  }, []);

  // Apply + persist a new tag-data snapshot in one step. The ref is updated
  // synchronously so a follow-up tag op in the same tick reads the latest.
  // `persist: false` updates the in-memory ref/state only, skipping the
  // SQLite write — see applyTagOps below for why (same syncTagOps hot loop).
  const applyTagData = useCallback(
    (next: TagData, options?: { persist?: boolean }) => {
      tagDataRef.current = next;
      setTagData(next);
      if (options?.persist === false) {
        return;
      }
      ensureRepositoryReady()
        .then(() => repository.replaceTagData(next))
        .catch((error) => logStorageError("tag data", error));
    },
    [],
  );

  const serializeTagWork = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    tagWorkPending.current += 1;
    const run = tagOpsWriteRef.current.then(work).finally(() => {
      tagWorkPending.current -= 1;
    });
    tagOpsWriteRef.current = run.then((result) => result !== false, () => false);
    return run;
  }, []);

  // Persist the local-first tag-op queue (ref updated synchronously).
  // `persist: false` updates the in-memory ref/state only, skipping the
  // SQLite write — used by syncTagOps' per-op loop so a bulk import's ~300
  // sequential tag uploads don't each re-serialize and persist the whole
  // (shrinking) array, which was contending with the main sync queue's own
  // writes (Sentry: bli9833 import backlog, sqlite tail-wait depth 22).
  const applyTagOps = useCallback(
    (next: PendingTagOp[], options?: { persist?: boolean }): Promise<boolean> => {
      pendingTagOpsRef.current = next;
      setPendingTagOps(next);
      if (options?.persist === false) {
        return Promise.resolve(true);
      }
      // Serialize journal writes so an older snapshot can never land last.
      return serializeTagWork(async () => {
        try {
          await ensureRepositoryReady();
          await repository.setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(pendingTagOpsRef.current));
          tagJournalHealthyRef.current = true;
          tagJournalRetryAtRef.current = 0;
          setTagJournalRetryAt(0);
          return true;
        } catch (error) {
          logStorageError("tag ops", error);
          tagJournalHealthyRef.current = false;
          const retryAt = Date.now() + UPLOAD_RETRY_BACKOFF_MS[0]!;
          tagJournalRetryAtRef.current = retryAt;
          setTagJournalRetryAt(retryAt);
          return false;
        }
      });
    },
    [serializeTagWork],
  );

  const applyPendingImportCollections = useCallback(
    (next: PendingImportCollection[]) => {
      pendingImportCollectionsRef.current = next;
      setPendingImportCollections(next);
      ensureRepositoryReady()
        .then(() =>
          repository.setMeta(
            PENDING_IMPORT_COLLECTIONS_KEY,
            JSON.stringify(next),
          ),
        )
        .catch((error) => logStorageError("import collection ops", error));
    },
    [],
  );

  const applyPendingEnrichmentRestores = useCallback(
    (next: PendingEnrichmentRestore[]) => {
      pendingEnrichmentRestoresRef.current = next;
      setPendingEnrichmentRestores(next);
      ensureRepositoryReady()
        .then(() =>
          repository.setMeta(
            PENDING_ENRICHMENT_RESTORE_KEY,
            JSON.stringify(next),
          ),
        )
        .catch((error) => logStorageError("enrichment restore ops", error));
    },
    [],
  );

  // True once a bookmark's create has been confirmed synced at least once —
  // even if it currently reads `sync_status: 'pending'` again because of a
  // later, still-uploading edit (see Bookmark.ever_synced). The gate every
  // write path needs before it's safe to also send a remote update/delete/tag
  // mutation for a bookmark.
  const hasSyncedOnce = useCallback((bookmarkId: string): boolean => {
    const bookmark = bookmarksRef.current?.find((b) => b.id === bookmarkId);
    if (!bookmark) {
      return false;
    }
    // Seed/sample rows are marked sync_status: 'synced' locally too (so the
    // orphan self-heal never tries to upload them), even though their
    // bookmark-* id was never a real cloud row. hasRemoteIdentity excludes
    // those; every genuine bookmark (old-scheme or new) has a real UUID id
    // regardless of sync state, so this never excludes a legitimately synced one.
    return isBookmarkSyncedOnce(bookmark);
  }, []);

  // Queue a remote mutation for a bookmark that already exists on the server.
  // One entry per bookmark: a newer mutation supersedes an older one.
  const enqueueMutation = useCallback(
    (bookmarkId: string, operation: "update" | "delete", source: SyncChangeSource = operation === "delete" ? "delete" : "sync_reconcile", fields: string[] = []) => {
      const previous = queueRef.current.find((item) => item.local_id === bookmarkId);
      const entry = makeMutationEntry(bookmarkId, operation);
      entry.changes = mergeSyncChanges(previous?.changes ?? (previous ? [{ source: "unknown", fields: [], at: previous.created_at }] : []), {
        source, fields, at: entry.created_at,
      });
      setQueue((current) => [
        ...current.filter((queued) => queued.local_id !== bookmarkId),
        entry,
      ]);
      // Keep the ref itself current immediately, not just via the `useEffect`
      // that mirrors it from `queue` after the next render (same rationale as
      // applyBookmarkUpdate/markBookmarkAccessed's identical bookmarksRef
      // lines): the AI-dispatch interval reads queueRef.current directly to
      // decide whether sync has settled, and a bulk-chunk reconcile pass can
      // drop its own "still reconciling" flag in the same synchronous turn as
      // this call — without this, that interval could see a stale queue with
      // nothing pending and wrongly start AI work (caught in PR review).
      queueRef.current = [
        ...queueRef.current.filter((queued) => queued.local_id !== bookmarkId),
        entry,
      ];
      ensureRepositoryReady()
        .then(() => repository.enqueue(entry))
        .catch((error) =>
          logStorageError(`${operation} mutation enqueue`, error),
        );
    },
    [],
  );

  // Annotate an outstanding create without changing upload status, retry count,
  // payload, or its mutation version. This is diagnostic data, not new work.
  const noteQueuedChange = useCallback((id: string, source: SyncChangeSource, fields: string[]) => {
    const previous = queueRef.current.find((entry) => entry.local_id === id);
    if (!previous) return;
    const next = {
      ...previous, changes: mergeSyncChanges(previous.changes ?? [{ source: "unknown", fields: [], at: previous.created_at }], {
        source, fields, at: new Date().toISOString(),
      })
    };
    queueRef.current = queueRef.current.map((entry) => entry.local_id === id ? next : entry);
    setQueue((current) => current.map((entry) => entry.local_id === id ? next : entry));
    void ensureRepositoryReady().then(() => repository.annotateQueueChanges?.(id, next.changes)).catch((error) => logStorageError("sync provenance", error));
  }, []);

  // Local-first edit of user-editable fields: apply + persist immediately,
  // show as sync-pending, and queue an update mutation for synced bookmarks.
  const applyBookmarkUpdate = useCallback(
    (id: string, patch: Partial<Bookmark>, source: SyncChangeSource = "user_edit") => {
      const syncsRemotely = hasSyncedOnce(id);
      setBookmarks((current) => {
        if (current === null) {
          return current;
        }
        return current.map((bookmark) => {
          if (bookmark.id !== id) {
            return bookmark;
          }
          return {
            ...bookmark,
            ...patch,
            sync_status: syncsRemotely ? "pending" : bookmark.sync_status,
            // Stamp it the first time this row is confirmed synced (see
            // Bookmark.ever_synced) — without this, flipping sync_status back
            // to 'pending' here would be indistinguishable from a fresh,
            // never-synced create the next time anything checks hasSyncedOnce.
            ever_synced: syncsRemotely ? true : bookmark.ever_synced,
            updated_at: new Date().toISOString(),
          };
        });
      });

      const existing = bookmarksRef.current?.find((b) => b.id === id);
      if (existing) {
        const next: Bookmark = {
          ...existing,
          ...patch,
          sync_status: syncsRemotely ? "pending" : existing.sync_status,
          ever_synced: syncsRemotely ? true : existing.ever_synced,
          updated_at: new Date().toISOString(),
        };
        // Keep the ref itself current immediately, not just via the `useEffect`
        // that mirrors it from `bookmarks` after the next render — otherwise two
        // calls back to back in the same handler (e.g. Detail/Review's "Use as
        // note" followed by markSummaryReviewed) both read this same stale
        // snapshot, and the second persisted write clobbers the repository row
        // with a `next` that's missing the first call's patch, silently losing
        // it on disk even though the rendered state looks correct.
        bookmarksRef.current = bookmarksRef.current!.map((b) =>
          b.id === id ? next : b,
        );
        ensureRepositoryReady()
          .then(() => repository.updateBookmark(next))
          .catch((error) => logStorageError("bookmark update", error));
        if (syncsRemotely) {
          enqueueMutation(id, "update", source, changedSyncFields(existing, patch));
        } else {
          noteQueuedChange(id, source, changedSyncFields(existing, patch));
        }
      }
    },
    [enqueueMutation, hasSyncedOnce, noteQueuedChange],
  );

  // Suggestion review/dismissal helpers
  const getReviewedSuggestions = useCallback(
    (bookmarkId: string) => {
      const bookmark = bookmarks?.find((b) => b.id === bookmarkId);
      return new Set(
        (bookmark?.dismissed_suggested_tags ?? []).map((name) =>
          name.toLowerCase(),
        ),
      );
    },
    [bookmarks],
  );

  const markSuggestionsReviewed = useCallback(
    (bookmarkId: string, names: string[]) => {
      const bookmark = bookmarksRef.current?.find((b) => b.id === bookmarkId);
      const trimmedNames = names.map((n) => n.trim().toLowerCase());
      const updatedTags = [
        ...new Set([
          ...(bookmark?.dismissed_suggested_tags ?? []),
          ...trimmedNames,
        ]),
      ];
      applyBookmarkUpdate(bookmarkId, {
        dismissed_suggested_tags: updatedTags,
      }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  const clearReviewedSuggestions = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_tags: [] }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  const getDismissedFolderSuggestions = useCallback(
    (bookmarkId: string) => {
      const bookmark = bookmarks?.find((b) => b.id === bookmarkId);
      return new Set(bookmark?.dismissed_suggested_folders ?? []);
    },
    [bookmarks],
  );

  const dismissFolderSuggestion = useCallback(
    (bookmarkId: string, tokens: string | string[]) => {
      const bookmark = bookmarksRef.current?.find((b) => b.id === bookmarkId);
      const tokenList = Array.isArray(tokens) ? tokens : [tokens];
      const updatedFolders = [
        ...new Set([
          ...(bookmark?.dismissed_suggested_folders ?? []),
          ...tokenList,
        ]),
      ];
      applyBookmarkUpdate(bookmarkId, {
        dismissed_suggested_folders: updatedFolders,
      }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  const clearDismissedFolderSuggestions = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_folders: [] }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  const getReviewedSummary = useCallback(
    (bookmarkId: string) => {
      const bookmark = bookmarks?.find((b) => b.id === bookmarkId);
      return new Set(bookmark?.reviewed_summary_tokens ?? []);
    },
    [bookmarks],
  );

  const markSummaryReviewed = useCallback(
    (bookmarkId: string, token: string) => {
      const bookmark = bookmarksRef.current?.find((b) => b.id === bookmarkId);
      const updatedSummaries = [
        ...new Set([...(bookmark?.reviewed_summary_tokens ?? []), token]),
      ];
      applyBookmarkUpdate(bookmarkId, {
        reviewed_summary_tokens: updatedSummaries,
      }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  const clearReviewedSummary = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { reviewed_summary_tokens: [] }, "suggestion_review");
    },
    [applyBookmarkUpdate],
  );

  // Apply + persist the "unseen AI suggestions" id set (ref updated
  // synchronously so back-to-back arrivals accumulate correctly).
  const applyUnseenSuggestions = useCallback((next: ReadonlySet<string>) => {
    unseenSuggestionIdsRef.current = next;
    setUnseenSuggestionIds(next);
    ensureRepositoryReady()
      .then(() =>
        repository.setMeta(UNSEEN_SUGGESTIONS_KEY, JSON.stringify([...next])),
      )
      .catch((error) => logStorageError("unseen suggestions", error));
  }, []);

  // The bookmark's currently-applied tag names, lowercased — read off the ref so
  // it's usable from the synchronous arrival paths (mirrors getTagsForBookmark's
  // cloud-link lookup, without the seeded-sample fallback those rows don't need).
  const appliedTagNamesRef = useCallback((bookmarkId: string): Set<string> => {
    const data = tagDataRef.current;
    const linkedIds = new Set(
      data.bookmarkTags
        .filter((link) => link.bookmark_id === bookmarkId)
        .map((l) => l.tag_id),
    );
    return new Set(
      data.tags
        .filter((tag) => linkedIds.has(tag.id))
        .map((tag) => tag.name.toLowerCase()),
    );
  }, []);

  // Add an unwitnessed enrichment to a caller-owned snapshot, but only if it
  // actually carries a recommendation the user hasn't already handled. Keeping
  // eligibility separate from publication lets a pull containing hundreds of
  // enrichments accumulate them into ONE React/meta write instead of fanning
  // hundreds of setMeta calls onto the SQLite actor (STASH-6G).
  const addUnseenSuggestion = useCallback(
    (enrichment: AIEnrichment, next: Set<string>): boolean => {
      const id = enrichment.bookmark_id;
      if (next.has(id)) {
        return false;
      }
      const bookmark = bookmarksRef.current?.find((item) => item.id === id);
      const applied = appliedTagNamesRef(id);
      const reviewed = new Set(
        (bookmark?.dismissed_suggested_tags ?? []).map((name) =>
          name.toLowerCase(),
        ),
      );
      const dismissedFolderTokens = new Set(
        bookmark?.dismissed_suggested_folders ?? [],
      );
      // Honor durable folder dismissals so a folder the user already waved off
      // (on any screen) doesn't re-raise the "new AI suggestions" banner when its
      // enrichment is re-pulled or re-run.
      const hasFolder =
        pendingSuggestedFolder(
          enrichment,
          tagDataRef.current.collections,
          bookmark?.collection_id ?? null,
          dismissedFolderTokens,
        ) !== null;
      const hasSummary =
        pendingSummary(
          bookmark?.metadata_status ?? "complete",
          enrichment,
          new Set(bookmark?.reviewed_summary_tokens ?? []),
          bookmark?.title,
        ) !== null;
      if (
        pendingSuggestions(enrichment, applied, reviewed).length === 0 &&
        !hasFolder &&
        !hasSummary
      ) {
        return false;
      }
      next.add(id);
      return true;
    },
    [appliedTagNamesRef],
  );

  // Direct/background enrichment settles one row at a time, so publish it
  // immediately. Pull sync uses addUnseenSuggestion directly and publishes the
  // whole batch once below.
  const noteUnseenSuggestions = useCallback(
    (enrichment: AIEnrichment) => {
      const next = new Set(unseenSuggestionIdsRef.current);
      if (addUnseenSuggestion(enrichment, next)) {
        applyUnseenSuggestions(next);
      }
    },
    [addUnseenSuggestion, applyUnseenSuggestions],
  );

  const markSuggestionsSeen = useCallback(
    (bookmarkId: string) => {
      if (!unseenSuggestionIdsRef.current.has(bookmarkId)) {
        return;
      }
      const next = new Set(unseenSuggestionIdsRef.current);
      next.delete(bookmarkId);
      applyUnseenSuggestions(next);
    },
    [applyUnseenSuggestions],
  );

  const clearUnseenSuggestions = useCallback(() => {
    if (unseenSuggestionIdsRef.current.size === 0) {
      return;
    }
    applyUnseenSuggestions(new Set());
  }, [applyUnseenSuggestions]);
  const {
    persistPendingAiTrigger,
    markPendingAiTrigger,
    clearPendingAiTrigger,
    persistPendingAiPreviewRefresh,
    markPendingAiPreviewRefresh,
    clearPendingAiPreviewRefresh,
    writeAiRetryState,
    persistAiRetryState,
    syncAiRetryIds,
    armAiRetry,
    deferAiEnrichmentUntilSync,
    clearAiRetry,
    persistAiServerQueued,
    syncAiServerQueuedIds,
    markAiServerQueued,
    clearAiServerQueued,
    dropAiRetryBookkeeping,
    remapAiRetryIdentity,
  } = useAiRetryBookkeeping({
    pendingAiTrigger,
    pendingAiPreviewRefresh,
    aiRetryState,
    setAiRetryIds,
    deletedIds,
    bookmarksRef,
    aiServerQueued,
    setAiServerQueuedIds,
    aiTriggerAttempted,
    aiDispatchQueueRef,
  });

  // Fire-and-forget metadata enrichment. Runs off the save path so capture is
  // never blocked, only fills generated fields, and a failure just records a
  // failed status — it never affects bookmark creation.
  const enrichInBackground = useCallback(
    (bookmark: Bookmark) => {
      if (
        bookmark.metadata_status !== "pending" ||
        enriching.current.has(bookmark.id)
      ) {
        return;
      }
      const epochAtStart = resetEpoch.current;
      enriching.current.add(bookmark.id);
      // `enriching` (the dedupe guard) is set synchronously above; the fetch
      // itself waits for a limiter slot so bulk passes stay bounded.
      void enrichmentSlots.current(async () => {
        try {
          const { patch, metadata_status } = await enrichBookmark(bookmark);
          if (resetEpoch.current !== epochAtStart) {
            return; // library was reset while fetch was in flight
          }
          // A `create` that synced while the fetch was in flight re-keys the row
          // from its local id onto its remote UUID (see the create-sync swap). If
          // the enriched fields are written against the now-dead local id they are
          // dropped from state, and the row is stranded `metadata_status:'pending'`
          // — a later re-enrichment then fills the title from the bare URL slug
          // (e.g. a YouTube video id, which reads like a random string), which is
          // exactly the "preview turned into an encrypted-looking URL" report.
          //
          // Resolve the row's CURRENT id by walking the id-alias chain to its end.
          // The alias map is a ref updated synchronously at the swap, so — unlike
          // the bookmarks ref, which lags a render behind the state swap — it never
          // points at a stale id. We then merge onto the freshest row we can find
          // (preferring the remote row, then the pre-swap local row, then the
          // snapshot the fetch was invoked with) but always write under the resolved
          // id, so the update lands even while the bookmarks ref is catching up.
          const currentId = resolveAliasedId(bookmark.id, idAliases.current);
          if (currentId !== bookmark.id) {
            // Diagnostic: the row was re-keyed (its create synced, or a
            // leftover/account re-home reconciled it) while this fetch was in
            // flight — the exact condition that used to drop the enriched title.
            // Logging it confirms whether the race actually fires in the wild.
            recordLog(
              "info",
              `enrich: bookmark re-keyed ${bookmark.id} -> ${currentId} mid-fetch; applying metadata to current id`,
            );
          }
          if (
            deletedIds.current.has(bookmark.id) ||
            deletedIds.current.has(currentId)
          ) {
            return; // deleted while the fetch was in flight
          }
          const rows = bookmarksRef.current;
          const source =
            rows?.find((item) => item.id === currentId) ??
            rows?.find((item) => item.id === bookmark.id) ??
            bookmark;
          // Reconstruct the row under `currentId` when we only found it under its
          // pre-swap id (the bookmarks ref lagging the alias). Reaching this branch
          // means an alias re-keyed the row — which happens only once its `create`
          // synced (or a leftover/account re-home reconciled it), so the row is
          // 'synced' on the server. Force that here rather than carrying the stale
          // snapshot's `sync_status: 'pending'` forward, which would otherwise
          // revert a successfully-created bookmark to pending and, if its follow-up
          // update never lands, strand it as pending/failed.
          const latest: Bookmark =
            source.id === currentId
              ? source
              : {
                ...source,
                id: currentId,
                sync_status: hasSyncedOnce(currentId)
                  ? "synced"
                  : source.sync_status,
              };
          // Fill only generated fields that are still empty. A source-app
          // share title is itself generated and may be improved; a manual
          // user title remains protected.
          const safePatch: Partial<Bookmark> = {};
          if (
            patch.title !== undefined &&
            (latest.title === null || latest.title_is_derived === true)
          ) {
            safePatch.title = patch.title;
            // Carry the title's provenance alongside it, so a generated fallback
            // title is recorded as such (and a real fetched title as not-derived).
            safePatch.title_is_derived = patch.title_is_derived;
          }
          const generatedTitleChanged =
            safePatch.title !== undefined && safePatch.title !== latest.title;
          if (patch.site_name !== undefined && latest.site_name === null) {
            safePatch.site_name = patch.site_name;
          }
          if (patch.favicon_url !== undefined && latest.favicon_url === null) {
            safePatch.favicon_url = patch.favicon_url;
          }
          if (
            patch.preview_image_url !== undefined &&
            latest.preview_image_url === null
          ) {
            safePatch.preview_image_url = patch.preview_image_url;
          }
          const updated: Bookmark = {
            ...latest,
            ...safePatch,
            metadata_status,
            updated_at: new Date().toISOString(),
          };

          setBookmarks((current) =>
            current === null
              ? current
              : current.map((item) =>
                item.id === updated.id ? updated : item,
              ),
          );
          // Keep the ref current immediately rather than waiting for the
          // separate mirroring effect (which only runs on next render): other
          // local-only writers (e.g. checkVideoAvailability) read
          // bookmarksRef.current to build a full-row replacement, and any gap
          // here is a window where such a write would revert these
          // just-enriched fields (caught in PR review, STASH-61).
          bookmarksRef.current = bookmarksRef.current
            ? bookmarksRef.current.map((item) =>
              item.id === updated.id ? updated : item,
            )
            : bookmarksRef.current;
          try {
            await ensureRepositoryReady();
            await repository.updateBookmark(updated);
          } catch (error) {
            logStorageError("metadata enrichment", error);
          }
          if (resetEpoch.current !== epochAtStart) {
            // A reset can land behind this write on native, where storage work
            // is serialized on a single actor tail — the write above may have
            // already landed against freshly-cleared storage. Don't compound
            // that by also queuing a sync mutation for a bookmark that should
            // no longer exist.
            return;
          }
          // Push the freshly fetched metadata to the cloud so other devices see
          // it on their next pull. Only for already-synced bookmarks: a local
          // bookmark's create upload already sends its latest fields.
          if (hasSyncedOnce(updated.id)) {
            enqueueMutation(updated.id, "update", "metadata_fetch", changedSyncFields(latest, { ...safePatch, metadata_status }));
          } else if (generatedTitleChanged) {
            pendingGeneratedTitleUpdates.current.add(updated.id);
          }
          if (!hasSyncedOnce(updated.id)) {
            noteQueuedChange(updated.id, "metadata_fetch", changedSyncFields(latest, { ...safePatch, metadata_status }));
          }
        } finally {
          enriching.current.delete(bookmark.id);
        }
      });
    },
    [enqueueMutation, hasSyncedOnce, noteQueuedChange],
  );
  useLibraryHydration({
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
  });

  // Cost probe for the React work this provider drives: render → commit →
  // passive-effect flush. The effect below has no dependency array on purpose,
  // so it runs after EVERY commit and the delta covers the whole cycle. This is
  // the one big JS-thread block a `measureSyncSegment` bracket around store code
  // can never see — `setBookmarks`/`setQueue` are batched, so the re-render they
  // cause happens after the calling region has already returned. React's own
  // Profiler is compiled out of release builds, which is why this is measured by
  // hand. Two clock reads per commit; the timestamp is written during render on
  // purpose (a StrictMode double render just re-stamps it, which can only
  // under-report, never invent a stall).
  const reactCycleStartedAt = useRef(0);
  reactCycleStartedAt.current = Date.now();
  useEffect(() => {
    recordSlowSegment("react-cycle", Date.now() - reactCycleStartedAt.current);
  });

  // Continuously watch the JS event loop for multi-second stalls — the "button
  // press does nothing for several seconds after sharing" freeze (Sentry
  // STASH-H) the native ANR/app-hang detectors miss because they watch the main
  // thread, not the JS thread. Reporting-only: it self-reports a coarse,
  // non-identifying snapshot (sync/queue counts — never bookmark content) so an
  // otherwise invisible freeze reaches monitoring. Paused while backgrounded so
  // a frozen-then-resumed app is not misread as a stall.
  useEffect(() => {
    const watchdog = armLoopStallWatchdog({
      // Sentry STASH-K came back as "stalled ~3096ms (syncing=true queue=685)":
      // enough to place the stall inside a sync pass over a large queue, not
      // enough to name the blocking code, which by then has already unwound.
      // `recentSlow` closes that gap — the instrumented regions time themselves
      // (see slow-segment-log.ts), so a ~3s segment recorded moments before a
      // ~3s stall is direct attribution. `none` is a real result too: it rules
      // the instrumented regions out and points elsewhere.
      describe: () => {
        const recentSlow = describeRecentSegments();
        return (
          `syncing=${syncInFlight.current} queue=${queueRef.current.length} ` +
          `recentSlow=[${recentSlow || "none"}]`
        );
      },
    });
    const unregister = registerForForegroundState({
      onBackground: () => watchdog.pause(),
      onForeground: () => watchdog.resume(),
    });
    return () => {
      unregister();
      watchdog.disarm();
    };
  }, []);

  const loadedBookmarks = useMemo(() => bookmarks ?? [], [bookmarks]);

  const getBookmark = useCallback(
    (id: string) => {
      const direct = loadedBookmarks.find((bookmark) => bookmark.id === id);
      if (direct) {
        return direct;
      }
      // The id may have been re-keyed under a holder of the old one (a create
      // syncing to its remote id, or an account re-home). Follow the alias chain
      // — guarding against cycles — so a stale id still resolves to the live row
      // instead of reading as "not found".
      const seen = new Set<string>([id]);
      let next = idAliases.current.get(id);
      while (next && !seen.has(next)) {
        const match = loadedBookmarks.find((bookmark) => bookmark.id === next);
        if (match) {
          return match;
        }
        seen.add(next);
        next = idAliases.current.get(next);
      }
      return undefined;
    },
    [loadedBookmarks],
  );

  // Precompute bookmarkId -> Tag[] once per tagData change so search (which calls
  // getTagsForBookmark for every bookmark on every keystroke) is an O(1) Map
  // lookup instead of an O(N·M) scan + Set allocation per call. Cloud tag links
  // (refreshed by pull sync) are the only source; a bookmark with no links has
  // no tags.
  const tagsByBookmark = useMemo(() => {
    const map = new Map<string, Tag[]>();
    const tagsById = new Map(tagData.tags.map((tag) => [tag.id, tag]));

    // Group cloud links by bookmark, preserving first-seen order.
    const cloudIdsByBookmark = new Map<string, string[]>();
    for (const link of tagData.bookmarkTags) {
      const list = cloudIdsByBookmark.get(link.bookmark_id);
      if (list) {
        list.push(link.tag_id);
      } else {
        cloudIdsByBookmark.set(link.bookmark_id, [link.tag_id]);
      }
    }
    for (const [bookmarkId, tagIds] of cloudIdsByBookmark) {
      const tags = tagIds
        .map((tagId) => tagsById.get(tagId))
        .filter((tag): tag is Tag => Boolean(tag));
      map.set(bookmarkId, tags);
    }

    return map;
  }, [tagData]);

  const getTagsForBookmark = useCallback(
    (id: string) => tagsByBookmark.get(id) ?? EMPTY_TAGS,
    [tagsByBookmark],
  );

  const getCollection = useCallback(
    (id: string | null) =>
      id === null
        ? undefined
        : tagData.collections.find((collection) => collection.id === id),
    [tagData],
  );

  // Precompute bookmarkId -> newest enrichment once per `enrichments` change, so
  // getEnrichment is an O(1) Map lookup instead of an O(E) filter+sort per call.
  // The Inbox recomputes `pendingReviewCount`/`newSuggestionsCount` over every
  // bookmark on each render and calls getEnrichment for each — the old per-call
  // scan made that O(bookmarks x enrichments) and allocated a throwaway array
  // every time, a freeze/GC risk on a large library. Mirrors `tagsByBookmark`.
  const enrichmentsById = useMemo(() => {
    const map = new Map<string, AIEnrichment>();
    for (const enrichment of enrichments) {
      const current = map.get(enrichment.bookmark_id);
      // Newest wins; on a tie keep the first seen (matches the old descending
      // sort + stable-sort + [0], which returned the earliest-indexed of the max).
      if (
        !current ||
        enrichment.created_at.localeCompare(current.created_at) > 0
      ) {
        map.set(enrichment.bookmark_id, enrichment);
      }
    }
    return map;
  }, [enrichments]);

  const getEnrichment = useCallback(
    (bookmarkId: string) => enrichmentsById.get(bookmarkId),
    [enrichmentsById],
  );

  // Mark a bookmark's newest 'complete' enrichment as stale when the user edits
  // its title/notes, so Bookmark Detail can flag the suggestions as out of date
  // until "Refresh AI suggestions" regenerates them. Local-first: never calls
  // the network here, just updates + persists the status.
  const markEnrichmentStale = useCallback((bookmarkId: string) => {
    const current = enrichmentsRef.current
      .filter((enrichment) => enrichment.bookmark_id === bookmarkId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!current || current.status !== "complete") {
      return;
    }
    const stale: AIEnrichment = {
      ...current,
      status: "stale",
      updated_at: new Date().toISOString(),
    };
    setEnrichments((rows) =>
      rows.map((row) => (row.id === stale.id ? stale : row)),
    );
    ensureRepositoryReady()
      .then(() => repository.upsertEnrichments([stale]))
      .catch((error) => logStorageError("enrichment staleness", error));
  }, []);
  const { addBookmark } = useAddBookmark({
    hideAccountCache,
    loadedBookmarks,
    setBookmarks,
    setQueue,
    localCreateFlushesInFlight,
    syncPendingRef,
    syncPendingForceRef,
    syncNowRef,
    enrichInBackground,
    hasSyncedOnce,
    bookmarksRef,
    pendingUserTitleEdits,
    markEnrichmentStale,
    enqueueMutation,
  });
  const { importBookmarks } = useImportBookmarks({
    bookmarksRef,
    isSyncingState,
    tagWorkPending,
    loadedBookmarks,
    tagDataRef,
    pendingTagOpsRef,
    pendingImportCollectionsRef,
    pendingEnrichmentRestoresRef,
    auth,
    setPendingTagOps,
    setTagData,
    setPendingImportCollections,
    setPendingEnrichmentRestores,
    setBookmarks,
    setQueue,
    localCreateFlushesInFlight,
    enriching,
    enrichInBackground,
    serializeTagWork,
    resetEpoch,
    syncPendingRef,
    syncPendingForceRef,
    syncNowRef,
  });
  const {
    markBookmarkAccessed,
    checkVideoAvailability,
    trashBookmark,
    restoreBookmark,
    updateBookmarkFields,
    refreshBookmarkPreview,
  } = useBookmarkEdits({
    bookmarksRef,
    setBookmarks,
    videoAvailabilityCheckingRef,
    applyBookmarkUpdate,
    clearAiRetry,
    syncAiRetryIds,
    clearAiServerQueued,
    hasSyncedOnce,
    pendingUserTitleEdits,
    markEnrichmentStale,
    previewRefreshingIds,
    setPreviewRefreshingIds,
    markPendingAiPreviewRefresh,
    setEnrichments,
    enqueueMutation,
    noteQueuedChange,
    pendingAiPreviewRefresh,
    aiSuggestionsModeRef,
    requestAiEnrichmentRef,
    clearPendingAiPreviewRefresh,
  });
  const { deleteBookmark, emptyTrash } = useDeleteCommands({
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
  });
  const { resetLibrary } = useResetLibrary({
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
    setAccountTransfer,
  });
  const { syncTagOps } = useTagSync({
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
  });
  const { commitTagEdit, addTagsToBookmarks, addTagsToBookmark, removeTagFromBookmark } = useTagCommands({
    serializeTagWork,
    idAliases,
    bookmarksRef,
    authRef,
    tagDataRef,
    pendingTagOpsRef,
    tagJournalHealthyRef,
    tagJournalRetryAtRef,
    setTagJournalRetryAt,
    applyTagOps,
    applyTagData,
    syncTagOps,
  });
  const { requestAiEnrichment } = useAiEnrichmentRequest({
    auth,
    bookmarksRef,
    hasSyncedOnce,
    aiEnriching,
    resetEpoch,
    setEnrichingIds,
    setManualEnrichingIds,
    queueRef,
    syncPausedRef,
    syncNowRef,
    deferAiEnrichmentUntilSync,
    aiTriggerAttempted,
    localeRef,
    setEnrichments,
    clearAiRetry,
    clearAiServerQueued,
    aiSuggestionsModeRef,
    autoAcceptEnrichmentRef,
    noteUnseenSuggestions,
    armAiRetry,
    clearPendingAiTrigger,
    lastSyncedUserId,
    wasAnonymousRef,
    aiQuotaCooldownUntil,
    setAiQuotaExceeded,
    enrichmentsRef,
    markAiServerQueued,
    syncAiRetryIds,
  });
  useEffect(() => {
    requestAiEnrichmentRef.current = requestAiEnrichment;
  }, [requestAiEnrichment]);

  // True while an AI enrichment request for this bookmark is in flight (whether
  // auto-triggered after sync or started by a manual "Suggest with AI" tap).
  const isEnriching = useCallback(
    (bookmarkId: string): boolean => enrichingIds.has(bookmarkId),
    [enrichingIds],
  );

  // True only for a user-initiated request, so the button can show explicit
  // feedback without the auto-trigger ever making the section feel like a wait.
  const isManuallyEnriching = useCallback(
    (bookmarkId: string): boolean => manualEnrichingIds.has(bookmarkId),
    [manualEnrichingIds],
  );

  const isRefreshingPreview = useCallback(
    (bookmarkId: string): boolean => previewRefreshingIds.has(bookmarkId),
    [previewRefreshingIds],
  );

  // True if this bookmark has EVER recorded a failed AI-enrichment attempt
  // that hasn't since exhausted its retry cap — regardless of whether it's
  // currently retrying. Stays true across a retry's whole in-flight window
  // (see aiRetryIds' declaration comment), unlike isAiSuggestionPostponed.
  const hadPriorEnrichmentAttempt = useCallback(
    (bookmarkId: string): boolean => aiRetryIds.has(bookmarkId),
    [aiRetryIds],
  );

  // True while a bookmark has a failed-attempt marker AND isn't currently
  // retrying — i.e. it's waiting out its backoff, not actively working.
  const isAiSuggestionPostponed = useCallback(
    (bookmarkId: string): boolean =>
      aiRetryIds.has(bookmarkId) && !enrichingIds.has(bookmarkId),
    [aiRetryIds, enrichingIds],
  );

  // True if this bookmark's AI-enrichment 429 was confirmed accepted into the
  // server-side overflow queue and hasn't since resolved (see
  // AI_SERVER_QUEUED_KEY). Reads the reactive mirror, not the ref.
  const isAiSuggestionServerQueued = useCallback(
    (bookmarkId: string): boolean => aiServerQueuedIds.has(bookmarkId),
    [aiServerQueuedIds],
  );

  // Accept AI-suggested tags: ensure + link them with `source: 'ai'` so their
  // provenance and confidence are preserved (vs. user-typed tags).
  const acceptSuggestedTags = useCallback(
    async (
      bookmarkId: string,
      suggestions: SuggestedTag[],
    ): Promise<string | null> => {
      if (!hasRemoteIdentity(bookmarkId) || !bookmarksRef.current?.some((bookmark) => bookmark.id === bookmarkId)) {
        return "This bookmark cannot be tagged.";
      }
      const valid = suggestions.filter(
        (suggestion) => suggestion.name.trim().length > 0,
      );
      if (valid.length === 0) {
        return null;
      }
      const error = await commitTagEdit(bookmarkId, valid, "add");
      if (error) return error;
      // Accepting a suggestion counts as reviewing it, so removing the tag later
      // won't bring the "✨" badge back for a name the user already decided on.
      markSuggestionsReviewed(
        bookmarkId,
        valid.map((suggestion) => suggestion.name),
      );
      void syncTagOps();
      return null;
    },
    [commitTagEdit, markSuggestionsReviewed, syncTagOps],
  );
  const {
    assignCollection,
    createCollection,
    renameCollection,
    deleteCollections,
    deleteCollection,
    mergeCollections,
  } = useCollectionCommands({
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
  });
  const { syncPendingImportCollections, syncPendingEnrichmentRestores } = useImportOutboxSync({
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
  });

  // STASH #573 auto_accept mode: apply an enrichment's tag/folder suggestions
  // automatically, with no review step. Reuses the exact same eligibility
  // rules (`pendingSuggestions`'s SUGGESTION_MIN_CONFIDENCE filter,
  // `pendingSuggestedFolder`'s dismissal honoring) and application path
  // (`acceptSuggestionBundle`) as the Detail/Review screens' manual "Accept"
  // actions — no separate confidence threshold, no separate write path.
  //
  // Only ever FILLS still-null generated fields, never overwrites anything the
  // user set:
  //  - Tags are additive (a set), so applying new suggested tags can't clobber
  //    an existing one.
  //  - The folder suggestion is only applied when the bookmark is currently
  //    UNFILED (`collection_id === null`). `pendingSuggestedFolder` also
  //    returns a "move" recommendation (its `from` set) whenever the AI's pick
  //    differs from wherever the bookmark already lives — silently executing
  //    that unattended would be auto-accept relocating something the user (or
  //    an earlier accepted suggestion) deliberately filed, which is exactly
  //    the kind of user-authored-state trampling "Capture is sacred" guards
  //    against. Gating on "currently unfiled" keeps every application here an
  //    add, never a move.
  const autoAcceptEnrichment = useCallback(
    async (bookmarkId: string, enrichment: AIEnrichment): Promise<void> => {
      const bookmark = bookmarksRef.current?.find(
        (item) => item.id === bookmarkId,
      );
      if (!bookmark) {
        return; // gone (trashed/deleted) mid-flight — nothing to apply to
      }
      const applied = appliedTagNamesRef(bookmarkId);
      const reviewed = new Set(
        (bookmark.dismissed_suggested_tags ?? []).map((name) =>
          name.toLowerCase(),
        ),
      );
      const suggestions = pendingSuggestions(enrichment, applied, reviewed);
      const dismissedFolderTokens = new Set(
        bookmark.dismissed_suggested_folders ?? [],
      );
      const folder = bookmark.collection_id
        ? null // already filed — never auto-relocate, see comment above
        : pendingSuggestedFolder(
          enrichment,
          tagDataRef.current.collections,
          null,
          dismissedFolderTokens,
        );
      if (suggestions.length === 0 && !folder) {
        return;
      }
      const folderTokens = suggestedFolderTokens(
        folder,
        enrichment.suggested_collection_name,
      );
      await acceptSuggestionBundle(
        {
          acceptSuggestedTags,
          addTagsToBookmark,
          assignCollection,
          createCollection,
          dismissFolderSuggestion,
        },
        {
          bookmarkId,
          aiSuggestions: suggestions,
          folder,
          folderTokens,
          createCollectionError: "Could not create the collection.",
        },
      );
    },
    [
      appliedTagNamesRef,
      acceptSuggestedTags,
      addTagsToBookmark,
      assignCollection,
      createCollection,
      dismissFolderSuggestion,
    ],
  );
  useEffect(() => {
    autoAcceptEnrichmentRef.current = autoAcceptEnrichment;
  }, [autoAcceptEnrichment]);

  // Re-keys everything indexed by a bookmark's id (the alias map for
  // getBookmark, pending tag ops + optimistic links, AI-retry bookkeeping)
  // from an old id onto a new one. A bookmark's id is otherwise stable for
  // life once captured (see makeBookmarkId) — the two remaining cases it
  // ever changes are account rehoming (below) and a create that resolves as
  // a server-side duplicate of an existing different row instead of using
  // the id the client sent (STASH-3Q; see `originalLocalId` in
  // sync/sync-bookmarks.ts). Both must call this the same way, or the
  // re-keyed bookmark silently loses its queued tags / retry eligibility,
  // stranded on an id that no longer exists.
  const rekeyBookmarkIdentity = useCallback(
    async (
      idMap: Map<string, string>,
      options: { persist?: boolean; carryTags?: boolean; serialized?: boolean } = {},
    ): Promise<IdentityRekeyState> => {
      const run = async (): Promise<IdentityRekeyState> => {
        for (const [oldId, newId] of idMap) {
          idAliases.current.set(oldId, newId);
        }
        const rekeyedTagOps = options.carryTags
          ? carryOverTagOps(pendingTagOpsRef.current, tagDataRef.current, idMap, makeUuid, new Date().toISOString())
          : rekeyPendingTagOps(pendingTagOpsRef.current, idMap);
        const rekeyedImportCollections = rekeyPendingImportCollections(
          pendingImportCollectionsRef.current,
          idMap,
        );
        // #671: an enrichment restore queued against a local id must follow the
        // bookmark to its resolved remote id the same way — otherwise a
        // duplicate-adoption or account rehome strands the restore on a dead id
        // that syncPendingEnrichmentRestores's hasSyncedOnce check can never see.
        const rekeyedEnrichmentRestores = rekeyPendingEnrichmentRestores(
          pendingEnrichmentRestoresRef.current,
          idMap,
        );
        const links = tagDataRef.current.bookmarkTags.map((link) => {
          const newId = idMap.get(link.bookmark_id);
          return newId ? { ...link, bookmark_id: newId } : link;
        });
        const rekeyedTagData = { ...tagDataRef.current, bookmarkTags: links };
        pendingTagOpsRef.current = rekeyedTagOps;
        setPendingTagOps(rekeyedTagOps);
        pendingImportCollectionsRef.current = rekeyedImportCollections;
        setPendingImportCollections(rekeyedImportCollections);
        pendingEnrichmentRestoresRef.current = rekeyedEnrichmentRestores;
        setPendingEnrichmentRestores(rekeyedEnrichmentRestores);
        tagDataRef.current = rekeyedTagData;
        setTagData(rekeyedTagData);
        remapAiRetryIdentity(idMap);
        // STASH-69 investigation: an in-flight failure episode is keyed by
        // local_id like the state above — without this, a bookmark that
        // failed and was then rehomed (duplicate adoption, anonymous→real
        // carry-over) would leak its old-id episode and miscount its eventual
        // success under the new id as a clean sync (Codex review on #765).
        remapSyncStatusIdentity(idMap);

        const identityState: IdentityRekeyState = {
          metaUpdates: {
            [PENDING_TAG_OPS_KEY]: JSON.stringify(rekeyedTagOps),
            [PENDING_IMPORT_COLLECTIONS_KEY]: JSON.stringify(
              rekeyedImportCollections,
            ),
            [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify(
              rekeyedEnrichmentRestores,
            ),
          },
          tagData: rekeyedTagData,
        };
        if (options.persist !== false) {
          // Duplicate adoption has already made the bookmark swap durable. Await
          // the matching organization state before reconciliation continues.
          await ensureRepositoryReady();
          for (const [key, value] of Object.entries(identityState.metaUpdates)) {
            await repository.setMeta(key, value);
          }
          await repository.replaceTagData(rekeyedTagData);
        }
        return identityState;
      };
      return options.serialized ? run() : serializeTagWork(run);
    },
    [remapAiRetryIdentity, serializeTagWork],
  );

  // Account-switch guard: reconciles the local cache with the signed-in user
  // so a pull can never treat another account's rows as remote deletions.
  // Anonymous data carries over (re-home); a different real account's cache
  // is dropped (it stays safe in that account's cloud). Extracted so syncNow
  // can call it from its normal pre-pull position AND from its pause guard
  // (Sentry STASH-3K review) — a real account switch must never leave the
  // previous account's cached bookmarks on screen under the new session just
  // because sync is paused. Idempotent: once reconciled, a plan with nothing
  // left to drop/rehome is a no-op, so calling it twice is harmless.
  const reconcileAccountTransition = useCallback(
    async (currentUser: {
      id: string;
      isAnonymous: boolean;
    }): Promise<boolean> => {
      try {
        const previousOwner = await readCacheOwner(repository);
        if (authRef.current.userId !== currentUser.id) return false;
        const localRows = bookmarksRef.current ?? [];
        const plan = planAccountTransition(previousOwner, currentUser, localRows);
        const transferCount = !currentUser.isAnonymous && (previousOwner?.isAnonymous || !previousOwner)
          ? localRows.filter((row) => !isBookmarkSyncedOnce(row) || (previousOwner?.isAnonymous && hasRemoteIdentity(row.id))).length
          : 0;
        await serializeTagWork(() => applyAccountTransition(
          plan,
          repository,
          setBookmarks,
          setQueue,
          makeBookmarkId,
          ensureRepositoryReady,
          {
            rehome: (idMap) => rekeyBookmarkIdentity(idMap, { persist: false, carryTags: true, serialized: true }),
            drop: (ids) => {
              // Real A→real B switch: purge A's pending tag ops + links so a
              // later syncTagOps call (now under B's auth) can't upload A's
              // tags as B or surface them in B's UI.
              applyTagOps(
                dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, ids),
              );
              applyPendingImportCollections(
                dropPendingImportCollections(
                  pendingImportCollectionsRef.current,
                  ids,
                ),
              );
              // #671: A's queued enrichment restores are dead the same way —
              // never let them upload against a bookmark id B's session no
              // longer owns.
              applyPendingEnrichmentRestores(
                dropPendingEnrichmentRestores(
                  pendingEnrichmentRestoresRef.current,
                  ids,
                ),
              );
              const dropped = new Set(ids);
              const links = tagDataRef.current.bookmarkTags.filter(
                (link) => !dropped.has(link.bookmark_id),
              );
              applyTagData({ ...tagDataRef.current, bookmarkTags: links });
              // Purge A's AI-suggestion bookkeeping too, so checkAiRetries (no
              // ownership check) can't fire requestAiEnrichment against A's
              // bookmark id under B's now-active session.
              dropAiRetryBookkeeping(ids);
              // dropAiRetryBookkeeping's per-id filter only zeroes
              // completedInBurst when it actually removes something from
              // .pending — if A's last dispatch had already been popped (in
              // flight, nothing left pending) at switch time, a nonzero count
              // survives untouched and would bleed into B's first burst
              // toast. Zero it unconditionally here instead; unlike a full
              // queue reset this doesn't touch .pending, so a legitimately
              // surviving never-synced local bookmark's staged dispatch (drop
              // only removes rows with a remote identity — see
              // cloudRemoteRows) isn't lost. The epoch bump discards A's
              // still-in-flight dispatch's own settle too (#691).
              aiDispatchQueueRef.current = clearBurstCompletion(
                aiDispatchQueueRef.current,
              );
              aiDispatchEpoch.current += 1;
            },
          },
        ));
        // Publish the reconciled snapshot before allowing account-owned rows
        // through the UI. A failed or stale reconciliation never reveals them.
        const reconciledRows = await repository.listBookmarks();
        // An interrupted pull must never make already-uploaded guest captures
        // look ownerless at the next login. Keep this separate from pull meta.
        if (!(previousOwner && !previousOwner.isAnonymous && currentUser.isAnonymous)) {
          await writeCacheOwner(repository, currentUser);
        }
        if (authRef.current.userId === currentUser.id) {
          if (transferCount > 0) setAccountTransfer({ userId: currentUser.id, count: transferCount });
          setAccountLibraryFailureUserId(null);
          const changed = !sameRecordSnapshot(bookmarksRef.current ?? [], reconciledRows);
          bookmarksRef.current = reconciledRows;
          if (changed) setBookmarks(reconciledRows);
          setReconciledCacheUserId(currentUser.id);
        }
        return true;
      } catch (error) {
        if (authRef.current.userId === currentUser.id) setAccountLibraryFailureUserId(currentUser.id);
        logStorageError("account transition", error);
        try {
          await ensureRepositoryReady();
          const [
            storedBookmarks,
            storedQueue,
            storedTagData,
            rawTagOps,
            rawCollections,
            rawEnrichmentRestores,
          ] = await Promise.all([
            repository.listBookmarks(),
            repository.listQueue(),
            repository.listTagData(),
            repository.getMeta(PENDING_TAG_OPS_KEY),
            repository.getMeta(PENDING_IMPORT_COLLECTIONS_KEY),
            repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY),
          ]);
          const storedTagOps = parseTagOps(rawTagOps);
          const storedCollections =
            parsePendingImportCollections(rawCollections);
          const storedEnrichmentRestores = parsePendingEnrichmentRestores(
            rawEnrichmentRestores,
          );
          bookmarksRef.current = storedBookmarks;
          queueRef.current = storedQueue;
          tagDataRef.current = storedTagData;
          pendingTagOpsRef.current = storedTagOps;
          pendingImportCollectionsRef.current = storedCollections;
          pendingEnrichmentRestoresRef.current = storedEnrichmentRestores;
          setBookmarks(storedBookmarks);
          setQueue(storedQueue);
          setTagData(storedTagData);
          setPendingTagOps(storedTagOps);
          setPendingImportCollections(storedCollections);
          setPendingEnrichmentRestores(storedEnrichmentRestores);
        } catch (reloadError) {
          logStorageError("account transition recovery", reloadError);
        }
        return false;
      }
    },
    [
      applyPendingImportCollections,
      applyPendingEnrichmentRestores,
      applyTagOps,
      applyTagData,
      dropAiRetryBookkeeping,
      rekeyBookmarkIdentity,
      serializeTagWork,
    ],
  );
  const { syncNow } = useSyncCoordinator({
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
  });

  // Realtime Sync initialization
  const { broadcastSyncNudge } = useRealtimeSync({
    session: auth.session,
    status: auth.status,
    userId: auth.userId,
    syncNow,
  });
  broadcastSyncNudgeRef.current = broadcastSyncNudge;
  syncNowRef.current = syncNow;

  // URL-title backfill: repair bookmarks already saved with a poor URL-derived
  // title (a bare host like "youtu.be", or an opaque id slug like "Dabls52E90n")
  // now that `deriveMetadata` produces a human label. Only rows whose title is
  // provably our own historical machine fallback are touched (see
  // `planTitleBackfill`), so a user-renamed or real fetched title is never
  // clobbered.
  //
  // Reactive and idempotent, deliberately: it re-scans on every `bookmarks`
  // change rather than running once behind a durable flag, because a repaired
  // title no longer equals its legacy fallback and so is skipped forever after
  // — the operation is self-terminating per row. This is what lets rows that
  // arrive *later* (a post-sign-in cloud pull) still get repaired, which a
  // one-shot flag set on the pre-pull snapshot would have missed.
  //
  // Local-only cosmetic relabel: it never enqueues a sync mutation, never
  // re-fetches (no `metadata_status` change → the enrichment effect below is not
  // triggered), and does NOT bump `updated_at`. This runs the instant the local
  // cache loads, before the startup pull — any of those would make a synced row
  // out-rank or overwrite the (possibly better) cloud row the pull is about to
  // fetch (`pullRemoteChanges` only accepts `remote.updated_at > local.updated_at`).
  // Keeping the timestamp lets a genuinely newer remote row still win, while an
  // unchanged remote (same bad fallback) leaves our local repair in place.
  useEffect(() => {
    if (bookmarks === null) {
      return;
    }
    // Cheap gate: is there anything to repair? A per-row throw is caught so one
    // malformed URL can't abort the scan.
    const hasWork = bookmarks.some((item) => {
      try {
        return planTitleBackfill(item) !== null;
      } catch {
        return false;
      }
    });
    if (!hasWork) {
      return;
    }
    // In-memory: re-validate against the freshest CURRENT row and merge the
    // patch (title/preview/provenance only — never `updated_at` or status), so a
    // field changed concurrently is preserved and a row that no longer qualifies
    // is left alone.
    setBookmarks((current) => {
      if (current === null) {
        return current;
      }
      return current.map((item) => {
        let plan: TitleBackfillPatch | null;
        try {
          plan = planTitleBackfill(item);
        } catch {
          plan = null;
        }
        if (!plan) {
          return item;
        }
        return {
          ...item,
          title: plan.title,
          preview_image_url: plan.preview_image_url ?? item.preview_image_url,
          title_is_derived: plan.title_is_derived,
        };
      });
    });
    // Durable: repository writes replace the whole row, so persisting a row
    // built from a stale read would clobber a concurrent notes/collection/trash
    // edit or a pulled field. For each repair target, re-read the freshest stored
    // row and build the write from it with NO await in between — so no other
    // writer can interleave between this row's read and its write — and re-plan
    // against that fresh row so one already repaired/edited is skipped.
    const targetIds = (bookmarksRef.current ?? bookmarks)
      .filter((item) => {
        try {
          return planTitleBackfill(item) !== null;
        } catch {
          return false;
        }
      })
      .map((item) => item.id);
    (async () => {
      try {
        await ensureRepositoryReady();
        let count = 0;
        for (const id of targetIds) {
          const base = await repository.getBookmark(id);
          if (!base) {
            continue;
          }
          let plan: TitleBackfillPatch | null;
          try {
            plan = planTitleBackfill(base);
          } catch {
            plan = null;
          }
          if (!plan) {
            continue;
          }
          await repository.updateBookmark({
            ...base,
            title: plan.title,
            preview_image_url: plan.preview_image_url ?? base.preview_image_url,
            title_is_derived: plan.title_is_derived,
          });
          count += 1;
        }
        if (count > 0) {
          recordLog(
            "info",
            `title-backfill: repaired ${count} URL-derived title(s)`,
          );
        }
      } catch (error) {
        logStorageError("title backfill", error);
      }
    })();
  }, [bookmarks]);

  // Background enrichment: once local data is loaded, enrich any bookmark
  // whose metadata is still pending (seeded items, or saves from a previous
  // session that closed before enrichment finished).
  useEffect(() => {
    if (bookmarks === null) {
      return;
    }
    for (const bookmark of bookmarks) {
      if (bookmark.metadata_status === "pending") {
        enrichInBackground(bookmark);
      }
    }
  }, [bookmarks, enrichInBackground]);

  // Deferred auto AI enrichment: fire for a freshly created bookmark only once
  // its metadata enrichment has settled (no longer 'pending'), so the model
  // sees a real title/site instead of the bare URL it was captured as. Driven
  // off committed state, so it's correct whether the create or the OpenGraph
  // fetch finished first, and immune to any local→remote id swap along the way.
  useEffect(() => {
    // Wait for an auth session: requestAiEnrichment no-ops without one, and
    // marking the id attempted before then would consume the only same-session
    // attempt — when auth restores, the rerun would skip it and the trigger
    // would never fire until another restart. On a cold start, storage loads
    // before the session is restored, so this gate matters.
    // STASH #573: 'off' means never auto-trigger. Leave `aiTriggerAttempted`
    // untouched so a later switch to 'confirm'/'auto_accept' re-evaluates
    // every still-pending id instead of finding it already "attempted".
    if (
      bookmarks === null ||
      !auth.session ||
      pendingAiTrigger.current.size === 0 ||
      aiSuggestionsModeRef.current === "off"
    ) {
      return;
    }
    for (const id of [...pendingAiTrigger.current]) {
      if (aiTriggerAttempted.current.has(id)) {
        continue; // already fired this session — don't re-fire on every render
      }
      const bookmark = bookmarks.find((item) => item.id === id);
      if (!bookmark) {
        continue; // not committed under this id yet — wait for a later render
      }
      if (bookmark.metadata_status === "pending") {
        continue; // metadata fetch still in flight — fire once it settles
      }
      if (
        bookmark.sync_status !== "synced" ||
        queueRef.current.some((entry) => entry.local_id === id)
      ) {
        continue; // creation or local mutations still uploading — wait for sync
      }
      // Already has suggestions (enriched in a prior session or via the manual
      // action): clear the durable marker without re-requesting.
      if (
        enrichmentsRef.current.some(
          (enrichment) => enrichment.bookmark_id === id,
        )
      ) {
        clearPendingAiTrigger(id);
        continue;
      }
      aiTriggerAttempted.current.add(id);
      // Do NOT clear the durable "awaiting first attempt" marker before the
      // request even starts: requestAiEnrichment only arms the backoff-
      // scheduled retry marker (armAiRetry) — and clears this one itself,
      // see below — from inside its own catch, once a failure is actually
      // observed. Clearing this one eagerly leaves a crash window — an app
      // kill mid-request, before that catch runs — where neither marker
      // exists and this bookmark's first-ever enrichment attempt is lost with
      // no durable trace. Success clears it right here once settled; a
      // failure is instead cleared by requestAiEnrichment itself (once
      // armAiRetry has durably recorded the replacement bookkeeping) rather
      // than here, so a relaunch inside the backoff window goes through
      // checkAiRetries' backoff-respecting path instead of this effect
      // re-firing the request immediately on every restart.
      //
      // STASH #574 Phase 1: queue for staggered dispatch instead of firing
      // immediately, so a burst of bookmarks whose metadata settles around the
      // same time (e.g. a multi-share) doesn't fire N ai-enrich requests at
      // once. The drain effect below is what actually calls
      // requestAiEnrichment and clears this marker on success.
      aiDispatchQueueRef.current = enqueueAiEnrichmentDispatch(
        aiDispatchQueueRef.current,
        id,
      );
    }
  }, [
    bookmarks,
    auth.session,
    aiSuggestionsMode,
    requestAiEnrichment,
    clearPendingAiTrigger,
  ]);
  const { checkAiRetries, fetchAiServerQueueSnapshot } = useAiRetryLifecycle({
    auth,
    aiSuggestionsModeRef,
    queueRef,
    aiRetryState,
    aiEnriching,
    bookmarksRef,
    aiDispatchQueueRef,
    requestAiEnrichment,
    checkAiRetriesRef,
    setAiQuotaExceeded,
    aiDispatchInFlight,
    aiQuotaCooldownUntil,
    bulkReconcileInFlight,
    aiDispatchEpoch,
    clearPendingAiTrigger,
    aiBurstTokenSeq,
    setAiEnrichmentBurstToast,
    bookmarks,
    aiServerQueued,
    persistAiServerQueued,
    syncAiServerQueuedIds,
    setAiServerQueueSnapshot,
  });

  // Background sync: upload as soon as auth and local data are ready, and
  // whenever a new pending entry appears. Eligible failed entries retry on a
  // later save or scheduled wake-up once their own backoff elapses. Auth,
  // permission, and exhausted ordinary failures require manual recovery
  // (syncNow({ force: true }), which bypasses backoff), not in a hot loop.
  //
  // `signed_out` is deliberately EXCLUDED here: with no session, syncNow can't
  // run, and re-triggering it on every render would hot-loop. The lazy-mint
  // effect below bridges the gap — once it mints an anonymous session, auth
  // flips to `anonymous` and this effect takes over with the queued work.
  const syncDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current);
        syncDebounceTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const isSyncNeeded =
      !offline &&
      !isSyncingState &&
      bookmarks !== null &&
      (auth.status === "anonymous" || auth.status === "authenticated") &&
      // 'syncing' is included so an entry an interrupted run stranded in-flight
      // is re-driven automatically; failed entries wait for a save / Sync now.
      (queue.some((entry) => {
        if (
          entry.sync_status !== "pending" &&
          entry.sync_status !== "syncing"
        ) {
          return false;
        }
        if (!isSyncable(entry)) {
          return false;
        }
        if (entry.operation === "create") {
          // Defer only this create while its metadata fetch is still in flight.
          // Other ready creates can start the debounce window and syncNow will
          // still filter any pending-metadata rows before upload.
          const bookmark = bookmarksRef.current?.find(
            (b) => b.id === entry.local_id,
          );
          if (bookmark && bookmark.metadata_status === "pending") {
            return false;
          }
        }
        return true;
      }) ||
        pendingImportCollections.some(
          (item) =>
            item.status === "pending" && hasSyncedOnce(item.bookmark_id),
        ) ||
        // #671: the enrichment-restore outbox needs the same re-arm once its
        // bookmark's own create clears the queue above — otherwise a restore
        // queued alongside a collection-less import (no other pending work)
        // never gets a follow-up syncNow pass to actually upload.
        pendingEnrichmentRestores.some(
          (item) =>
            item.status === "pending" && hasSyncedOnce(item.bookmark_id),
        ));

    if (isSyncNeeded) {
      if (!syncDebounceTimerRef.current) {
        setIsSyncDebounceActive(true);
        syncDebounceTimerRef.current = setTimeout(() => {
          syncDebounceTimerRef.current = null;
          setIsSyncDebounceActive(false);
          // Deliberately syncNowRef, not the `syncNow` captured when the timer
          // was armed. The window exists precisely so more work can arrive
          // during it, and every such arrival recreates syncNow (queue is one
          // of its deps) — the captured closure would upload a snapshot taken
          // before the batch it is supposed to be batching. Worse, a sign-in or
          // account switch landing in the window recreates it around the NEW
          // session, so the stale closure would run a full upload+pull under
          // the previous account's session. The ref is reassigned every render,
          // so it always holds the current queue and session.
          void syncNowRef.current?.().catch(() => { });
        }, METADATA_SYNC_DEBOUNCE_MS);
      }
    } else {
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current);
        syncDebounceTimerRef.current = null;
        setIsSyncDebounceActive(false);
      }
    }
  }, [
    bookmarks,
    auth.status,
    offline,
    queue,
    pendingImportCollections,
    pendingEnrichmentRestores,
    isSyncingState,
    syncNow,
    hasSyncedOnce,
  ]);

  // Failed tag work has no bookmark queue entry to wake background sync.
  // Arm the earliest eligible deadline, including queues restored at startup.
  useEffect(() => {
    if (offline || syncPaused || isSyncingState || isResettingLibrary || bookmarks === null ||
      !auth.userId || auth.userId !== reconciledCacheUserId ||
      (auth.status !== "anonymous" && auth.status !== "authenticated")) return;
    const deadlines = pendingTagOps
      .filter((op) => !op.confirmed && (op.retry_count ?? 0) > 0 &&
        canAutomaticallyRetry(op.last_error_kind, op.retry_count ?? 0) && hasSyncedOnce(op.bookmark_id))
      .map(tagRetryReadyAt).filter(Number.isFinite);
    if (deadlines.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      // Await queued work, then let sync repair an unhealthy journal first.
      void tagOpsWriteRef.current.then(() => {
        if (!cancelled) void syncNowRef.current?.().catch(() => { });
      });
    }, Math.max(100, Math.max(Math.min(...deadlines), tagJournalRetryAt) - Date.now()));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pendingTagOps, bookmarks, offline, auth.userId, auth.status, reconciledCacheUserId,
    syncPaused, isSyncingState, isResettingLibrary, hasSyncedOnce, tagJournalRetryAt]);

  // Quiet retries must actually have a wake-up: a failed bookmark or pull can
  // otherwise wait forever for another save. Existing upload guards/backoff
  // still decide what gets attempted. Never cross account or pause boundaries.
  useEffect(() => {
    if (offline || syncPaused || isSyncingState || isResettingLibrary || bookmarks === null ||
      !auth.session || auth.userId !== reconciledCacheUserId ||
      (auth.status !== "anonymous" && auth.status !== "authenticated")) return;
    const metadataBlockedIds = new Set(bookmarks.filter((bookmark) => bookmark.metadata_status === "pending").map((bookmark) => bookmark.id));
    const deadline = nextAutomaticSyncRetryAt({
      queue: queue.filter((entry) => entry.operation !== "create" ||
        !metadataBlockedIds.has(entry.local_id)),
      runFailure: syncRunFailure,
      followups: [...pendingImportCollections, ...pendingEnrichmentRestores].filter((item) => hasSyncedOnce(item.bookmark_id)),
      now: Date.now(), legacyFollowupAttemptAt: legacyFollowupAttemptAt.current,
      legacyQueueAttemptAt: legacyFollowupAttemptAt.current,
    });
    if (deadline === null) return;
    const timer = setTimeout(() => { void syncNowRef.current?.().catch(() => { }); }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [offline, syncPaused, isSyncingState, isResettingLibrary, bookmarks, queue, syncRunFailure,
    pendingImportCollections, pendingEnrichmentRestores, auth.session, auth.userId,
    auth.status, reconciledCacheUserId, hasSyncedOnce]);

  const wasOffline = useRef(offline);
  useEffect(() => {
    const reconnected = wasOffline.current && !offline;
    wasOffline.current = offline;
    if (reconnected && !syncPausedRef.current && auth.session &&
      auth.userId === reconciledCacheUserId &&
      (auth.status === "anonymous" || auth.status === "authenticated")) {
      // Resume normal scheduling, respecting each item's retry backoff.
      void syncNowRef.current?.().catch(() => { });
    }
  }, [offline, auth.session, auth.userId, auth.status, reconciledCacheUserId]);

  // Lazy anonymous creation on the first save after logout. With lazy logout,
  // signing out leaves `auth.status === 'signed_out'` and NO session — no
  // anonymous user is minted (that was the orphaned-empty-user leak). A clean
  // logout has an empty queue, so this effect stays dormant. The first capture
  // after logout enqueues a pending entry; that's genuine user work to push, so
  // we mint the anonymous user lazily by calling ensureAnonymousSession (the
  // same call the sync path uses). It flips auth to `anonymous`, after which the
  // background-sync effect above uploads the queue normally.
  //
  // A ref guards against a hot loop: ensureAnonymousSession can fail (Supabase
  // down) and leave us in `signed_out` with the entry still pending, which would
  // otherwise re-fire this effect every render. We reset the guard whenever we
  // leave `signed_out`, so a later save (or a recovered network) tries again.
  const lazyMintInFlight = useRef(false);
  // Provenance annotations are observations, not a new save or retry signal.
  // Depend on operational queue state so annotating the first capture cannot
  // trigger another anonymous-session attempt after a failed mint.
  const lazyMintQueueKey = JSON.stringify(queue.map((entry) => [
    entry.local_id, entry.operation, entry.sync_status, entry.updated_at, entry.retry_count,
  ]));
  useEffect(() => {
    if (auth.status !== "signed_out") {
      lazyMintInFlight.current = false;
      return;
    }
    if (
      lazyMintInFlight.current ||
      bookmarks === null ||
      !queueRef.current.some(
        (entry) =>
          entry.sync_status === "pending" || entry.sync_status === "syncing",
      )
    ) {
      return;
    }
    lazyMintInFlight.current = true;
    void auth
      .ensureAnonymousSession()
      .then((session) => {
        // Leave the guard SET on success (a real session was minted): auth will
        // flip out of `signed_out`, and the branch above clears the guard. If the
        // call resolved to null (no session minted, e.g. not configured), clear
        // the guard so a later save retries instead of being stuck forever.
        if (!session) {
          lazyMintInFlight.current = false;
        }
      })
      .catch((error) => {
        // Mint failed (network/Supabase down): reset the guard so the next save
        // can retry. We don't re-fire here — the entry is still pending and a
        // later save re-triggers this effect (bounded, no hot loop).
        lazyMintInFlight.current = false;
        logStorageError("lazy anonymous mint", error);
      });
  }, [auth, bookmarks, lazyMintQueueKey]);

  // Pull on first ready, and again whenever the signed-in user changes —
  // including the anonymous → real upgrade at sign-in and an account switch.
  // Runs even with an empty queue so remote changes (other devices, cloud AI
  // enrichment) reach this device. Keying off the user id (not a one-shot flag)
  // is what makes a sign-in pull the account's existing cloud data right away:
  // the startup pass already fired for the auto-created anonymous user, and the
  // background-sync effect only fires when there is queued work — so without
  // this, a reinstall-then-sign-in would show an empty library until the next
  // cold start.
  useEffect(() => {
    if (
      !isSyncing &&
      bookmarks !== null &&
      auth.userId !== null &&
      (auth.status === "anonymous" || auth.status === "authenticated") &&
      (lastSyncedUserId.current !== auth.userId || (!offline && !syncPaused && authRecoveryPendingRef.current))
    ) {
      // Only claim this user as synced once we can actually start — otherwise a
      // sign-in landing mid-flight (the startup anonymous sync still running)
      // would set the ref and then syncNow() would early-return on its in-flight
      // guard, and with the ref already matching, the effect would never retry.
      // Gating on isSyncing makes the effect re-run when the in-flight sync
      // settles, so the new user's pull still fires.
      if (lastSyncedUserId.current === auth.userId) {
        // Credential recovery must not reset this same account's AI quota.
        void syncNow();
        return;
      }
      lastSyncedUserId.current = auth.userId;
      // Codex review (PR #655): a quota cooldown armed for the PREVIOUS
      // account must not throttle this one's independent AI quota — each
      // account has its own per-user rate limit server-side, so a leftover
      // cooldown here would block up to 30 minutes of a new account's AI
      // work for no reason.
      aiQuotaCooldownUntil.current = 0;
      setAiQuotaExceeded(null);
      // Reset before re-fetching: a stale total from the PREVIOUS account
      // must never leak into this one's display, even for the instant before
      // the new account's own fetch resolves (`processingStats.diagnostics.ai`
      // treats `null` as "nothing extra known yet", so this can't undercount
      // either — same reasoning as the aiQuotaExceeded reset just above).
      setAiServerQueueSnapshot(null);
      void fetchAiServerQueueSnapshot();
      void syncNow();
    }
  }, [
    bookmarks, offline, syncPaused,
    auth.userId,
    auth.status,
    isSyncing,
    syncNow,
    fetchAiServerQueueSnapshot,
  ]);

  // Codex review, PR #664: the account-switch clear above only fires when a
  // NEW user id shows up. Two cases it misses, both cleared independently
  // here:
  //  - Sign-out or session expiry (auth.session -> null, with no replacement
  //    session minted yet) — the drain-loop interval that otherwise expires
  //    this on its own timer stops entirely while there's no session, so a
  //    departed account's quota state would otherwise stay on display
  //    indefinitely.
  //  - Linking an anonymous account to a real one preserves the SAME user id
  //    while swapping the session's `is_anonymous` flag false — the
  //    account-switch effect never fires (no id change), so a stale
  //    "exceeded" state from the old anonymous caps (10/hr, 50/day) would
  //    otherwise linger even though the just-linked real account has much
  //    higher limits (30/hr, 500/day) and the old quota's premise no longer
  //    applies.
  useEffect(() => {
    // `null` means "no current session at all" — kept distinct from a real
    // session's anonymity (never collapsed into it) so the 429 guard below
    // can tell "nothing to compare against" apart from "compares equal by
    // coincidence" (Codex review round 3: coalescing this to `false` let a
    // late 429 through with no live session to even own the result). A
    // session's own `is_anonymous !== false` mirrors this file's existing
    // convention elsewhere (e.g. `isAnonymous: sessionUser.is_anonymous !==
    // false`) — undefined is treated as anonymous, not as "not anonymous".
    const isAnonymousNow = auth.session
      ? auth.session.user.is_anonymous !== false
      : null;
    const linkedToReal =
      wasAnonymousRef.current === true && isAnonymousNow === false;
    wasAnonymousRef.current = isAnonymousNow;
    if (!auth.session || linkedToReal) {
      setAiQuotaExceeded(null);
    }
  }, [auth.session]);

  // Logout cache-clear: with lazy anonymous creation, logout mints no new user
  // and runs no sync, so the just-logged-out real account's bookmarks would
  // linger in the local cache — stale, and visible to the next anonymous user
  // on the device (a privacy leak). On the `signed_out` transition we drop all of
  // that account's cloud-identity rows (safe: they live in the real account's
  // cloud) AND their queued update/delete ops, then reset the synced-user meta +
  // pull watermark so the next session re-syncs cleanly from scratch.
  //
  // Capture is sacred: the account-transition "drop" machinery only touches rows
  // with a remote identity. Never-synced LOCAL captures (local-* ids) are LEFT in
  // place — they have never reached any cloud account, so dropping them would
  // destroy not-yet-uploaded user data; they carry no other account's identity
  // and will upload under whatever account the next save mints. A pending EDIT to
  // an already-synced cloud bookmark IS dropped along with its queued op: the
  // bookmark is safe in the departing account's cloud, and keeping the op would
  // strand it under the next (different) identity — RLS/404 → silent loss.
  useEffect(() => {
    if (auth.status !== "signed_out") {
      // Left the signed_out state (a new session was minted): re-arm so the
      // next logout clears again.
      loggedOutCleared.current = false;
      return;
    }
    if (bookmarks === null || loggedOutCleared.current) {
      return;
    }
    loggedOutCleared.current = true;
    // Reset the pull effect's guard so the next user (lazily minted) triggers a
    // fresh pull rather than being treated as "already synced".
    lastSyncedUserId.current = null;
    // The departed real account's server-side backlog total must not linger
    // and be misread as the next (different) session's — null it out now
    // rather than waiting for that next session's own account-switch effect
    // to fire (there's a real gap here: no session at all until the lazy
    // mint below completes).
    setAiServerQueueSnapshot(null);
    void (async () => {
      try {
        await ensureRepositoryReady();
        const plan = planLogoutCacheClear(bookmarksRef.current ?? []);
        await serializeTagWork(() => applyAccountTransition(
          plan,
          repository,
          setBookmarks,
          setQueue,
          makeBookmarkId,
          ensureRepositoryReady,
          {
            // P1, round 8: plan.rehome can now be non-empty here too (a
            // local-only image row whose upload landed but whose create was
            // never confirmed — see staleUploadedImageRows). Without this,
            // applyAccountTransition's rehome branch re-keys nothing —
            // idAliases, pending tag ops, pending import collections,
            // pending enrichment restores, tag links, and AI-retry
            // bookkeeping all stay pointed at the OLD (now-deleted) id,
            // stranding any pending work queued against this row. Same
            // helper the account-transition caller already uses below.
            rehome: (idMap) => rekeyBookmarkIdentity(idMap, { persist: false, carryTags: true, serialized: true }),
            drop: (ids) => {
              // Purge the logged-out account's pending tag ops + links so they
              // can't leak into the next session's UI or upload under it.
              applyTagOps(
                dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, ids),
              );
              applyPendingImportCollections(
                dropPendingImportCollections(
                  pendingImportCollectionsRef.current,
                  ids,
                ),
              );
              applyPendingEnrichmentRestores(
                dropPendingEnrichmentRestores(
                  pendingEnrichmentRestoresRef.current,
                  ids,
                ),
              );
              const dropped = new Set(ids);
              const links = tagDataRef.current.bookmarkTags.filter(
                (link) => !dropped.has(link.bookmark_id),
              );
              applyTagData({ ...tagDataRef.current, bookmarkTags: links });
              // Purge the logged-out account's AI-suggestion bookkeeping too,
              // so it can't keep firing requestAiEnrichment against its
              // bookmark ids under the next (different) session.
              dropAiRetryBookkeeping(ids);
              // Same reasoning as the real A→real B switch above: zero the
              // settled count unconditionally (dropAiRetryBookkeeping's
              // per-id filter only does this when something was actually
              // pending) without touching .pending itself, and bump the
              // epoch so a dispatch still in flight from the logged-out
              // account can't settle into the next session's burst (#691).
              aiDispatchQueueRef.current = clearBurstCompletion(
                aiDispatchQueueRef.current,
              );
              aiDispatchEpoch.current += 1;
            },
          },
        ));
        // Reset the synced-user meta + watermark so the next session does a full
        // refresh (planAccountTransition + pullRemoteChanges read these). Empty
        // strings read back as falsy/null in both call sites.
        await repository.setMeta(CACHE_OWNER_KEY, "");
        await repository.setMeta(SYNCED_USER_ID_KEY, "");
        await repository.setMeta(SYNCED_USER_ANON_KEY, "");
        await repository.setMeta(LAST_PULLED_AT_KEY, "");
        setLastPulledAt(null);
      } catch (error) {
        logStorageError("logout cache clear", error);
      }
    })();
  }, [
    auth.status,
    bookmarks,
    applyPendingImportCollections,
    applyPendingEnrichmentRestores,
    applyTagOps,
    applyTagData,
  ]);

  // Everything the Settings screen shows about background work — the
  // mutually-exclusive user-facing stages AND the raw, overlapping
  // Developer-mode diagnostics — comes out of this single computation, so the
  // two views can never drift out of sync with each other (they used to be
  // two independently-computed objects). The AI trigger/dispatch/retry/
  // server-queue union math (Codex review, PR #655/#670: dedup by bookmark id
  // rather than adding set sizes, so a bookmark present in more than one set
  // isn't double-counted, and an in-flight AUTOMATIC request doesn't vanish
  // the instant local dispatch freezes) now lives in `buildProcessingStats`
  // itself, fed by the same trigger/dispatch/retry/server-queue/in-flight
  // sets passed in below.
  const processingStats = useMemo(() => {
    const list = bookmarks ?? [];
    const syncTodo = queue.filter((entry) => isSyncable(entry)).length;
    const syncDone = list.filter((b) => isBookmarkSyncedOnce(b)).length;

    // A bookmark is "syncing twice" if it has already synced once but has a pending update mutation in the queue.
    const syncingTwiceIds = new Set(
      queue
        .filter((entry) => entry.operation === "update" && isSyncable(entry))
        .map((entry) => entry.local_id),
    );
    const syncingTwice = list.filter(
      (b) => isBookmarkSyncedOnce(b) && syncingTwiceIds.has(b.id),
    ).length;
    const syncedOnce = Math.max(0, syncDone - syncingTwice);

    return buildProcessingStats({
      bookmarks: list,
      queue,
      enrichments,
      pendingAiTriggerIds: pendingAiTrigger.current,
      aiDispatchIds: new Set(aiDispatchQueueRef.current.pending),
      aiRetryIds,
      aiInFlightIds: enrichingIds,
      locallyConfirmedServerAiIds: aiServerQueuedIds,
      serverAiQueue: aiServerQueueSnapshot ?? [],
      permanentlyUnsyncableIds: new Set(
        queue
          .filter((entry) => isPermanentlyUnsyncableUrl(entry))
          .map((entry) => entry.local_id),
      ),
      syncDiagnostics: { todo: syncTodo, done: syncDone, syncedOnce, syncingTwice },
    });
  }, [
    bookmarks,
    queue,
    enrichments,
    aiRetryIds,
    enrichingIds,
    aiServerQueuedIds,
    aiServerQueueSnapshot,
  ]);

  // Queue/progress-only changes rebuild the context value during sync. Keep
  // these library projections stable unless bookmarks actually changed, so
  // the Inbox does not repeat its O(library) facet/search/sort pipeline for an
  // unrelated sync-status render (the hot `react-cycle` path in STASH-K).
  const inbox = useMemo(
    () =>
      loadedBookmarks
        .filter((bookmark) => isActiveBookmark(bookmark))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [loadedBookmarks],
  );
  const trash = useMemo(
    () =>
      loadedBookmarks
        .filter((bookmark) => bookmark.deleted_at != null)
        .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? "")),
    [loadedBookmarks],
  );

  const getBookmarkProcessing = useCallback((bookmarkId: string) => {
    const resolvedId = resolveAliasedId(bookmarkId, idAliases.current);
    const bookmark = bookmarksRef.current?.find((item) => item.id === resolvedId);
    if (!bookmark) return undefined;
    const entry = queueRef.current.find((item) => item.local_id === resolvedId);
    const retryAt = entry?.sync_status === "failed" && entry.last_attempt_at
      ? Date.parse(entry.last_attempt_at) + uploadRetryBackoffMs(entry) : null;
    const retry = aiRetryState.current[resolvedId];
    return buildBookmarkProcessingSnapshot({
      bookmark, queue: entry, localOnly: isLocalOnlyBookmark(bookmark),
      syncedOnce: isBookmarkSyncedOnce(bookmark), authStatus: auth.status,
      hasSession: Boolean(auth.session) && (auth.status === "anonymous" || auth.status === "authenticated"), syncPaused: syncPausedRef.current,
      isSyncing, lastPulledAt, retryEligibleAt: retryAt !== null && Number.isFinite(retryAt) ? retryAt : null,
      permanentlyUnsyncable: Boolean(entry && isPermanentlyUnsyncableUrl(entry)),
      refreshing: previewRefreshingIds.has(resolvedId),
      triggerPending: pendingAiTrigger.current.has(resolvedId),
      dispatchPending: aiDispatchQueueRef.current.pending.includes(resolvedId),
      inFlight: aiEnriching.current.has(resolvedId),
      aiRetry: retry ? { ...retry, eligibleAt: Date.parse(retry.lastAttemptAt) + (AI_RETRY_BACKOFF_MS[retry.attemptCount] ?? 0) } : null,
      confirmedServerQueued: aiServerQueued.current.has(resolvedId),
      serverQueue: aiServerQueueSnapshot?.find((item) => item.bookmark_id === resolvedId) ?? null,
      serverQueueObserved: aiServerQueueSnapshot !== null,
      aiMode: aiSuggestionsMode, quota: aiQuotaExceeded,
      enrichment: enrichmentsRef.current.find((item) => item.bookmark_id === resolvedId),
      tagUploads: pendingTagOpsRef.current.filter((op) => op.bookmark_id === resolvedId).map((op) => ({
        operation: op.op, source: op.source, confirmed: op.confirmed === true,
        retries: op.retry_count ?? 0, errorKind: op.last_error_kind ?? null,
      })),
      importFolderPending: pendingImportCollectionsRef.current.some((item) => item.bookmark_id === resolvedId),
      now: Date.now(),
    });
  }, [auth.status, auth.session, isSyncing, lastPulledAt, previewRefreshingIds,
    aiServerQueueSnapshot, aiSuggestionsMode, aiQuotaExceeded]);

  const accountLibraryState = auth.status === "authenticated" &&
    (hideAccountCache || loadedAccountUserId !== auth.userId)
      ? accountLibraryFailureUserId === auth.userId ? "error" : "checking"
      : "ready";
  const accountTransferCount = accountTransfer?.userId === auth.userId ? accountTransfer.count : 0;

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      loadError,
      accountLibraryState,
      accountTransferCount,
      dismissAccountTransfer,
      inbox,
      trash,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      getBookmarkProcessing,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      resetLibrary,
      isResettingLibrary,
      processingStats,
      librarySyncFlow,
      aiQuotaExceeded,
      updateBookmarkFields,
      markBookmarkAccessed,
      checkVideoAvailability,
      deleteBookmark,
      isSyncing,
      syncNow,
      syncPaused,
      setSyncPaused,
      lastPulledAt,
      collections: tagData.collections,
      tags: tagData.tags,
      addTagsToBookmark,
      addTagsToBookmarks,
      removeTagFromBookmark,
      requestAiEnrichment,
      aiSuggestionsMode,
      setAiSuggestionsMode,
      aiEnrichmentBurstToast,
      dismissAiEnrichmentBurstToast,
      refreshBookmarkPreview,
      isRefreshingPreview,
      isEnriching,
      isManuallyEnriching,
      isAiSuggestionPostponed,
      isAiSuggestionServerQueued,
      hadPriorEnrichmentAttempt,
      acceptSuggestedTags,
      getReviewedSuggestions,
      markSuggestionsReviewed,
      clearReviewedSuggestions,
      getDismissedFolderSuggestions,
      dismissFolderSuggestion,
      clearDismissedFolderSuggestions,
      getReviewedSummary,
      markSummaryReviewed,
      clearReviewedSummary,
      unseenSuggestionIds,
      markSuggestionsSeen,
      clearUnseenSuggestions,
      assignCollection,
      createCollection,
      renameCollection,
      deleteCollection,
      deleteCollections,
      mergeCollections,
    }),
    [
      bookmarks,
      loadError,
      accountLibraryState,
      accountTransferCount,
      dismissAccountTransfer,
      inbox,
      trash,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      getBookmarkProcessing,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      resetLibrary,
      isResettingLibrary,
      processingStats,
      librarySyncFlow,
      aiQuotaExceeded,
      updateBookmarkFields,
      markBookmarkAccessed,
      checkVideoAvailability,
      deleteBookmark,
      isSyncing,
      syncNow,
      syncPaused,
      setSyncPaused,
      lastPulledAt,
      tagData.collections,
      tagData.tags,
      addTagsToBookmark,
      addTagsToBookmarks,
      removeTagFromBookmark,
      requestAiEnrichment,
      aiSuggestionsMode,
      setAiSuggestionsMode,
      aiEnrichmentBurstToast,
      dismissAiEnrichmentBurstToast,
      refreshBookmarkPreview,
      isRefreshingPreview,
      isEnriching,
      isManuallyEnriching,
      isAiSuggestionPostponed,
      isAiSuggestionServerQueued,
      hadPriorEnrichmentAttempt,
      acceptSuggestedTags,
      getReviewedSuggestions,
      markSuggestionsReviewed,
      clearReviewedSuggestions,
      getDismissedFolderSuggestions,
      dismissFolderSuggestion,
      clearDismissedFolderSuggestions,
      getReviewedSummary,
      markSummaryReviewed,
      clearReviewedSummary,
      unseenSuggestionIds,
      markSuggestionsSeen,
      clearUnseenSuggestions,
      assignCollection,
      createCollection,
      renameCollection,
      deleteCollection,
      deleteCollections,
      mergeCollections,
    ],
  );

  // Keep account data hidden through expiry and an unresolved account switch.
  // Fresh local captures remain usable, including duplicate capture lookups.
  const visibleValue = useMemo<BookmarksContextValue>(() => {
    if (!hideAccountCache) return value;
    const visibleRows = loadedBookmarks.filter((row) => !isBookmarkSyncedOnce(row));
    const ids = new Set(visibleRows.map((row) => row.id));
    const collectionIds = new Set(visibleRows.map((row) => row.collection_id));
    return {
      ...value,
      inbox: value.inbox.filter((row) => ids.has(row.id)),
      trash: value.trash.filter((row) => ids.has(row.id)),
      collections: value.collections.filter((row) => collectionIds.has(row.id)),
      getBookmark: (id) => { const row = value.getBookmark(id); return row && ids.has(row.id) ? row : undefined; },
      getTagsForBookmark: (id) => ids.has(id) ? value.getTagsForBookmark(id) : [],
      getCollection: (id) => collectionIds.has(id) ? value.getCollection(id) : undefined,
      getEnrichment: (id) => ids.has(id) ? value.getEnrichment(id) : undefined,
    };
  }, [hideAccountCache, loadedBookmarks, value]);

  return (
    <BookmarksContext.Provider value={visibleValue}>
      {children}
    </BookmarksContext.Provider>
  );
}

export function useBookmarks() {
  const context = useContext(BookmarksContext);
  if (!context) {
    throw new Error("useBookmarks must be used within a BookmarksProvider");
  }
  return context;
}
