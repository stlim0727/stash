import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import Constants from "expo-constants";
import { Platform } from "react-native";

import { resolveAliasedId } from "@/domain/bookmark-id-swap";
import { mockUserId } from "@/domain/mock-data";
import { canonicalizeUrl, isUrlTooLong, normalizeUrl } from "@/domain/urls";
import { createConcurrencyLimiter } from "@/domain/concurrency";
import { enrichBookmark } from "@/domain/enrichment";
import { checkYoutubeAvailability, isYoutubeAvailabilityCandidate } from "@/domain/page-metadata";
import { isTransientNetworkError } from "@/domain/network-errors";
import { jwtSubject } from "@/domain/jwt";
import { planTitleBackfill } from "@/domain/title-backfill";
import type { TitleBackfillPatch } from "@/domain/title-backfill";
import {
  imageTitleFromFileName,
  localImageFileName,
  type SharedImage,
} from "@/domain/image-share";
import type { ImportItem } from "@/domain/import";
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  LocalPendingBookmark,
  MetadataStatus,
  SuggestedTag,
  Tag,
} from "@/domain/types";
import { sanitizeTagData } from "@/domain/tag-data";
import { tagSlug } from "@/domain/tag-input";
import {
  addDismissedFolderToken,
  addReviewedNames,
  addReviewedSummaryToken,
  dismissedFolderTokensFor,
  pendingSuggestedFolder,
  pendingSummary,
  pendingSuggestions,
  reviewedNamesFor,
  reviewedSummaryTokensFor,
  suggestedFolderTokens,
} from "@/domain/ai-suggestions";
import { acceptSuggestionBundle } from "@/domain/suggestion-actions";
import {
  AI_SUGGESTIONS_MODE_PREF_KEY,
  DEFAULT_AI_SUGGESTIONS_MODE,
  parseAiSuggestionsMode,
  serializeAiSuggestionsMode,
  type AiSuggestionsMode,
} from "@/domain/ai-suggestions-pref";
import {
  AI_ENRICHMENT_BURST_TOAST_MIN,
  AI_ENRICHMENT_DISPATCH_STAGGER_MS,
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  clearBurstCompletion,
  dequeueAiEnrichmentDispatch,
  dropAiEnrichmentDispatchIds,
  enqueueAiEnrichmentDispatch,
  isBurstComplete,
  recordAiEnrichmentDispatchSettled,
  remapAiEnrichmentDispatchIds,
  type AiEnrichmentBurstQueue,
} from "@/domain/ai-enrichment-burst";
import { parseStringSetMap } from "@/domain/string-set-map";
import type { StringSetMap } from "@/domain/string-set-map";
import {
  buildProcessingStats,
  type AiServerQueueSnapshot,
  type ProcessingStats,
} from "@/domain/processing-status";
import {
  applyPendingTagOps,
  applyTagOp,
  dequeueTagOp,
  dropPendingTagOpsForBookmarks,
  enqueueTagOp,
  reconcileSyncedAdd,
  rekeyPendingTagOps,
  type PendingTagOp,
} from "@/domain/pending-tags";
import {
  PENDING_IMPORT_COLLECTIONS_KEY,
  dropPendingImportCollections,
  enqueuePendingImportCollection,
  parsePendingImportCollections,
  rekeyPendingImportCollections,
  type PendingImportCollection,
} from "@/domain/pending-import-collections";
import {
  PENDING_ENRICHMENT_RESTORE_KEY,
  dropPendingEnrichmentRestores,
  enqueuePendingEnrichmentRestore,
  parsePendingEnrichmentRestores,
  rekeyPendingEnrichmentRestores,
  type PendingEnrichmentRestore,
} from "@/domain/pending-enrichment-restore";
import { useI18n } from "@/i18n";
import { recordLog } from "@/observability/log-buffer";
import { armHydrationWatchdog } from "@/observability/hydration-watchdog";
import { armLoopStallWatchdog } from "@/observability/loop-stall-watchdog";
import {
  describeRecentSegments,
  recordSlowSegment,
} from "@/observability/slow-segment-log";
import {
  reportQueueReconcileMismatch,
  reportSyncQueueHealthEscalation,
} from "@/observability/sentry";
import { registerForForegroundState } from "@/storage/sqlite-app-lifecycle";
import { repository } from "@/storage/repository";
import { copyImageToLibrary } from "@/storage/image-store";
import type {
  BulkAttachItem,
  BulkAttachResult,
  EnrichmentMetadataHint,
} from "@/api/bookmarks";
import type {
  CreateSyncCompletion,
  IdentityRekeyState,
  TagData,
} from "@/storage/types";
import { useSupabaseAuth } from "@/supabase/auth-provider";
import { useRealtimeSync } from "@/supabase/realtime";
import { SupabaseRequestError, createSupabaseClient } from "@/supabase/client";
import { trackSyncStatus } from "@/supabase/sync-status-tracker";
import type { SupabaseAuthSession } from "@/supabase/types";
import {
  applyAccountTransition,
  planAccountTransition,
  planLogoutCacheClear,
} from "@/sync/account-transition";
import {
  LAST_PULLED_AT_KEY,
  SYNCED_USER_ANON_KEY,
  SYNCED_USER_ID_KEY,
  pullRemoteChanges,
} from "@/sync/pull-bookmarks";
import {
  BULK_CREATE_SYNC_CHUNK_SIZE,
  createNeedsReconcileUpdate,
  createSyncApi,
  crossedHealthEscalationThreshold,
  findStaleQueueEntries,
  hasBulkCreateResultKey,
  hasRemoteIdentity,
  isPermanentlyUnsyncableUrl,
  isRowSpecificPermanentSyncErrorText,
  isSyncable,
  makeMutationEntry,
  reconcileOrphanedQueueEntries,
  removeQueueEntryIfNotSuperseded,
  syncCreateQueueEntryBatch,
  syncQueueEntry,
} from "@/sync/sync-bookmarks";
import {
  recordBulkChunkStarted,
  recordCreateCompleted,
  recordReconcileNeeded,
} from "@/sync/reconcile-diagnostics";

export function isBookmarkSyncedOnce(bookmark: Bookmark): boolean {
  return (
    hasRemoteIdentity(bookmark.id) &&
    (bookmark.sync_status === "synced" || bookmark.ever_synced === true)
  );
}

export type AddBookmarkResult =
  | {
      status: "created" | "duplicate";
      bookmark: Bookmark;
      /**
       * Resolves once the optimistic save has been flushed to durable storage:
       * `true` when it was written, `false` when the write failed (the row then
       * survives only in optimistic React state + the in-memory queue). It never
       * rejects — storage errors are logged. Callers that tear the app down right
       * after a capture (e.g. the share handler backgrounding the app on Android)
       * MUST await this and only proceed on `true`, so a capture is never lost to
       * an in-flight or failed SQLite write. Capture is sacred.
       */
      persisted: Promise<boolean>;
    }
  | {
      status: "invalid";
      error: string;
      /** Coarse, i18n-free reason code for the UI layer to pick a localized
       *  message when the raw `error` string (English-only, matching this
       *  store's existing i18n-free convention) isn't specific enough — e.g.
       *  a toast-only caller that doesn't display `error` directly. */
      reason?: "too_long";
    };

/** Outcome of a full library reset (issue #600). */
export type ResetLibraryResult =
  | { ok: true }
  /**
   * - 'busy': a sync (or another reset) is in flight — try again when it settles.
   * - 'auth': no signed-in session, so there is no cloud library to reset.
   * - 'remote': the server-side wipe failed; nothing was changed locally.
   * - 'local': the server wipe SUCCEEDED but clearing this device failed —
   *   the cloud is already empty, so the explicit recovery is to retry the
   *   reset (the RPC is idempotent) until the local clear lands.
   */
  | {
      ok: false;
      reason: "busy" | "auth" | "remote" | "local";
      message?: string;
    };

/** Outcome counts from re-ingesting an imported file. */
export interface ImportSummary {
  /** Bookmarks newly added to the library. */
  imported: number;
  /** Items skipped because their URL already exists in the library. */
  duplicates: number;
  /** Items skipped for lacking a usable URL (e.g. text-only saves). */
  skipped: number;
  /**
   * Set when nothing was processed because the library hasn't finished its
   * initial load/sync yet (Sentry STASH-3K/3M): dedup reads the in-memory
   * bookmark list, which is incomplete until then, so every item — including
   * ones already in the (not-yet-loaded) library — would durably re-create as
   * a fresh duplicate. The caller should ask the user to retry shortly.
   */
  notReady?: boolean;
}

interface BookmarksContextValue {
  /** True until the durable store has been read on startup. */
  isLoading: boolean;
  /** Set when the durable store failed to load and in-memory fallback is used. */
  loadError: boolean;
  /** Active (non-trashed) bookmarks, newest first. */
  inbox: Bookmark[];
  /** Trashed bookmarks, most recently trashed first. */
  trash: Bookmark[];
  /** Offline sync queue, oldest first — exposed for inspection until sync exists. */
  queue: LocalPendingBookmark[];
  getBookmark: (id: string) => Bookmark | undefined;
  getTagsForBookmark: (id: string) => Tag[];
  getCollection: (id: string | null) => Collection | undefined;
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  /** Local-first creation: the bookmark is visible immediately with pending states. */
  addBookmark: (input: {
    url?: string;
    title?: string;
    notes?: string;
    /** Shared text with no usable URL — saved as a text note. */
    shared_text?: string;
    /** A shared image to capture as an image bookmark (local-only for now). */
    image?: SharedImage;
  }) => AddBookmarkResult;
  /**
   * Re-ingest items parsed from an imported file. Local-first like addBookmark:
   * each URL is added with pending states, deduped against the existing library
   * (and within the batch). Parsed tags are queued through the existing tag
   * outbox; collection names use a restartable post-create assignment outbox.
   * Returns a count summary.
   */
  importBookmarks: (items: ImportItem[]) => ImportSummary;
  /** Move a bookmark to the trash (soft delete). */
  trashBookmark: (id: string) => void;
  /** Restore a trashed bookmark back to the inbox. */
  restoreBookmark: (id: string) => void;
  /** Permanently delete all trashed bookmarks. */
  emptyTrash: () => void;
  /**
   * Destructive, online-only library reset (issue #600): wipe the current
   * account's cloud data in one server-side RPC, then clear all local library
   * state (bookmarks, sync queue, tag/collection cache, enrichments, AI
   * bookkeeping, pull watermark) so stale queued work can never re-upload the
   * just-deleted data. Requires a signed-in session; local state is only
   * cleared after the remote wipe succeeds.
   */
  resetLibrary: () => Promise<ResetLibraryResult>;
  /** True while a library reset is running — disable import/sync/reset UI. */
  isResettingLibrary: boolean;
  /** Edit a bookmark's title/notes. Local-first; empty strings clear the field. */
  updateBookmarkFields: (
    id: string,
    fields: { title?: string; notes?: string },
  ) => void;
  /**
   * Record that the user opened a bookmark (viewed Detail or opened its link),
   * setting its local-only `last_accessed_at`. Powers the "Recently opened"
   * sort. Never synced and never bumps `updated_at`.
   */
  markBookmarkAccessed: (id: string) => void;
  /**
   * On-demand check (STASH-61) of whether a saved YouTube video is still
   * available, via its oEmbed endpoint. Pass the bookmark's current `url`
   * (the caller's own render-time value, not re-derived from the store) —
   * no-op for a non-YouTube URL or null. Sets the local-only, self-healing
   * `video_unavailable` flag; never synced and never bumps `updated_at`.
   * Fire-and-forget — call once per Detail screen open, never as background
   * polling of the whole library.
   */
  checkVideoAvailability: (id: string, url: string | null | undefined) => void;
  /** Permanently remove a bookmark and any pending queue entry for it. */
  deleteBookmark: (id: string) => void;
  /** True while the background sync service is uploading queue entries. */
  isSyncing: boolean;
  /**
   * Upload pending/failed queue entries to Supabase. No-op without auth.
   * `{ force: true }` (the Settings "Sync now" tap) bypasses a failed
   * entry's retry backoff for this one pass; every other caller (auto-sync,
   * realtime, a save) must omit it so the backoff actually throttles
   * automatic retries — see `isSyncable`'s `ignoreBackoff` option.
   */
  syncNow: (options?: { force?: boolean }) => Promise<boolean>;
  /** True while sync is manually paused: syncNow no-ops (no upload, no pull)
   *  until this is turned back off. Lets a bulk import be reviewed — and
   *  unwanted rows deleted — before anything reaches the network. */
  syncPaused: boolean;
  /** Pause or resume sync. Turning it off immediately flushes anything queued. */
  setSyncPaused: (paused: boolean) => void;
  /** When the last successful pull from Supabase completed, if ever. */
  lastPulledAt: string | null;
  /** The user's cloud collections (assignable; refreshed by pull sync). */
  collections: Collection[];
  /** Add tags to a synced bookmark. Resolves to an error message, or null. */
  addTagsToBookmark: (
    bookmarkId: string,
    names: string[],
  ) => Promise<string | null>;
  /** Remove a tag from a synced bookmark. Resolves to an error message, or null. */
  removeTagFromBookmark: (
    bookmarkId: string,
    tagName: string,
  ) => Promise<string | null>;
  /** Generate AI suggestions for a synced bookmark. Resolves to an error, or
   *  null. `source` defaults to 'manual' (an explicit user tap); the deferred
   *  post-capture auto-trigger passes 'auto' so the UI can stay silent for work
   *  the user never asked to wait on. */
  requestAiEnrichment: (
    bookmarkId: string,
    source?: "auto" | "manual",
  ) => Promise<string | null>;
  /** The user's AI-suggestions mode (STASH #573): 'off' skips the automatic
   *  enrichment trigger entirely (manual "Suggest with AI" still works),
   *  'confirm' is today's existing review-badge behavior (the default), and
   *  'auto_accept' applies high-confidence suggestions with no review step. */
  aiSuggestionsMode: AiSuggestionsMode;
  /** Change + durably persist the AI-suggestions mode. */
  setAiSuggestionsMode: (mode: AiSuggestionsMode) => void;
  /** Set once a burst of 2+ background auto-enrichments finishes (STASH #574
   *  Phase 1) — `count` is how many settled; `token` is a monotonic id so two
   *  consecutive bursts with the same count both surface a toast. Null
   *  otherwise (including for a single, routine completion — not a "burst"). */
  aiEnrichmentBurstToast: { count: number; token: number } | null;
  /** Clear `aiEnrichmentBurstToast` once its toast has been shown. */
  dismissAiEnrichmentBurstToast: () => void;
  /** Re-fetch generated page preview metadata for a URL bookmark. */
  refreshBookmarkPreview: (bookmarkId: string) => Promise<string | null>;
  /** True while a user-initiated preview refresh is in flight for this bookmark. */
  isRefreshingPreview: (bookmarkId: string) => boolean;
  /** True while ANY AI request (auto or manual) is in flight for this bookmark —
   *  drives the ambient "filling in" placeholder. */
  isEnriching: (bookmarkId: string) => boolean;
  /** True only while a user-initiated ("Suggest with AI"/refresh) request is in
   *  flight — drives the explicit button feedback, so the auto-trigger never
   *  makes the section look like it's blocking on a wait. */
  isManuallyEnriching: (bookmarkId: string) => boolean;
  /** True while a bookmark has an armed AI-suggestion retry marker AND isn't
   *  currently retrying: a prior `requestAiEnrichment` call (auto or manual)
   *  failed with no enrichment written, and a backoff-scheduled retry is
   *  pending but not yet in flight. Drives a "postponed" note distinct from an
   *  in-flight or never-requested state; clears once a retry succeeds or the
   *  attempt cap is exhausted (see `AI_RETRY_MAX_ATTEMPTS`). */
  isAiSuggestionPostponed: (bookmarkId: string) => boolean;
  /** True if this bookmark's AI-enrichment 429 was CONFIRMED accepted into the
   *  server-side overflow queue (STASH #578 Phase 2, `pending_ai_enrichment`)
   *  — the background worker WILL deliver a real result via normal sync, no
   *  action needed. Independent of `isAiSuggestionPostponed`/
   *  `hadPriorEnrichmentAttempt`: those describe the LOCAL retry marker, which
   *  arms unconditionally on every failure (including this same 429) and
   *  eventually exhausts and clears after `AI_RETRY_MAX_ATTEMPTS`, at which
   *  point a rate-limited bookmark would otherwise look exactly like one that
   *  was never enriched even though the server queue entry is still alive.
   *  This flag never expires on its own — it only clears once a real
   *  enrichment actually lands (queue delivery via pull, or a later attempt
   *  succeeding directly) or the bookmark is discarded. */
  isAiSuggestionServerQueued: (bookmarkId: string) => boolean;
  /** True if a bookmark has EVER recorded a failed AI-enrichment attempt that
   *  hasn't since exhausted its retry cap — independent of whether it's
   *  currently enriching right now. Unlike {@link isAiSuggestionPostponed}
   *  (which goes false the instant a retry starts, since it's no longer
   *  "waiting"), this stays true across a retry's entire in-flight window, so
   *  the Detail screen can suppress its first-attempt-only loading shimmer for
   *  every automatic retry (a manual "Suggest with AI"/refresh tap always
   *  shows its own real-time feedback regardless of this). */
  hadPriorEnrichmentAttempt: (bookmarkId: string) => boolean;
  /** Accept AI-suggested tags (linked with source 'ai'). Resolves to an error, or null. */
  acceptSuggestedTags: (
    bookmarkId: string,
    suggestions: SuggestedTag[],
  ) => Promise<string | null>;
  /**
   * Suggestion names the user has already reviewed (accepted or dismissed) for
   * a bookmark, lowercased. Pass to `pendingSuggestions` so the "✨" badge
   * counts only *unreviewed* suggestions — accepting then removing a tag does
   * not bring the badge back.
   */
  getReviewedSuggestions: (bookmarkId: string) => Set<string>;
  /** Mark suggestion names as reviewed for a bookmark (durable). Accepting tags
   *  records this automatically; dismissing a suggestion calls it directly. */
  markSuggestionsReviewed: (bookmarkId: string, names: string[]) => void;
  /** Forget a bookmark's reviewed names so a manual AI re-run can re-surface
   *  previously-dismissed suggestions. Background sync never clears them. */
  clearReviewedSuggestions: (bookmarkId: string) => void;
  /** The folder (collection) suggestion tokens the user has dismissed for a
   *  bookmark (durable). The Detail screen filters its folder chip against this
   *  so a dismissal survives re-entering the screen. */
  getDismissedFolderSuggestions: (bookmarkId: string) => Set<string>;
  /** Record a folder suggestion (by `suggestedFolderToken`) as dismissed for a
   *  bookmark (durable). */
  dismissFolderSuggestion: (
    bookmarkId: string,
    tokens: string | string[],
  ) => void;
  /** Forget a bookmark's dismissed folder suggestions so a manual AI re-run can
   *  re-surface one. Background sync never clears them. */
  clearDismissedFolderSuggestions: (bookmarkId: string) => void;
  /** The AI-summary tokens the user has reviewed (used as a note or dismissed)
   *  for a bookmark (durable). The Detail screen filters its proposed-summary
   *  block against this so the decision survives re-entering the screen; a later
   *  enrichment with a *different* summary yields a new token and re-surfaces. */
  getReviewedSummary: (bookmarkId: string) => Set<string>;
  /** Record an AI summary (by `summaryToken`) as reviewed for a bookmark
   *  (durable). Both "use as note" and dismiss route through here. */
  markSummaryReviewed: (bookmarkId: string, token: string) => void;
  /** Forget a bookmark's reviewed summary so a manual AI re-run can re-surface
   *  it. Background sync never clears it. */
  clearReviewedSummary: (bookmarkId: string) => void;
  /**
   * Bookmark ids whose AI suggestions arrived while the user wasn't looking
   * (background auto-enrichment, a server-side trigger, or another device's
   * enrichment pulled in). Drives the Inbox "new AI suggestions" banner. An id
   * stays until the user witnesses it via {@link markSuggestionsSeen} or
   * {@link clearUnseenSuggestions}; the banner intersects this with the live
   * pending list, so an id whose suggestions were since applied stops counting.
   */
  unseenSuggestionIds: ReadonlySet<string>;
  /** Forget that a bookmark's suggestions were "new" — called when the user
   *  opens its Detail (witnesses the suggestions). Durable. */
  markSuggestionsSeen: (bookmarkId: string) => void;
  /** Clear every "new AI suggestions" marker at once — called when the user
   *  opens the Review screen (witnesses them all). Durable. */
  clearUnseenSuggestions: () => void;
  /** Move a bookmark into a collection (or out, with null). Local-first. */
  assignCollection: (bookmarkId: string, collectionId: string | null) => void;
  /** Create a cloud collection. Resolves to the collection or an error message. */
  createCollection: (
    name: string,
  ) => Promise<{ collection?: Collection; error?: string }>;
  /** Mutually-exclusive user-facing stages plus overlapping raw diagnostic
   *  counters (developer mode) for the Settings background-processing card. */
  processingStats: ProcessingStats;
  /** The most recent AI-enrichment 429's reason and accurate reset time, for
   *  the Settings backlog row and feedback diagnostics. `null` once the
   *  window has passed (or on account switch) — see `aiQuotaExceeded`. */
  aiQuotaExceeded: { reason: string; retryAt: number } | null;
}

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };
// Shared empty result so getTagsForBookmark returns a stable reference for
// bookmarks with no tags (avoids reallocating + breaking memo equality).
const EMPTY_TAGS: Tag[] = [];

/** Durable key for the local-first tag operation queue (JSON in meta). */
const PENDING_TAG_OPS_KEY = "pending_tag_ops";

/** Durable key (JSON id array in meta) for bookmarks awaiting their first auto
 *  AI enrichment. Persisted so a kill during the metadata-fetch window doesn't
 *  drop the auto-trigger — the marker is re-hydrated and fired on next launch. */
const PENDING_AI_TRIGGER_KEY = "pending_ai_trigger";

/** Durable key (JSON `{ [bookmarkId]: AiRetryState }` in meta) for bookmarks
 *  with a failed AI-enrichment attempt (auto OR manual) that wrote no
 *  `ai_enrichments` row, awaiting a backoff-scheduled retry. Populated by any
 *  `requestAiEnrichment` failure and cleared once a later attempt succeeds or
 *  the attempt cap (`AI_RETRY_MAX_ATTEMPTS`) is exhausted. Purely local
 *  bookkeeping, parallel to `PENDING_AI_TRIGGER_KEY`: it never touches the
 *  bookmark row, `updated_at`, or the sync queue. */
const AI_RETRY_STATE_KEY = "ai_suggestion_retry";

/** Durable key (JSON id array in meta) for bookmarks CONFIRMED accepted into
 *  the server-side `pending_ai_enrichment` overflow queue after a 429
 *  (STASH #578 Phase 2) — the background worker WILL deliver a real
 *  enrichment via normal sync. Presence-only, like `PENDING_AI_TRIGGER_KEY`:
 *  there's no per-id bookkeeping to track, just membership. Independent of
 *  `AI_RETRY_STATE_KEY`: that marker arms unconditionally on every failure
 *  (this 429 included) and self-clears after `AI_RETRY_MAX_ATTEMPTS`; this one
 *  is only ever set on a CONFIRMED enqueue and only ever clears once a real
 *  enrichment lands or the bookmark is discarded — see
 *  `isAiSuggestionServerQueued`. */
const AI_SERVER_QUEUED_KEY = "ai_server_queued";

// How many ids reconcileAiServerQueued's status check batches per request
// (Codex review, PR #660) — bounds the `bookmark_id=in.(...)` query target's
// length so a large confirmed-queued backlog can't produce a URI-too-long
// rejection. Matches BULK_CREATE_SYNC_CHUNK_SIZE's batch size for the same
// class of reason (sync/sync-bookmarks.ts).
const AI_SERVER_QUEUED_STATUS_CHUNK_SIZE = 50;

interface AiRetryState {
  /** When the first attempt (of the current, unexhausted streak) failed. */
  firstAttemptAt: string;
  /** When the most recent attempt failed — the backoff clock runs from here. */
  lastAttemptAt: string;
  /** How many attempts have failed since the streak began (>= 1). */
  attemptCount: number;
}

/** Wall-clock backoff required since a bookmark's last failed attempt before
 *  an AUTOMATIC retry check may fire the next one, indexed by the current
 *  `attemptCount` (how many attempts have failed so far). A manual "Suggest
 *  with AI"/refresh tap ignores this table and always fires immediately. There
 *  is no entry for `AI_RETRY_MAX_ATTEMPTS` (6): that attempt failing exhausts
 *  the cap and clears all bookkeeping instead of scheduling a 7th. */
const AI_RETRY_BACKOFF_MS: Record<number, number> = {
  1: 2 * 60_000,
  2: 10 * 60_000,
  3: 60 * 60_000,
  4: 6 * 60 * 60_000,
  5: 24 * 60 * 60_000,
};

/** Total attempts (first + 5 retries) before giving up entirely and clearing
 *  the bookmark's retry marker — it then looks exactly like a bookmark that
 *  was never enriched, with no distinct "gave up" state. */
const AI_RETRY_MAX_ATTEMPTS = 6;

/** How long the staggered AUTO dispatch queue pauses after a 429 reveals the
 *  per-user AI quota is exhausted (STASH-4K follow-up). A large backlog (a
 *  bulk import with hundreds of un-enriched bookmarks) would otherwise keep
 *  firing a direct request roughly every couple seconds, every one of them a
 *  guaranteed 429, until the whole backlog has been walked once — wasted
 *  battery/network for a result already known. Manual "Suggest with AI" taps
 *  are unaffected; only the auto drain checks this.
 *
 *  `daily_limit`'s own `retry_after` is now computed exactly by the server
 *  too (STASH-4P follow-up — see request_ai_enrichment_slot), but this
 *  internal gate deliberately does NOT use it directly: a real daily wait can
 *  be close to 24h, and idling the drain loop that long would miss a slot
 *  freed earlier by the rolling window's other requests aging out. It
 *  re-checks periodically on this fixed, conservative cooldown instead — the
 *  accurate server value is used only for display (see `aiQuotaExceeded`).
 *  `hourly_limit`'s `retry_after` IS trusted directly for this gate (Codex
 *  review, PR #655) — `AI_QUOTA_HOURLY_COOLDOWN_MS` is only the fallback for
 *  the rare case the response didn't carry one. */
const AI_QUOTA_DAILY_COOLDOWN_MS = 30 * 60_000;
const AI_QUOTA_HOURLY_COOLDOWN_MS = 10 * 60_000;
/** Defensive clamp on a server-reported hourly `retry_after` (seconds) before
 *  trusting it for the cooldown — the hourly window is at most 3600s, so
 *  anything outside [1, 3600] is treated as untrustworthy and falls back to
 *  AI_QUOTA_HOURLY_COOLDOWN_MS instead. */
const AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S = { min: 1, max: 3600 } as const;

/** STASH-4J: how long to wait before a single retry of a `pending_ai_enrichment`
 *  enqueue that failed with an RLS violation (HTTP 403). Production logs show
 *  these landing in tight ~30-in-45-second bursts during a bulk import, each
 *  burst starting right alongside an unrelated Realtime logical-decoding slot
 *  restart on the DB — a platform-level hiccup, not a logic bug: the exact
 *  same insert, replayed moments later against the same row, succeeds cleanly
 *  (verified live in production for several of the affected bookmark ids).
 *  Long enough to clear that window, short enough not to noticeably delay the
 *  "queued" confirmation. */
const ENQUEUE_RLS_RETRY_DELAY_MS = 5000;

/** How often a foreground periodic timer re-checks the backoff table while the
 *  app sits open (in addition to the cold-launch and foreground-transition
 *  checks). Deliberately coarse — the shortest backoff step is 2 minutes, so
 *  checking much more often than this buys nothing. */
const AI_RETRY_CHECK_INTERVAL_MS = 5 * 60_000;

/** Max metadata-enrichment fetches in flight at once (Sentry STASH-3B): a bulk
 *  import (or the startup backfill after one) must trickle its fetches instead
 *  of launching hundreds concurrently, which exhausted native resources and
 *  aborted the ART runtime. Low enough to keep a 500-item burst harmless, high
 *  enough that interactive saves never queue behind each other in practice. */
const ENRICHMENT_FETCH_CONCURRENCY = 4;
/** How long the auto-sync trigger waits after queued work becomes ready before
 *  running a pass. A burst of captures settles its metadata one row at a time,
 *  and each settle used to trigger its own sync; this collects them into a
 *  single bulk upload. Short enough that a lone save still syncs promptly. */
const METADATA_SYNC_DEBOUNCE_MS = 250;

/** Parse the persisted AI-retry bookkeeping map, tolerating absent/corrupt
 *  values (mirrors `parseIdSet`/`parseTagOps` for the store's other durable
 *  meta blobs). */
function parseAiRetryState(raw: string | null): Record<string, AiRetryState> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, AiRetryState> = {};
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as AiRetryState).firstAttemptAt === "string" &&
        typeof (value as AiRetryState).lastAttemptAt === "string" &&
        typeof (value as AiRetryState).attemptCount === "number"
      ) {
        result[id] = value as AiRetryState;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for AI suggestion
 *  names the user has reviewed (accepted or dismissed). Drives the "✨" badge so
 *  it reflects *unreviewed* suggestions rather than merely *un-applied* ones. */
const REVIEWED_SUGGESTIONS_KEY = "reviewed_ai_suggestions";

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the folder
 *  (collection) suggestions the user has dismissed on a bookmark's Detail, keyed
 *  by a stable token (see `suggestedFolderToken`). Persisted so a dismissed
 *  folder chip stays gone when the user re-enters Detail or relaunches — a later
 *  enrichment proposing a *different* folder yields a different token and still
 *  re-surfaces. */
const DISMISSED_FOLDERS_KEY = "dismissed_folder_suggestions";

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the AI summaries
 *  the user has reviewed (used as a note or dismissed) on a bookmark's Detail,
 *  keyed by a stable token (see `summaryToken`). Persisted so a summary the user
 *  acted on stays gone when they re-enter Detail or relaunch — a later
 *  enrichment producing a *different* summary yields a different token and still
 *  re-surfaces. */
const REVIEWED_SUMMARIES_KEY = "reviewed_ai_summaries";

/** Durable key (JSON id array in meta) for bookmarks whose AI suggestions
 *  arrived while the user wasn't looking — a background auto-enrichment, a
 *  server-side trigger result, or another device's enrichment pulled in. Drives
 *  the Inbox "new AI suggestions" banner so freshly-suggested items aren't
 *  stranded behind a per-card badge the user has to scroll to find; an id is
 *  cleared once the user witnesses it (opens its Detail, or visits Review).
 *  Persisted so a suggestion that landed in a session the user never returned to
 *  still announces itself on the next launch. */
const UNSEEN_SUGGESTIONS_KEY = "unseen_ai_suggestions";

/** Manual "pause sync" safety valve (Sentry STASH-3K follow-up): while on,
 *  syncNow no-ops entirely (no upload, no pull) so a bulk import can be
 *  reviewed — and unwanted rows deleted — before anything reaches the
 *  network. Persisted so it survives leaving the app mid-review. */
const SYNC_PAUSED_KEY = "pref.sync.paused";

/** Opaque sentinel `requestAiEnrichment` returns when the AI endpoint rate-limits
 *  (HTTP 429). The store is i18n-free, so it can't localize the message itself;
 *  the Detail screen maps this to a translated string. Any non-UI caller (the
 *  deferred auto-trigger) only checks for a non-null error, so the value is
 *  inert there. */
export const AI_RATE_LIMITED = "ai-rate-limited";

function parseIdSet(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

const BookmarksContext = createContext<BookmarksContextValue | null>(null);

/**
 * A UUID v4. Prefers the platform crypto when present (web, modern Hermes, the
 * Node test runner) and otherwise falls back to a Math.random-based v4 — these
 * are dedupe/identity keys, not secrets, so they only need to be unique, not
 * cryptographically strong.
 */
function makeUuid(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * A bookmark's permanent id, minted once at capture time. Sent to the server
 * as the row's own primary key (see CreateBookmarkInput.id / api/bookmarks.ts)
 * so a create never has to hand back a different id for the client to adopt —
 * there is no local→remote id swap. Same UUID format `client_id` already used
 * (and still uses, as a separate idempotency key — see createPayloadFromBookmark),
 * so a bookmark's own id and its capture id are indistinguishable in shape;
 * they're kept as two separate fields on purpose, not merged.
 */
function makeBookmarkId(): string {
  return makeUuid();
}

/**
 * A UUID-format capture id for {@link Bookmark.client_id}. The cloud
 * `bookmarks.client_id` column is `uuid`, so the format must be valid.
 */
function makeClientId(): string {
  return makeUuid();
}

/**
 * The current canonical dedupe key for an already-stored bookmark. Recomputed
 * from the URL rather than trusting the persisted `url_hash`, so a row saved by
 * an older build — whose hash predates a canonicalization change (e.g. the
 * YouTube `si` strip) and hasn't yet been rewritten by pull sync — still
 * dedupes against a fresh save instead of creating the duplicate this is meant
 * to prevent. Falls back to the stored hash when the row has no URL.
 */
function currentDedupeKey(
  bookmark: Pick<Bookmark, "url" | "url_hash">,
): string | null {
  return bookmark.url ? canonicalizeUrl(bookmark.url) : bookmark.url_hash;
}

/**
 * "Active" the same way the inbox filter defines it: not trashed and not
 * archived. Save-time dedupe must only match active rows — otherwise re-saving a
 * URL that is sitting in Trash folds into the trashed row and leaves it hidden,
 * so it never comes back. Mirrors the server-side active-URL predicate.
 */
function isActiveBookmark(
  bookmark: Pick<Bookmark, "deleted_at" | "is_archived">,
): boolean {
  return !bookmark.deleted_at && !bookmark.is_archived;
}

/** Parse the persisted tag-op queue, tolerating absent/corrupt values. */
function parseTagOps(raw: string | null): PendingTagOp[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (op): op is PendingTagOp =>
            !!op &&
            typeof op.bookmark_id === "string" &&
            typeof op.tag_name === "string" &&
            (op.op === "add" || op.op === "remove"),
        )
      : [];
  } catch {
    return [];
  }
}

function logStorageError(operation: string, error: unknown) {
  console.warn(
    `[stash] failed to persist ${operation}; state remains in memory`,
    error,
  );
}

/**
 * A handful of the bulk-create reconcile follow-up's local writes have
 * nothing else that will ever retry them once completeCreateSyncBatch has
 * already marked the underlying create synced and dequeued it (see the
 * mid-flight-delete and reconcile-update loops in
 * `applyBulkCreateChunkResults`) — a single transient failure there would
 * otherwise be unrecoverable for the rest of the session (caught in PR
 * review). Bounded, short-delay retry for that specific case; not a general
 * storage-retry utility.
 */
async function retryStorageWrite<T>(op: () => Promise<T>): Promise<T> {
  const attempts = 3;
  const delayMs = 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// Single shared init so background writes can never race ahead of table
// creation/seeding, even for saves made before the startup load finishes.
let repositoryReady: Promise<void> | null = null;
function ensureRepositoryReady(): Promise<void> {
  if (!repositoryReady) {
    // A fresh install starts empty — no sample bookmarks/tags/collections are
    // seeded. `init` still runs to create the tables and mark the store seeded
    // (so the empty state is durable), it just inserts nothing.
    repositoryReady = repository.init([]);
    // A failed init must not poison the whole session — clear the cached
    // rejection so the next call retries (e.g. after a transient warm-start
    // open failure).
    repositoryReady.catch(() => {
      repositoryReady = null;
    });
  }
  return repositoryReady;
}

/**
 * A per-bookmark `StringSetMap` mirrored into React state *and* a ref, persisted
 * to `metaKey`. The ref is updated synchronously by `apply` so the optimistic /
 * background-arrival paths can read-modify-write within a single tick (state
 * alone would lag a render); `apply` is the one persist seam. Both the
 * reviewed-suggestions and dismissed-folder stores are instances of this — it
 * collapses what were two parallel state+ref+apply+clear stacks into one.
 */
function usePersistedStringSetMap(metaKey: string) {
  const [map, setMap] = useState<StringSetMap>({});
  const ref = useRef<StringSetMap>({});
  const apply = useCallback(
    (next: StringSetMap) => {
      ref.current = next;
      setMap(next);
      ensureRepositoryReady()
        .then(() => repository.setMeta(metaKey, JSON.stringify(next)))
        .catch((error) => logStorageError(metaKey, error));
    },
    [metaKey],
  );
  // Replace the whole map from a freshly-parsed meta blob (startup hydration) —
  // no persist, since it came straight from the store.
  const hydrate = useCallback((raw: string | null) => {
    const next = parseStringSetMap(raw);
    ref.current = next;
    setMap(next);
  }, []);
  // Forget one key's entry entirely (a deliberate "reconsider" — e.g. a manual
  // "Suggest with AI" re-run). Background sync never calls this.
  const removeKey = useCallback(
    (key: string) => {
      if (!(key in ref.current)) {
        return;
      }
      const next = { ...ref.current };
      delete next[key];
      apply(next);
    },
    [apply],
  );
  return { map, ref, apply, hydrate, removeKey };
}

/** Append items from `loaded` that aren't already present (by key). */
function mergeById<T>(
  current: T[],
  loaded: T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...loaded.filter((item) => !seen.has(key(item)))];
}

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const auth = useSupabaseAuth();
  const broadcastSyncNudgeRef = useRef<(() => void) | null>(null);
  const syncPendingRef = useRef(false);
  const syncNowRef = useRef<(() => Promise<boolean>) | null>(null);
  const localCreateFlushesInFlight = useRef(0);
  const pendingUserTitleEdits = useRef(new Set<string>());
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
  const [isSyncingState, setIsSyncing] = useState(false);
  const [isSyncDebounceActive, setIsSyncDebounceActive] = useState(false);
  const isSyncing = isSyncingState || isSyncDebounceActive;
  const [isResettingLibrary, setIsResettingLibrary] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const syncInFlight = useRef(false);
  // The user id the pull effect last fired for. A sign-in (anonymous → real)
  // or account switch changes this, re-triggering a pull; null until the first
  // session is established.
  const lastSyncedUserId = useRef<string | null>(null);
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
        source?: "auto" | "manual",
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
      void syncNowRef.current?.().catch(() => {});
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

  // Persist the local-first tag-op queue (ref updated synchronously).
  // `persist: false` updates the in-memory ref/state only, skipping the
  // SQLite write — used by syncTagOps' per-op loop so a bulk import's ~300
  // sequential tag uploads don't each re-serialize and persist the whole
  // (shrinking) array, which was contending with the main sync queue's own
  // writes (Sentry: bli9833 import backlog, sqlite tail-wait depth 22).
  const applyTagOps = useCallback(
    (next: PendingTagOp[], options?: { persist?: boolean }) => {
      pendingTagOpsRef.current = next;
      setPendingTagOps(next);
      if (options?.persist === false) {
        return;
      }
      ensureRepositoryReady()
        .then(() =>
          repository.setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(next)),
        )
        .catch((error) => logStorageError("tag ops", error));
    },
    [],
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
    (bookmarkId: string, operation: "update" | "delete") => {
      const entry = makeMutationEntry(bookmarkId, operation);
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

  // Local-first edit of user-editable fields: apply + persist immediately,
  // show as sync-pending, and queue an update mutation for synced bookmarks.
  const applyBookmarkUpdate = useCallback(
    (id: string, patch: Partial<Bookmark>) => {
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
          enqueueMutation(id, "update");
        }
      }
    },
    [enqueueMutation, hasSyncedOnce],
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
      });
    },
    [applyBookmarkUpdate],
  );

  const clearReviewedSuggestions = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_tags: [] });
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
      });
    },
    [applyBookmarkUpdate],
  );

  const clearDismissedFolderSuggestions = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_folders: [] });
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
      });
    },
    [applyBookmarkUpdate],
  );

  const clearReviewedSummary = useCallback(
    (bookmarkId: string) => {
      applyBookmarkUpdate(bookmarkId, { reviewed_summary_tokens: [] });
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

  // Record that an enrichment arrived unwitnessed: flag its bookmark for the
  // Inbox banner, but only if it actually carries a recommendation the user
  // hasn't already handled — a pending tag suggestion, a folder suggestion, OR
  // a pending summary (matching what makes a bookmark reviewable on the Review
  // screen). An enrichment that's all already-applied tags / already-reviewed
  // summary isn't worth announcing.
  const noteUnseenSuggestions = useCallback(
    (enrichment: AIEnrichment) => {
      const id = enrichment.bookmark_id;
      if (unseenSuggestionIdsRef.current.has(id)) {
        return;
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
        return;
      }
      const next = new Set(unseenSuggestionIdsRef.current);
      next.add(id);
      applyUnseenSuggestions(next);
    },
    [appliedTagNamesRef, applyUnseenSuggestions],
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

  // Mirror the deferred AI-trigger set to durable meta after a ref mutation.
  // Returns the write's promise (always resolves — errors are logged, not
  // thrown) so a caller that needs true ordering (e.g. requestAiEnrichment's
  // catch, see armAiRetry below) can await it to completion rather than
  // firing it and moving on.
  const persistPendingAiTrigger = useCallback((): Promise<void> => {
    const ids = [...pendingAiTrigger.current];
    return ensureRepositoryReady()
      .then(() =>
        repository.setMeta(PENDING_AI_TRIGGER_KEY, JSON.stringify(ids)),
      )
      .catch((error) => logStorageError("ai trigger queue", error));
  }, []);
  const markPendingAiTrigger = useCallback(
    (id: string) => {
      pendingAiTrigger.current.add(id);
      persistPendingAiTrigger();
    },
    [persistPendingAiTrigger],
  );
  const clearPendingAiTrigger = useCallback(
    (id: string): Promise<void> => {
      if (pendingAiTrigger.current.delete(id)) {
        return persistPendingAiTrigger();
      }
      return Promise.resolve();
    },
    [persistPendingAiTrigger],
  );

  // Write aiRetryState.current to durable storage, rejecting (rather than
  // swallowing) on failure. Only armAiRetry uses this directly — its caller
  // (requestAiEnrichment's catch) must know whether the write actually landed
  // before it clears the pending-trigger marker (see armAiRetry below). Every
  // other caller goes through persistAiRetryState, which keeps swallowing.
  const writeAiRetryState = useCallback((): Promise<void> => {
    return ensureRepositoryReady().then(() =>
      repository.setMeta(
        AI_RETRY_STATE_KEY,
        JSON.stringify(aiRetryState.current),
      ),
    );
  }, []);

  // Persist the AI-retry bookkeeping map after a ref mutation (mirrors
  // persistPendingAiTrigger). Does NOT touch React state — callers update the
  // reactive `aiRetryIds` mirror themselves via `syncAiRetryIds`, at the point
  // that's safe for their caller (see requestAiEnrichment's `finally`).
  // Returns the write's promise for the same reason persistPendingAiTrigger
  // does.
  const persistAiRetryState = useCallback((): Promise<void> => {
    return writeAiRetryState().catch((error) =>
      logStorageError("ai retry state", error),
    );
  }, [writeAiRetryState]);

  // Refresh the reactive mirror of aiRetryState's keys. Called once per
  // settled requestAiEnrichment call (from its `finally`) rather than
  // immediately inside armAiRetry/clearAiRetry, so it always lands in the same
  // synchronous block as the isEnriching flip — never a frame earlier.
  const syncAiRetryIds = useCallback(() => {
    setAiRetryIds(new Set(Object.keys(aiRetryState.current)));
  }, []);

  // Arm (or re-arm) a bookmark's retry marker after a requestAiEnrichment
  // failure (auto or manual) that wrote no ai_enrichments row. Exhausting
  // AI_RETRY_MAX_ATTEMPTS clears the marker entirely instead of leaving a
  // distinct "gave up" state, so the bookmark reverts to looking exactly like
  // one that was never enriched. Local-only: never touches the bookmark row,
  // updated_at, or the sync queue.
  // Returns whether the retry-state write actually landed on disk (unlike
  // persistAiRetryState, this one doesn't swallow failures) so a caller that
  // must not clear a different durable marker until this write is confirmed
  // — see requestAiEnrichment's catch below — can gate on it instead of
  // assuming success.
  const armAiRetry = useCallback(
    (bookmarkId: string): Promise<boolean> => {
      // The request that just failed can have been in flight when the user
      // trashed or permanently deleted this bookmark — trashBookmark/
      // deleteBookmark already clear an EXISTING marker synchronously at that
      // moment, but can't stop a failure that lands afterward from re-arming
      // it. Re-arming here would let a later backoff-scheduled retry silently
      // write fresh AI suggestions for content the user already discarded (or,
      // for a hard delete, fire a doomed request against an id that no longer
      // exists). Skip arming once there's positive evidence of either.
      if (deletedIds.current.has(bookmarkId)) {
        return Promise.resolve(true);
      }
      const forBookmark = bookmarksRef.current?.find(
        (item) => item.id === bookmarkId,
      );
      if (forBookmark?.deleted_at) {
        return Promise.resolve(true);
      }
      const now = new Date().toISOString();
      const existing = aiRetryState.current[bookmarkId];
      const attemptCount = (existing?.attemptCount ?? 0) + 1;
      const next = { ...aiRetryState.current };
      if (attemptCount >= AI_RETRY_MAX_ATTEMPTS) {
        delete next[bookmarkId];
      } else {
        next[bookmarkId] = {
          firstAttemptAt: existing?.firstAttemptAt ?? now,
          lastAttemptAt: now,
          attemptCount,
        };
      }
      aiRetryState.current = next;
      return writeAiRetryState().then(
        () => true,
        (error) => {
          logStorageError("ai retry state", error);
          return false;
        },
      );
    },
    [writeAiRetryState],
  );

  // Clear a bookmark's retry marker after a successful attempt.
  const clearAiRetry = useCallback(
    (bookmarkId: string) => {
      if (!(bookmarkId in aiRetryState.current)) {
        return;
      }
      const next = { ...aiRetryState.current };
      delete next[bookmarkId];
      aiRetryState.current = next;
      persistAiRetryState();
    },
    [persistAiRetryState],
  );

  // Mirror the confirmed-server-queued set to durable meta after a ref
  // mutation (mirrors persistPendingAiTrigger). Swallows failures — nothing
  // downstream needs to gate on this write landing the way armAiRetry's
  // caller gates on writeAiRetryState.
  const persistAiServerQueued = useCallback((): Promise<void> => {
    const ids = [...aiServerQueued.current];
    return ensureRepositoryReady()
      .then(() => repository.setMeta(AI_SERVER_QUEUED_KEY, JSON.stringify(ids)))
      .catch((error) => logStorageError("ai server-queued", error));
  }, []);

  // Refresh the reactive mirror of aiServerQueued's members.
  const syncAiServerQueuedIds = useCallback(() => {
    setAiServerQueuedIds(new Set(aiServerQueued.current));
  }, []);

  // Mark a bookmark as CONFIRMED accepted into the server-side overflow
  // queue. Callers must only invoke this once the enqueue POST itself has
  // resolved — never eagerly, and never on a rejected or synchronously-thrown
  // enqueue attempt (those fall back to the generic armAiRetry treatment
  // alone; see requestAiEnrichment's 429 branch). Fire-and-forget, like the
  // enqueue call site itself — must never block or throw into that path.
  const markAiServerQueued = useCallback(
    (bookmarkId: string) => {
      aiServerQueued.current.add(bookmarkId);
      persistAiServerQueued();
      syncAiServerQueuedIds();
    },
    [persistAiServerQueued, syncAiServerQueuedIds],
  );

  // Clear a bookmark's confirmed-server-queued marker once a real enrichment
  // actually lands for it, or it's discarded. No-op if absent, mirroring
  // clearAiRetry's early return.
  const clearAiServerQueued = useCallback(
    (bookmarkId: string) => {
      if (!aiServerQueued.current.delete(bookmarkId)) {
        return;
      }
      persistAiServerQueued();
      syncAiServerQueuedIds();
    },
    [persistAiServerQueued, syncAiServerQueuedIds],
  );

  // Drop this (previous) account's AI-suggestion bookkeeping for the given
  // ids — mirrors dropPendingTagOpsForBookmarks's purpose for tag state.
  // Without this, a real A→real B switch (or logout) leaves A's
  // aiRetryState/pendingAiTrigger entries in place, and checkAiRetries (or
  // the deferred first-trigger effect) has no ownership check: it would fire
  // requestAiEnrichment for A's bookmark id under B's now-active session.
  const dropAiRetryBookkeeping = useCallback(
    (ids: readonly string[]) => {
      let retryChanged = false;
      const nextRetry = { ...aiRetryState.current };
      let serverQueuedChanged = false;
      for (const id of ids) {
        if (id in nextRetry) {
          delete nextRetry[id];
          retryChanged = true;
        }
        // The confirmed-server-queued marker is account-scoped bookkeeping
        // just like aiRetryState/pendingAiTrigger above — drop it too, so a
        // dropped account's stale queue confirmation can't linger and show a
        // "queued" note under the next (different) session.
        if (aiServerQueued.current.delete(id)) {
          serverQueuedChanged = true;
        }
        pendingAiTrigger.current.delete(id);
        aiTriggerAttempted.current.delete(id);
      }
      // The staggered auto-dispatch queue is account-scoped bookkeeping too:
      // a bookmark staged here but not yet popped when the account switched
      // otherwise keeps counting toward the new session's pipeline total
      // (Sentry STASH-4Y).
      aiDispatchQueueRef.current = dropAiEnrichmentDispatchIds(
        aiDispatchQueueRef.current,
        ids,
      );
      if (retryChanged) {
        aiRetryState.current = nextRetry;
        persistAiRetryState();
        syncAiRetryIds();
      }
      if (serverQueuedChanged) {
        persistAiServerQueued();
        syncAiServerQueuedIds();
      }
      persistPendingAiTrigger();
    },
    [
      persistAiRetryState,
      syncAiRetryIds,
      persistPendingAiTrigger,
      persistAiServerQueued,
      syncAiServerQueuedIds,
    ],
  );

  // Re-key this account's AI-suggestion bookkeeping (aiRetryState,
  // pendingAiTrigger, aiTriggerAttempted) from an old bookmark id onto its
  // new one — mirrors rekeyPendingTagOps's purpose for tag state. The only
  // caller is the anon→real carry-over rehome (a bookmark's id is otherwise
  // stable for life once captured — see makeBookmarkId). Without this, a
  // re-keyed bookmark silently loses retry eligibility and its stale old-id
  // entry becomes an orphan that fires against an id that no longer exists.
  //
  // aiTriggerAttempted is deliberately NOT carried onto newId — only removed
  // from oldId. It's a session-only in-memory "already fired this launch"
  // dedupe marker (see its declaration), so its only valid purpose is
  // preventing a same-session re-fire of the SAME still-pending trigger for
  // the SAME identity. Carrying it forward doesn't protect anything: an
  // in-flight request still keyed to oldId targets a row/account that no
  // longer exists under this identity and just fails benignly, while newId
  // typically gets a brand-new `markPendingAiTrigger` call immediately after
  // the rehome — carrying the "already attempted" flag onto that fresh
  // identity made the deferred-trigger effect
  // (`aiTriggerAttempted.current.has(id)`) skip it forever this session, so
  // the re-keyed bookmark silently never got AI suggestions until an app
  // restart cleared the in-memory set.
  const remapAiRetryIdentity = useCallback(
    (idMap: ReadonlyMap<string, string>) => {
      let retryChanged = false;
      const nextRetry = { ...aiRetryState.current };
      for (const [oldId, newId] of idMap) {
        if (oldId in nextRetry) {
          nextRetry[newId] = nextRetry[oldId];
          delete nextRetry[oldId];
          retryChanged = true;
        }
      }
      if (retryChanged) {
        aiRetryState.current = nextRetry;
        persistAiRetryState();
        syncAiRetryIds();
      }
      // Re-key the confirmed-server-queued marker the same way — without
      // this, a bookmark whose 429 was already confirmed queued would lose
      // that confirmation the moment an id swap (rehome, create-upload
      // remote-id swap, crash-safe reconciliation) parks it under a new id.
      let serverQueuedChanged = false;
      for (const [oldId, newId] of idMap) {
        if (aiServerQueued.current.delete(oldId)) {
          aiServerQueued.current.add(newId);
          serverQueuedChanged = true;
        }
      }
      if (serverQueuedChanged) {
        persistAiServerQueued();
        syncAiServerQueuedIds();
      }
      let triggerChanged = false;
      for (const [oldId, newId] of idMap) {
        if (pendingAiTrigger.current.delete(oldId)) {
          pendingAiTrigger.current.add(newId);
          triggerChanged = true;
        }
        aiTriggerAttempted.current.delete(oldId);
      }
      if (triggerChanged) {
        persistPendingAiTrigger();
      }
      // Re-key the staggered auto-dispatch burst queue too — without this, a
      // bookmark staged here under its old anonymous id silently no-ops the
      // moment the drain loop pops it: `requestAiEnrichment`'s first check
      // (`bookmarksRef.current?.some(item => item.id === bookmarkId)`) finds
      // nothing under the now-dead old id, and the queued auto-suggestion is
      // lost rather than delivered under the new one (#692).
      aiDispatchQueueRef.current = remapAiEnrichmentDispatchIds(
        aiDispatchQueueRef.current,
        idMap,
      );
    },
    [
      persistAiRetryState,
      syncAiRetryIds,
      persistPendingAiTrigger,
      persistAiServerQueued,
      syncAiServerQueuedIds,
    ],
  );

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
          // Fill only generated fields that are still empty, so a user-authored
          // title is never overwritten by generated metadata.
          const safePatch: Partial<Bookmark> = {};
          if (patch.title !== undefined && latest.title === null) {
            safePatch.title = patch.title;
            // Carry the title's provenance alongside it, so a generated fallback
            // title is recorded as such (and a real fetched title as not-derived).
            safePatch.title_is_derived = patch.title_is_derived;
          }
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
            enqueueMutation(updated.id, "update");
          }
        } finally {
          enriching.current.delete(bookmark.id);
        }
      });
    },
    [enqueueMutation, hasSyncedOnce],
  );

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
          const [
            storedBookmarks,
            storedQueue,
            storedEnrichments,
            storedTagData,
            storedPulledAt,
            storedTagOpsRaw,
            storedImportCollectionsRaw,
            storedEnrichmentRestoresRaw,
            storedAiTriggerRaw,
            storedAiRetryRaw,
            storedAiServerQueuedRaw,
            storedReviewedRaw,
            storedUnseenRaw,
            storedDismissedFoldersRaw,
            storedReviewedSummariesRaw,
            storedAiSuggestionsModeRaw,
            storedSyncPausedRaw,
          ] = await Promise.all([
            repository.listBookmarks(),
            repository.listQueue(),
            repository.listEnrichments(),
            repository.listTagData(),
            repository.getMeta(LAST_PULLED_AT_KEY),
            repository.getMeta(PENDING_TAG_OPS_KEY),
            repository.getMeta(PENDING_IMPORT_COLLECTIONS_KEY),
            repository.getMeta(PENDING_ENRICHMENT_RESTORE_KEY),
            repository.getMeta(PENDING_AI_TRIGGER_KEY),
            repository.getMeta(AI_RETRY_STATE_KEY),
            repository.getMeta(AI_SERVER_QUEUED_KEY),
            repository.getMeta(REVIEWED_SUGGESTIONS_KEY),
            repository.getMeta(UNSEEN_SUGGESTIONS_KEY),
            repository.getMeta(DISMISSED_FOLDERS_KEY),
            repository.getMeta(REVIEWED_SUMMARIES_KEY),
            repository.getMeta(AI_SUGGESTIONS_MODE_PREF_KEY),
            repository.getMeta(SYNC_PAUSED_KEY),
          ]);
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
                  enqueueMutation(updated.id, "update");
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
            // Merge instead of replace: saves made while loading must survive.
            setBookmarks((current) =>
              current === null
                ? migratedBookmarks
                : mergeById(
                    current,
                    migratedBookmarks,
                    (bookmark) => bookmark.id,
                  ),
            );
            setQueue((current) =>
              mergeById(current, storedQueue, (entry) => entry.local_id),
            );
            // Self-heal stranded bookmarks: a non-synced row whose queue entry
            // never persisted (storage hiccup, or the app killed between the two
            // writes) has nothing to drive its sync and would show "sync
            // pending" forever. Re-enqueue an upload so the background loop
            // finishes it. Idempotent on the server, so it's safe to repeat.
            const orphanEntries = reconcileOrphanedQueueEntries(
              migratedBookmarks,
              storedQueue,
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

  const addBookmark = useCallback(
    ({
      url,
      title,
      notes,
      shared_text,
      image,
    }: {
      url?: string;
      title?: string;
      notes?: string;
      shared_text?: string;
      image?: SharedImage;
    }): AddBookmarkResult => {
      // A shared image becomes an image bookmark: capture is local-first and
      // local-only for now (cloud upload of the binary is deferred to 0.3.x), so
      // it is never enqueued for sync. We mark it 'synced' precisely because
      // there is no cloud work pending — that also keeps the startup orphan
      // reconciler from re-enqueuing it and the Inbox/Detail from showing a
      // misleading "sync pending" chip. Capture is sacred: the durable file copy
      // is folded into `persisted` so the share handler only dismisses once it
      // has actually landed on disk.
      if (image) {
        const now = new Date().toISOString();
        const id = makeBookmarkId();
        const fileName = localImageFileName(id, image);
        const imageBookmark: Bookmark = {
          id,
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          // A title typed at capture is user-authored; otherwise derive a
          // readable one from the shared filename (may be null → "Untitled").
          title: title?.trim()
            ? title.trim()
            : imageTitleFromFileName(image.fileName),
          title_is_derived: title?.trim() ? false : undefined,
          description: null,
          notes: notes?.trim() ? notes.trim() : null,
          source_app: null,
          content_type: "image",
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          last_saved_at: now,
          // No URL/text to derive metadata from — nothing to enrich.
          metadata_status: "skipped",
          sync_status: "synced",
          // Temporary share URI for the optimistic render; swapped for the
          // durable copy once `copyImageToLibrary` resolves below.
          local_image_uri: image.uri,
        };

        setBookmarks((current) => [imageBookmark, ...(current ?? [])]);
        const persisted = ensureRepositoryReady()
          .then(() => copyImageToLibrary(image.uri, fileName))
          .then((durableUri) => {
            const stored: Bookmark = {
              ...imageBookmark,
              local_image_uri: durableUri,
            };
            setBookmarks((current) =>
              current === null
                ? current
                : current.map((b) => (b.id === id ? stored : b)),
            );
            return repository.insertBookmark(stored);
          })
          .then(() => true)
          .catch((error) => {
            logStorageError("new image bookmark", error);
            return false;
          });

        return { status: "created", bookmark: imageBookmark, persisted };
      }

      const normalized = url ? normalizeUrl(url) : null;
      if (!normalized) {
        // No usable URL. If the share carried text (e.g. a KakaoTalk message
        // with no link), save it as a text note rather than dropping deliberately
        // shared content — capture is sacred. Reject only when there is nothing
        // at all to save.
        const text = shared_text?.trim() || null;
        if (!text) {
          return {
            status: "invalid",
            error:
              "Enter a valid web address, like example.com or https://example.com.",
          };
        }

        const noteNow = new Date().toISOString();
        // Text notes have no canonical URL key, so distinct shares are distinct
        // notes by design. The client_id below is NOT a content key: it's this
        // capture's stable id, resent on every retry so an interrupted upload
        // dedupes against its own first attempt instead of inserting a twin.
        const noteClientId = makeClientId();
        const note: Bookmark = {
          id: makeBookmarkId(),
          user_id: mockUserId,
          url: null,
          canonical_url: null,
          url_hash: null,
          client_id: noteClientId,
          title: title?.trim() ? title.trim() : null,
          title_is_derived: title?.trim() ? false : undefined,
          // The shared text is the note's body. Stored as the description to
          // mirror the cloud API (which maps shared_text → description), so a
          // pulled-back note matches the locally captured one.
          description: text,
          notes: notes?.trim() ? notes.trim() : null,
          source_app: null,
          content_type: "text",
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: noteNow,
          updated_at: noteNow,
          last_saved_at: noteNow,
          metadata_status: "pending",
          sync_status: "pending",
        };

        const noteEntry: LocalPendingBookmark = {
          local_id: note.id,
          remote_id: null,
          operation: "create",
          payload: {
            id: note.id,
            title: note.title ?? undefined,
            notes: note.notes ?? undefined,
            shared_text: text,
            client_id: noteClientId,
          },
          sync_status: "pending",
          retry_count: 0,
          last_error: null,
          created_at: noteNow,
          updated_at: noteNow,
        };

        setBookmarks((current) => [note, ...(current ?? [])]);
        setQueue((current) => [...current, noteEntry]);
        const persisted = ensureRepositoryReady()
          .then(() =>
            Promise.all([
              repository.insertBookmark(note),
              repository.enqueue(noteEntry),
            ]),
          )
          .then(() => true)
          .catch((error) => {
            logStorageError("new text note", error);
            return false;
          });

        // No URL to derive metadata from; this transitions metadata_status to
        // 'skipped' via the existing, tested enrichment path.
        enrichInBackground(note);

        return { status: "created", bookmark: note, persisted };
      }

      const now = new Date().toISOString();

      // Idempotent saves: reuse the existing bookmark for the same URL. Dedupe
      // on the canonical form so tracking params / fragments don't create dupes.
      const dedupeKey = canonicalizeUrl(normalized);

      // Reject up front rather than queuing a save that can never succeed: the
      // server's `url_hash` index has a Postgres row-size limit that a sufficiently
      // long canonical URL blows on every retry, forever (Sentry STASH-2V / STASH-2J).
      if (isUrlTooLong(dedupeKey)) {
        return {
          status: "invalid",
          error: "This web address is too long to save.",
          reason: "too_long",
        };
      }

      const existing = loadedBookmarks.find(
        (bookmark) =>
          isActiveBookmark(bookmark) &&
          currentDedupeKey(bookmark) === dedupeKey,
      );
      if (existing) {
        const updated = { ...existing, last_saved_at: now };
        setBookmarks((current) =>
          (current ?? []).map((bookmark) =>
            bookmark.id === existing.id ? updated : bookmark,
          ),
        );
        const persisted = ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .then(() => true)
          .catch((error) => {
            logStorageError("duplicate save", error);
            return false;
          });
        return { status: "duplicate", bookmark: existing, persisted };
      }

      const clientId = makeClientId();
      const bookmark: Bookmark = {
        id: makeBookmarkId(),
        user_id: mockUserId,
        url: normalized,
        canonical_url: null,
        // Canonical dedupe key (tracking params/fragment stripped). canonical_url
        // stays null until enrichment resolves a real rel=canonical / og:url.
        url_hash: dedupeKey,
        client_id: clientId,
        // A title provided at capture (e.g. from the share payload) counts as
        // user-authored; enrichment only fills it when still null.
        title: title?.trim() ? title.trim() : null,
        title_is_derived: title?.trim() ? false : undefined,
        description: null,
        notes: notes?.trim() ? notes.trim() : null,
        source_app: null,
        content_type: "url",
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: "pending",
        sync_status: "pending",
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        operation: "create",
        payload: {
          id: bookmark.id,
          url: normalized,
          title: bookmark.title ?? undefined,
          notes: bookmark.notes ?? undefined,
          client_id: clientId,
        },
        sync_status: "pending",
        retry_count: 0,
        last_error: null,
        created_at: now,
        updated_at: now,
      };

      // Optimistic update first; persistence happens in the background so
      // capture never waits on storage or (later) the network.
      setBookmarks((current) => [bookmark, ...(current ?? [])]);
      setQueue((current) => [...current, queueEntry]);
      const persisted = ensureRepositoryReady()
        .then(() =>
          Promise.all([
            repository.insertBookmark(bookmark),
            repository.enqueue(queueEntry),
          ]),
        )
        .then(() => true)
        .catch((error) => {
          logStorageError("new bookmark", error);
          return false;
        });

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: "created", bookmark, persisted };
    },
    [loadedBookmarks, enrichInBackground],
  );

  // Bulk re-ingest of imported items. Mirrors addBookmark's local-first create
  // (optimistic insert + queued create + background enrichment) but batches the
  // whole file into one state update, and dedupes within the batch too so a file
  // listing the same URL twice doesn't create duplicates.
  const importBookmarks = useCallback(
    (items: ImportItem[]): ImportSummary => {
      // Sentry STASH-3K/3M, confirmed by reproduction: dedup below only ever
      // sees `bookmarksRef.current`, which is incomplete while the initial
      // local load hasn't landed (bookmarksRef.current still null) or while
      // the account's first cloud pull is still bringing down previously-
      // synced rows (isSyncingState true covers this window too, since the
      // pull-on-first-ready effect fires essentially immediately after load).
      // Importing during either window can't recognize already-existing
      // rows and durably re-creates every one of them as a fresh duplicate —
      // this is the exact "561 -> 1122" doubling reported twice. Refuse
      // outright rather than risk it; the caller asks the user to retry.
      if (bookmarksRef.current === null || isSyncingState) {
        recordLog(
          "warn",
          `import: refused (not ready) items=${items.length} loaded=${bookmarksRef.current !== null} isSyncing=${isSyncingState}`,
        );
        return { imported: 0, duplicates: 0, skipped: 0, notReady: true };
      }
      const now = new Date().toISOString();
      // Latest committed rows (the ref), so an import right after a save sees it.
      const activeLocalBookmarks = (
        bookmarksRef.current ?? loadedBookmarks
      ).filter((bookmark) => isActiveBookmark(bookmark));
      const bookmarkIdByDedupeKey = new Map(
        activeLocalBookmarks
          .map((bookmark) => [currentDedupeKey(bookmark), bookmark.id] as const)
          .filter((entry): entry is [string, string] => entry[0] !== null),
      );
      const activeBookmarkById = new Map(
        activeLocalBookmarks.map((bookmark) => [bookmark.id, bookmark]),
      );
      // Sentry STASH-3K/3M: a bulk import has repeatedly doubled a user's
      // library (their local total exactly 2x the cloud count) with no
      // evidence of why — this and the summary log below are the
      // instrumentation needed to tell apart "dedupe ran against a near-empty
      // snapshot" (activeLocal/seenKeys far below the real library size) from
      // "dedupe saw everything but let duplicates through anyway" (seenKeys
      // matches the library size but `duplicates` is still ~0 on a re-import).
      recordLog(
        "info",
        `import: starting items=${items.length} activeLocal=${activeLocalBookmarks.length} seenKeys=${bookmarkIdByDedupeKey.size}`,
      );
      const newBookmarks: Bookmark[] = [];
      const newEntries: LocalPendingBookmark[] = [];
      let nextTagData = tagDataRef.current;
      let nextTagOps = pendingTagOpsRef.current;
      let nextImportCollections = pendingImportCollectionsRef.current;
      let nextEnrichmentRestores = pendingEnrichmentRestoresRef.current;
      let organizationChanged = false;
      let imported = 0;
      let duplicates = 0;
      let skipped = 0;

      for (const item of items) {
        const normalized = item.url ? normalizeUrl(item.url) : null;
        if (!normalized) {
          skipped += 1;
          continue;
        }
        const dedupeKey = canonicalizeUrl(normalized);
        // Same permanent-failure guard as addBookmark (Sentry STASH-2V / STASH-2J): a URL
        // whose canonical dedupeKey is long enough to blow the server's url_hash index
        // row-size limit would queue a create that can never succeed. Skip it rather than
        // import a dead entry.
        if (isUrlTooLong(dedupeKey)) {
          skipped += 1;
          continue;
        }
        const existingId = bookmarkIdByDedupeKey.get(dedupeKey);
        const isNew = existingId === undefined;
        const id = existingId ?? makeBookmarkId();
        if (!isNew) {
          duplicates += 1;
        } else {
          bookmarkIdByDedupeKey.set(dedupeKey, id);
        }
        if (isNew) {
          const clientId = makeClientId();
          const title = item.title?.trim() ? item.title.trim() : null;
          const notes = item.notes?.trim() ? item.notes.trim() : null;
          const itemCreatedAt = item.createdAt ?? now;
          // #671: a Stash JSON backup restore carries its own generated
          // metadata snapshot (parseJsonBackup, #678) — restore it losslessly
          // instead of re-fetching. metadata_status is deliberately never
          // 'pending' for a restore (even with no snapshot to restore), so
          // enrichInBackground's pending-only guard naturally no-ops rather
          // than needing a separate skip flag. External imports (HTML/CSV)
          // keep today's client metadata fetch — only automatic AI changes.
          const isBackupRestore = item.source === "stash-backup";
          const restoredMetadata = isBackupRestore ? item.metadata : undefined;
          const description = restoredMetadata?.description ?? null;
          const previewImageUrl = restoredMetadata?.preview_image_url ?? null;
          const faviconUrl = restoredMetadata?.favicon_url ?? null;
          const siteName = restoredMetadata?.site_name ?? null;
          const metadataStatus: MetadataStatus = isBackupRestore
            ? restoredMetadata
              ? "complete"
              : "skipped"
            : "pending";
          newBookmarks.push({
            id,
            user_id: mockUserId,
            url: normalized,
            canonical_url: null,
            url_hash: dedupeKey,
            title,
            title_is_derived: title ? false : undefined,
            client_id: clientId,
            description,
            notes,
            source_app: null,
            content_type: "url",
            preview_image_url: previewImageUrl,
            favicon_url: faviconUrl,
            site_name: siteName,
            collection_id: null,
            is_archived: false,
            deleted_at: null,
            created_at: itemCreatedAt,
            updated_at: now,
            last_saved_at: now,
            metadata_status: metadataStatus,
            sync_status: "pending",
          });
          newEntries.push({
            local_id: id,
            remote_id: null,
            operation: "create",
            payload: {
              id,
              url: normalized,
              title: title ?? undefined,
              notes: notes ?? undefined,
              client_id: clientId,
              description: description ?? undefined,
              preview_image_url: previewImageUrl,
              favicon_url: faviconUrl,
              site_name: siteName,
              metadata_status: metadataStatus,
              // #671: never let an imported/restored bookmark auto-spend AI
              // quota — only a fresh save/share gets automatic server-side AI.
              enrichment_policy: "skip",
              created_at: itemCreatedAt,
            },
            sync_status: "pending",
            retry_count: 0,
            last_error: null,
            created_at: now,
            updated_at: now,
          });
          imported += 1;
        }

        for (const tagName of item.tags) {
          const op: PendingTagOp = {
            id: makeUuid(),
            bookmark_id: id,
            tag_name: tagName,
            op: "add",
            source: "user",
            confidence: null,
            created_at: now,
          };
          nextTagData = applyTagOp(nextTagData, op, auth.userId ?? mockUserId);
          nextTagOps = enqueueTagOp(nextTagOps, op);
          organizationChanged = true;
        }
        const collectionName = item.collection?.trim();
        const target = activeBookmarkById.get(id);
        if (collectionName && !target?.collection_id) {
          nextImportCollections = enqueuePendingImportCollection(
            nextImportCollections,
            {
              bookmark_id: id,
              collection_name: collectionName,
              status: "pending",
              last_error: null,
              created_at: now,
            },
          );
          organizationChanged = true;
        }
        // #671: a Stash JSON backup restore carries the bookmark's own AI
        // enrichment snapshot (parseJsonBackup, #678). Queue it durably so a
        // later sync pass restores it losslessly instead of the bookmark
        // going through fresh (paid) AI enrichment. Safe to enqueue even for
        // a dedupe-matched existing bookmark — restoreAIEnrichment's
        // ON-CONFLICT-ignore write never clobbers a real enrichment already
        // there, so the worst case is a harmless no-op upload.
        if (item.source === "stash-backup" && item.enrichment) {
          nextEnrichmentRestores = enqueuePendingEnrichmentRestore(
            nextEnrichmentRestores,
            {
              bookmark_id: id,
              enrichment: item.enrichment,
              status: "pending",
              last_error: null,
              created_at: now,
            },
          );
          organizationChanged = true;
        }
      }

      if (organizationChanged) {
        pendingTagOpsRef.current = nextTagOps;
        setPendingTagOps(nextTagOps);
        tagDataRef.current = nextTagData;
        setTagData(nextTagData);
        pendingImportCollectionsRef.current = nextImportCollections;
        setPendingImportCollections(nextImportCollections);
        pendingEnrichmentRestoresRef.current = nextEnrichmentRestores;
        setPendingEnrichmentRestores(nextEnrichmentRestores);
      }

      if (newBookmarks.length > 0 || organizationChanged) {
        setBookmarks((current) => [...newBookmarks, ...(current ?? [])]);
        setQueue((current) => [...current, ...newEntries]);
        localCreateFlushesInFlight.current += 1;
        // Reserve every imported id in the enriching guard up front: the
        // pending-backfill effect fires on the next render (before the
        // sequential inserts below finish), and an enrichment fetch that beats
        // this row's durable insert would write the enriched row first — only
        // for the later insertBookmark (INSERT OR REPLACE on native) to replace
        // it with the stale pending snapshot (PR #594 review). Each row starts
        // enriching only once its own insert+enqueue has landed, which also
        // keeps the enriched update from being clobbered in the queue table.
        const reserved = new Set(newBookmarks.map((bookmark) => bookmark.id));
        for (const id of reserved) {
          enriching.current.add(id);
        }
        const releaseAndEnrich = (bookmark: Bookmark) => {
          if (reserved.delete(bookmark.id)) {
            enriching.current.delete(bookmark.id);
            enrichInBackground(bookmark);
          }
        };
        ensureRepositoryReady()
          .then(async () => {
            const epochAtStart = resetEpoch.current;
            if (resetEpoch.current !== epochAtStart) {
              recordLog("warn", "import: loop aborted by library reset");
              return;
            }
            const metaUpdates = organizationChanged
              ? {
                  [PENDING_TAG_OPS_KEY]: JSON.stringify(nextTagOps),
                  [PENDING_IMPORT_COLLECTIONS_KEY]: JSON.stringify(
                    nextImportCollections,
                  ),
                  [PENDING_ENRICHMENT_RESTORE_KEY]: JSON.stringify(
                    nextEnrichmentRestores,
                  ),
                }
              : undefined;
            if (repository.insertImportBatch && newBookmarks.length > 0) {
              await repository.insertImportBatch(newBookmarks, newEntries, {
                metaUpdates,
              });
              const ENRICH_BATCH_SIZE = 10;
              for (let i = 0; i < newBookmarks.length; i += ENRICH_BATCH_SIZE) {
                if (resetEpoch.current !== epochAtStart) {
                  break;
                }
                const chunk = newBookmarks.slice(i, i + ENRICH_BATCH_SIZE);
                for (const bookmark of chunk) {
                  releaseAndEnrich(bookmark);
                }
                if (i + ENRICH_BATCH_SIZE < newBookmarks.length) {
                  await new Promise((resolve) => setTimeout(resolve, 50));
                }
              }
            } else {
              if (metaUpdates) {
                for (const [key, value] of Object.entries(metaUpdates)) {
                  await repository.setMeta(key, value);
                }
              }
              for (let i = 0; i < newBookmarks.length; i += 1) {
                if (resetEpoch.current !== epochAtStart) {
                  recordLog("warn", "import: loop aborted by library reset");
                  break;
                }
                await repository.insertBookmark(newBookmarks[i]);
                await repository.enqueue(newEntries[i]);
                releaseAndEnrich(newBookmarks[i]);
              }
            }
          })
          .catch((error) => logStorageError("imported bookmarks", error))
          .finally(() => {
            localCreateFlushesInFlight.current = Math.max(
              0,
              localCreateFlushesInFlight.current - 1,
            );
            // Rows whose insert never ran (storage failure): still enrich them —
            // they live on in optimistic state, and enrichment must not be lost
            // to a storage error. Nothing durable exists to clobber anyway.
            for (const bookmark of newBookmarks) {
              releaseAndEnrich(bookmark);
            }
            if (localCreateFlushesInFlight.current === 0) {
              syncPendingRef.current = false;
              setTimeout(() => {
                void syncNowRef.current?.().catch(() => {});
              }, 50);
            }
          });
      }

      recordLog(
        "info",
        `import: finished items=${items.length} imported=${imported} duplicates=${duplicates} skipped=${skipped}`,
      );
      return { imported, duplicates, skipped };
    },
    [auth.userId, loadedBookmarks, enrichInBackground, isSyncingState],
  );

  // Record that the user just opened a bookmark (viewed its Detail or opened its
  // link), powering the "Recently opened" Inbox sort. Deliberately NOT routed
  // through applyBookmarkUpdate: last_accessed_at is a local-only field, so this
  // must not flip sync_status, enqueue a sync mutation, or bump updated_at (which
  // would wrongly re-send the row on the next sync). Just patch in memory and
  // persist locally, fire-and-forget.
  const markBookmarkAccessed = useCallback((id: string) => {
    // Build the updated row from the ref, not inside the setBookmarks updater:
    // the functional updater isn't guaranteed to run synchronously, so reading a
    // value it assigned would race the durable write below and could skip it,
    // leaving last_accessed_at lost after a reload.
    const existing = bookmarksRef.current?.find(
      (bookmark) => bookmark.id === id,
    );
    if (!existing) {
      return;
    }
    const updated: Bookmark = {
      ...existing,
      last_accessed_at: new Date().toISOString(),
    };
    setBookmarks((current) =>
      current === null
        ? current
        : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
    );
    // Keep the ref itself current immediately, not just via the `useEffect`
    // that mirrors it from `bookmarks` after the next render — same
    // rationale as applyBookmarkUpdate's identical line above: a bulk-create
    // reconcile pass reading bookmarksRef.current concurrently must see this
    // access timestamp, not a stale pre-access snapshot it would otherwise
    // write back and silently clobber (caught in PR review).
    bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
      bookmark.id === id ? updated : bookmark,
    );
    ensureRepositoryReady()
      .then(() => repository.updateBookmark(updated))
      .catch((error) => logStorageError("bookmark access", error));
  }, []);

  // On-demand YouTube availability check (STASH-61). Takes the URL from the
  // caller rather than re-reading it off `bookmarksRef` — the caller (a
  // Detail-screen mount effect) already has the just-rendered bookmark in
  // hand, whereas `bookmarksRef` is only mirrored from `bookmarks` state by a
  // separate effect and can still be a render behind on the very first mount
  // after the initial load, which would otherwise silently no-op the check.
  // Deliberately NOT routed through applyBookmarkUpdate, for the same reason
  // as markBookmarkAccessed above: video_unavailable is a local-only,
  // self-healing status read, not user- or server-authored data, so it must
  // never flip sync_status, enqueue a sync mutation, or bump updated_at.
  const checkVideoAvailability = useCallback((id: string, url: string | null | undefined) => {
    if (!url || !isYoutubeAvailabilityCandidate(url)) {
      return;
    }
    if (videoAvailabilityCheckingRef.current.has(id)) {
      return;
    }
    videoAvailabilityCheckingRef.current.add(id);
    checkYoutubeAvailability(url)
      .then((result) => {
        if (result === "unknown") {
          // Indeterminate (network error, timeout, non-OK status): leave the
          // current flag as-is rather than guess.
          return;
        }
        const unavailable = result === "unavailable";
        const latest = bookmarksRef.current?.find(
          (bookmark) => bookmark.id === id,
        );
        if (!latest || (latest.video_unavailable ?? false) === unavailable) {
          // Already reflects this result (or the bookmark is gone) — no write.
          return;
        }
        const updated: Bookmark = { ...latest, video_unavailable: unavailable };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
        );
        bookmarksRef.current = bookmarksRef.current!.map((bookmark) =>
          bookmark.id === id ? updated : bookmark,
        );
        return ensureRepositoryReady().then(() =>
          repository.updateBookmark(updated),
        );
      })
      .catch((error) => logStorageError("video availability check", error))
      .finally(() => {
        videoAvailabilityCheckingRef.current.delete(id);
      });
  }, []);

  const trashBookmark = useCallback(
    (id: string) => {
      applyBookmarkUpdate(id, { deleted_at: new Date().toISOString() });
      // Trashed: nothing left to retry enriching until restored — mirrors
      // deleteBookmark's cleanup so a discarded bookmark doesn't keep
      // consuming retry attempts (and, if one eventually succeeds, silently
      // write fresh AI suggestions for content the user just discarded).
      clearAiRetry(id);
      syncAiRetryIds();
      // A trashed bookmark has nothing left to wait for either — clear a
      // confirmed-server-queue marker the same way.
      clearAiServerQueued(id);
    },
    [applyBookmarkUpdate, clearAiRetry, syncAiRetryIds, clearAiServerQueued],
  );

  const restoreBookmark = useCallback(
    (id: string) => applyBookmarkUpdate(id, { deleted_at: null }),
    [applyBookmarkUpdate],
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

  const updateBookmarkFields = useCallback(
    (id: string, fields: { title?: string; notes?: string }) => {
      const before = bookmarksRef.current?.find(
        (bookmark) => bookmark.id === id,
      );
      const patch: Partial<Bookmark> = {};
      if (fields.title !== undefined) {
        patch.title = fields.title.trim() || null;
        patch.title_is_derived = patch.title === null ? undefined : false;
      }
      if (fields.notes !== undefined) {
        patch.notes = fields.notes.trim() || null;
      }
      // Only stale on a real change to user-editable text; a no-op save (or a
      // collection/archive change, which never routes through here) must not.
      const textChanged =
        (patch.title !== undefined &&
          patch.title !== (before?.title ?? null)) ||
        (patch.notes !== undefined && patch.notes !== (before?.notes ?? null));
      applyBookmarkUpdate(id, patch);
      if (textChanged) {
        if (patch.title !== undefined && !hasSyncedOnce(id)) {
          pendingUserTitleEdits.current.add(id);
        }
        markEnrichmentStale(id);
      }
    },
    [applyBookmarkUpdate, hasSyncedOnce, markEnrichmentStale],
  );

  const refreshBookmarkPreview = useCallback(
    async (id: string): Promise<string | null> => {
      const bookmark = bookmarksRef.current?.find((item) => item.id === id);
      if (!bookmark?.url) {
        return "Preview refresh needs a URL bookmark.";
      }
      if (previewRefreshingIds.has(id)) {
        return null;
      }
      setPreviewRefreshingIds((prev) => new Set(prev).add(id));
      try {
        const userTitle = bookmark.title_is_derived === false;
        const refreshTarget: Bookmark = {
          ...bookmark,
          title: userTitle ? bookmark.title : null,
          site_name: null,
          favicon_url: null,
          preview_image_url: null,
        };
        const { patch, metadata_status } = await enrichBookmark(refreshTarget);
        const nextPatch: Partial<Bookmark> = { metadata_status };
        if (!userTitle && patch.title !== undefined) {
          nextPatch.title = patch.title;
          nextPatch.title_is_derived = patch.title_is_derived;
        }
        if (patch.site_name !== undefined) {
          nextPatch.site_name = patch.site_name;
        }
        if (patch.favicon_url !== undefined) {
          nextPatch.favicon_url = patch.favicon_url;
        }
        if (patch.preview_image_url !== undefined) {
          nextPatch.preview_image_url = patch.preview_image_url;
        }
        const latest =
          bookmarksRef.current?.find((item) => item.id === id) ?? bookmark;
        const syncsRemotely = hasSyncedOnce(id);
        const updated: Bookmark = {
          ...latest,
          ...nextPatch,
          sync_status: syncsRemotely ? "pending" : latest.sync_status,
          ever_synced: syncsRemotely ? true : latest.ever_synced,
          updated_at: new Date().toISOString(),
        };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((item) => (item.id === id ? updated : item)),
        );
        // Keep the ref current immediately — same rationale as
        // enrichInBackground's identical line: another local-only writer
        // (checkVideoAvailability) reading bookmarksRef.current moments later
        // must see this refreshed metadata, not a pre-refresh snapshot it
        // would otherwise revert (PR review, STASH-61).
        bookmarksRef.current = bookmarksRef.current
          ? bookmarksRef.current.map((item) => (item.id === id ? updated : item))
          : bookmarksRef.current;
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
          if (metadata_status === "failed") {
            await repository.deleteEnrichment(id);
            setEnrichments((current) =>
              current.filter((item) => item.bookmark_id !== id),
            );
          }
        } catch (error) {
          logStorageError("preview refresh", error);
        }
        if (syncsRemotely) {
          enqueueMutation(id, "update");
        }
        // STASH #573: 'off' means never auto-trigger AI enrichment. This is a
        // direct continuation of the user's own "refresh preview" tap (not a
        // background batch), so it fires immediately rather than through the
        // staggered burst queue below.
        if (
          metadata_status !== "failed" &&
          aiSuggestionsModeRef.current !== "off"
        ) {
          void requestAiEnrichmentRef
            .current?.(id, "auto", {
              title: updated.title,
              description: updated.description,
              notes: updated.notes,
              site_name: updated.site_name,
              content_type: updated.content_type,
            })
            .catch(() => {});
        }
        return null;
      } catch (error) {
        recordLog(
          isTransientNetworkError(error) ? "warn" : "error",
          `preview refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return "Could not refresh the preview.";
      } finally {
        setPreviewRefreshingIds((prev) => {
          if (!prev.has(id)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [enqueueMutation, previewRefreshingIds, hasSyncedOnce],
  );

  const deleteBookmark = useCallback(
    (id: string) => {
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
    applyPendingImportCollections,
    applyPendingEnrichmentRestores,
    applyTagData,
    applyTagOps,
    dropAiRetryBookkeeping,
  ]);

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
    if (syncInFlight.current && !syncPausedRef.current) {
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
    setIsResettingLibrary(true);
    try {
      try {
        // Refresh a token that expired while the app stayed open, mirroring
        // syncNow — otherwise the RPC would 401 against a stale bearer.
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
        await createSyncApi(session).resetLibrary();
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
      aiTriggerAttempted.current.clear();
      void persistAiRetryState();
      void persistAiServerQueued();
      void persistPendingAiTrigger();
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
      return { ok: true };
    } finally {
      syncInFlight.current = false;
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
    syncAiRetryIds,
    syncAiServerQueuedIds,
  ]);

  // Push queued tag ops to the server when online: ensure tags exist, reconcile
  // the optimistic local tag id to the server one, and drop the op on success.
  // Failures stay queued for the next sync. "add" ops for bookmarks that have
  // already synced are grouped by bookmark and pushed through the batch-attach
  // RPC in chunks of BULK_CREATE_SYNC_CHUNK_SIZE (issue #713) instead of one
  // `addTags` call per (bookmark, tag) pair — a bulk import's ~3 tags per
  // bookmark used to mean 3,000+ sequential round trips for 1,000 bookmarks
  // (Sentry STASH-5F/5G/5D). "remove" ops stay one-per-op, unchanged: imports
  // never enqueue removes, and removes are always low-volume interactive edits.
  const syncTagOps = useCallback(async (): Promise<boolean> => {
    if (!auth.session) {
      return false;
    }
    // Tag adds/removes call this directly (not just syncNow's own call site
    // below), so the pause guard has to live here too — otherwise a tag edit
    // made while paused would upload immediately, breaking the "nothing
    // uploads until you turn this off" promise (Sentry STASH-3K review). The
    // op stays queued in pendingTagOpsRef and uploads once unpaused.
    if (syncPausedRef.current) {
      return false;
    }
    const ops = pendingTagOpsRef.current;
    if (ops.length === 0) {
      return false;
    }
    let mutationsPushed = false;
    const api = createSyncApi(auth.session);

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
              reconcileSyncedAdd(tagDataRef.current, matchingOp.tag_name, serverTag),
              { persist: false },
            );
            applyTagOps(
              dequeueTagOp(
                pendingTagOpsRef.current,
                result.bookmark_id,
                matchingOp.tag_name,
              ),
              { persist: false },
            );
            mutationsPushed = true;
          }
        }
      } catch (error) {
        // Keep the ops queued; the next sync retries the whole chunk.
        recordLog(
          "warn",
          `tag sync failed (bulk add, ${chunkIds.length} bookmarks): ${String(error)}`,
        );
      }
    }

    for (const op of ops) {
      if (op.op !== "remove" || !hasSyncedOnce(op.bookmark_id)) {
        continue;
      }
      try {
        await api.removeTags({
          bookmark_id: op.bookmark_id,
          tags: [op.tag_name],
        });
        applyTagOps(
          dequeueTagOp(pendingTagOpsRef.current, op.bookmark_id, op.tag_name),
          { persist: false },
        );
        mutationsPushed = true;
      } catch (error) {
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
        await repository.setMeta(
          PENDING_TAG_OPS_KEY,
          JSON.stringify(pendingTagOpsRef.current),
        );
      } catch (error) {
        logStorageError("tag ops", error);
      }
      broadcastSyncNudgeRef.current?.();
    }
    return mutationsPushed;
  }, [auth.session, applyTagData, applyTagOps, hasSyncedOnce]);

  // Local-first: apply the tag immediately and queue the upload. Works offline
  // and the moment a bookmark has synced; the queued op uploads on the next sync.
  const addTagsToBookmark = useCallback(
    async (bookmarkId: string, names: string[]): Promise<string | null> => {
      if (!hasSyncedOnce(bookmarkId)) {
        return "Tags can be added once this bookmark has synced.";
      }
      const cleaned = names
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      if (cleaned.length === 0) {
        return "Enter a tag name.";
      }
      const userId = auth.userId ?? mockUserId;
      const now = new Date().toISOString();
      let nextData = tagDataRef.current;
      let nextOps = pendingTagOpsRef.current;
      for (const name of cleaned) {
        const op: PendingTagOp = {
          id: makeUuid(),
          bookmark_id: bookmarkId,
          tag_name: name,
          op: "add",
          source: "user",
          confidence: null,
          created_at: now,
        };
        nextData = applyTagOp(nextData, op, userId);
        nextOps = enqueueTagOp(nextOps, op);
      }
      applyTagData(nextData);
      applyTagOps(nextOps);
      void syncTagOps();
      return null;
    },
    [auth.userId, applyTagData, applyTagOps, syncTagOps, hasSyncedOnce],
  );

  const removeTagFromBookmark = useCallback(
    async (bookmarkId: string, tagName: string): Promise<string | null> => {
      if (!hasSyncedOnce(bookmarkId)) {
        return "Seeded sample tags cannot be edited.";
      }
      const op: PendingTagOp = {
        id: makeUuid(),
        bookmark_id: bookmarkId,
        tag_name: tagName,
        op: "remove",
        source: "user",
        confidence: null,
        created_at: new Date().toISOString(),
      };
      applyTagData(
        applyTagOp(tagDataRef.current, op, auth.userId ?? mockUserId),
      );
      applyTagOps(enqueueTagOp(pendingTagOpsRef.current, op));
      void syncTagOps();
      return null;
    },
    [auth.userId, applyTagData, applyTagOps, syncTagOps, hasSyncedOnce],
  );

  // Ask the backend to (re)generate AI suggestions for a synced bookmark. The
  // edge function writes the enrichment and returns it, so we surface results
  // immediately rather than waiting for the next pull. Fire-and-forget safe:
  // failures (e.g. the function isn't deployed yet) just return a message.
  const requestAiEnrichment = useCallback(
    async (
      bookmarkId: string,
      source: "auto" | "manual" = "manual",
      overrideMetadata?: EnrichmentMetadataHint,
    ): Promise<string | null> => {
      if (!auth.session) {
        return "AI suggestions need the cloud — Supabase is not available right now.";
      }
      // The id may come from a queued dispatch (the stagger drain, a retry
      // check) that outlived its bookmark — deleted, or wiped by a library
      // reset. Don't fetch suggestions for a row that no longer exists
      // locally; report success so stale trigger markers get cleaned up. Must
      // run BEFORE hasSyncedOnce: that check can't tell "gone" from "never
      // synced" (both read as "no bookmark found"), and this one needs to win.
      if (!bookmarksRef.current?.some((item) => item.id === bookmarkId)) {
        return null;
      }
      if (!hasSyncedOnce(bookmarkId)) {
        return "AI suggestions are available once this bookmark has synced.";
      }
      if (aiEnriching.current.has(bookmarkId)) {
        return null;
      }
      // Library-reset race guard: snapshot the epoch now; every settle path
      // below re-checks it and discards if a reset completed meanwhile.
      const epochAtStart = resetEpoch.current;
      aiEnriching.current.add(bookmarkId);
      setEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      if (source === "manual") {
        setManualEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      }
      // Hoisted above the try/catch so the 429 handler below can enqueue the
      // overflow-queue insert with the SAME freshly-ensured session the
      // request itself used, instead of falling back to the possibly-stale
      // `auth.session` (see the comment on the assignment below for why that
      // matters — reusing it there caused the enqueue's own RLS check to
      // reject the insert (STASH-49): `pending_ai_enrichment`'s policy
      // requires `auth.uid()` to match the row, and a stale `auth.session`
      // can resolve to a different auth context than the one this call
      // proved was current).
      let session: SupabaseAuthSession | null = null;
      try {
        // The edge function forwards this access token to PostgREST, which 401s
        // on a stale one. The token can expire while the app sits idle, so
        // refresh it before the call (as the sync paths do) instead of reusing
        // the possibly-expired `auth.session`.
        session = (await auth.ensureAnonymousSession()) ?? auth.session;
        if (!session) {
          return "AI suggestions need the cloud — Supabase is not available right now.";
        }
        // Send the device's freshest metadata: the cloud row can still be a bare
        // URL (on-device OpenGraph enrichment may not have synced yet), and the
        // model would otherwise have nothing to reason about.
        const latest = bookmarksRef.current?.find(
          (item) => item.id === bookmarkId,
        );
        const metadata: EnrichmentMetadataHint | undefined =
          overrideMetadata ??
          (latest
            ? {
                title: latest.title,
                description: latest.description,
                notes: latest.notes,
                site_name: latest.site_name,
                content_type: latest.content_type,
              }
            : undefined);
        const activeLocale = localeRef.current;
        let enrichment: AIEnrichment;
        try {
          enrichment = await createSyncApi(session).requestEnrichment(
            bookmarkId,
            metadata,
            activeLocale,
          );
        } catch (error) {
          // If the server still rejects the token (rotation / clock skew),
          // force a refresh and retry once before surfacing the error.
          if (error instanceof SupabaseRequestError && error.status === 401) {
            const refreshed =
              (await auth.ensureAnonymousSession(true)) ?? session;
            // Codex review (PR #649): this used to retry with `refreshed`
            // but leave the outer `session` pointing at the rejected one —
            // so if this retry itself came back 429, the 429 handler below
            // would enqueue with the SAME session PostgREST just 401'd,
            // rather than the one that actually reached the rate-limit
            // check. Reassign so every later use of `session` (including
            // the enqueue diagnostics) reflects what this call actually used.
            session = refreshed;
            enrichment = await createSyncApi(refreshed).requestEnrichment(
              bookmarkId,
              metadata,
              activeLocale,
            );
          } else {
            throw error;
          }
        }
        // A library reset completed while this request was in flight: the
        // bookmark (and its cloud row) are gone, so discard the result rather
        // than resurrect an enrichment for it in the just-cleared state.
        if (resetEpoch.current !== epochAtStart) {
          return null;
        }
        // Newest enrichment for this bookmark wins (getEnrichment also picks newest).
        setEnrichments((current) => [
          enrichment,
          ...current.filter((item) => item.bookmark_id !== bookmarkId),
        ]);
        try {
          await ensureRepositoryReady();
          await repository.upsertEnrichments([enrichment]);
        } catch (error) {
          logStorageError("ai enrichment", error);
        }
        // A written enrichment row means this bookmark no longer needs a
        // retry — clear any armed marker from an earlier failed attempt
        // (auto or manual; unified — see armAiRetry below).
        clearAiRetry(bookmarkId);
        // Covers a later attempt (local retry, manual tap) succeeding
        // directly rather than via the overflow queue's delivery: this
        // bookmark no longer needs the "queued, will arrive automatically"
        // note either, since it just arrived right here.
        clearAiServerQueued(bookmarkId);
        // STASH #573 auto_accept mode: apply high-confidence tag/folder
        // suggestions with no review step. Runs AFTER the enrichment is
        // durably recorded and retry state is cleared, and in its own
        // try/catch: this is a convenience layered on top of an already-
        // successful fetch, so a bug here (e.g. a failed createCollection
        // call) must never make a genuinely successful enrichment look like
        // a failed attempt (which would both discard the fetched enrichment
        // above — it never happened, the write already landed — and wrongly
        // arm a retry for a request that actually succeeded).
        if (aiSuggestionsModeRef.current === "auto_accept") {
          try {
            await autoAcceptEnrichmentRef.current?.(bookmarkId, enrichment);
          } catch (error) {
            recordLog(
              "warn",
              `ai-enrich auto_accept failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // A background auto-enrichment lands without the user looking at this
        // bookmark, so flag it for the Inbox "new suggestions" banner. A manual
        // "Suggest with AI" tap happens on the Detail screen — the user is
        // already witnessing it — so it doesn't (and Detail clears the flag).
        // In auto_accept mode this only fires for whatever auto-accept left
        // behind (e.g. a pending summary — auto-accept never touches notes).
        if (source === "auto") {
          noteUnseenSuggestions(enrichment);
        }
        return null;
      } catch (error) {
        // A library reset completed while this request was in flight: the
        // bookmark is gone, so record nothing — no retry marker, no overflow
        // enqueue — or the reset's just-emptied bookkeeping gets repopulated.
        if (resetEpoch.current !== epochAtStart) {
          return error instanceof Error
            ? error.message
            : "Could not generate AI suggestions.";
        }
        // Any failure here writes no ai_enrichments row: arm (or re-arm) this
        // bookmark's backoff-scheduled retry marker regardless of source, so a
        // failed manual "Suggest with AI" tap is retried the same as a failed
        // auto-trigger (unifying what used to be auto-only bookkeeping).
        // Awaited: the replacement marker's write must be durably confirmed
        // before the pending-trigger marker below is even issued for removal
        // — otherwise a process kill between two unawaited fire-and-forget
        // writes could still leave storage with the trigger cleared and the
        // retry marker never written, reopening the crash window this
        // ordering exists to close (see armAiRetry/persistAiRetryState).
        const retryStateArmed = await armAiRetry(bookmarkId);
        // The crash-safety marker (PENDING_AI_TRIGGER_KEY) only needs to
        // survive from launch until this first attempt's outcome is durably
        // recorded — success clears it below in the settle handler; failure
        // now has its durable trace in `ai_suggestion_retry` via armAiRetry
        // above, so clear it here too. Otherwise a relaunch inside the
        // backoff window rehydrates it and the deferred first-trigger effect
        // fires `requestAiEnrichment` again immediately, bypassing the whole
        // backoff schedule on every restart. But only once armAiRetry's write
        // is confirmed — if it didn't actually land, clearing this now would
        // leave nothing durable recording the failed attempt at all, and a
        // relaunch inside the backoff window would silently never retry.
        if (retryStateArmed) {
          await clearPendingAiTrigger(bookmarkId);
        }
        // Rate limited (429): expected when many bookmarks are captured at once.
        // Return a sentinel the Detail screen (still) localizes into a calm
        // message pending its own follow-up UI change.
        if (error instanceof SupabaseRequestError && error.status === 429) {
          // STASH-4K follow-up: a 429 here always means the per-user quota is
          // exhausted (the only failure mode this endpoint returns 429 for)
          // — pause the staggered AUTO drain so a large backlog doesn't keep
          // firing requests that are each a guaranteed repeat of this same
          // rejection. Manual "Suggest with AI" taps bypass this (see the
          // drain effect below, which only gates the auto path).
          // Codex review (round 2, PR #655): a request started under account A
          // can still be in flight when the user switches to account B — the
          // account-switch effect clears the cooldown first, but this stale
          // A response would then arm a fresh one and wrongly throttle B.
          // Only apply it if the account that made this request is still the
          // active one (lastSyncedUserId.current — the same ref the
          // account-switch effect itself updates). Codex review (PR #664):
          // an anonymous request can still be in flight when OAuth linking
          // completes — id-only equality still matches (linking preserves
          // the id), so also require the captured session's anonymity to
          // match wasAnonymousRef.current (kept live by the link-clear
          // effect below, same forward-reference-via-ref pattern as
          // autoAcceptEnrichmentRef) rather than reading `auth.session`
          // directly here — this callback's own closure can be just as
          // stale as `session` itself if it was created before the link
          // completed. Without this, a late anonymous-quota 429 would
          // repopulate aiQuotaExceeded with the just-upgraded account's
          // obsolete (10/hr, 50/day) limits right after the link effect
          // cleared it.
          //
          // Codex review round 2: `lastSyncedUserId.current` is only reset
          // by an actual NEW sign-in, not by a session disappearing
          // (session_expired / signed-out with nothing minted yet) — so it
          // still matches the departed user's id in that case. Coalescing
          // `wasAnonymousRef.current` to `false` when it's `null` (no
          // current session at all) would then falsely "match" a captured
          // non-anonymous session's `is_anonymous: false`, letting a late
          // 429 through with no live session to even own the resulting
          // cooldown/display state. Requiring `!== null` here (there IS a
          // current session) closes that, on top of the anonymity check.
          if (
            session &&
            session.user.id === lastSyncedUserId.current &&
            wasAnonymousRef.current !== null &&
            (session.user.is_anonymous !== false) === wasAnonymousRef.current
          ) {
            let cooldownMs = AI_QUOTA_HOURLY_COOLDOWN_MS;
            if (error.reason === "daily_limit") {
              cooldownMs = AI_QUOTA_DAILY_COOLDOWN_MS;
            } else if (
              typeof error.retryAfterSeconds === "number" &&
              error.retryAfterSeconds >=
                AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S.min &&
              error.retryAfterSeconds <=
                AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S.max
            ) {
              // Codex review (PR #655): the server computes this exactly for
              // hourly_limit — trust it instead of the fixed fallback so a
              // near-expired window doesn't idle the queue for minutes longer
              // than necessary, and a nearly-full hour doesn't get probed
              // before a slot can actually open.
              cooldownMs = error.retryAfterSeconds * 1000;
            }
            aiQuotaCooldownUntil.current = Date.now() + cooldownMs;
            // Display-only mirror (Settings backlog row, feedback
            // diagnostics): unlike `cooldownMs` above (deliberately capped so
            // the drain loop re-probes periodically rather than idling for a
            // full day), this uses the server's real retry_after verbatim —
            // accurate for both hourly_limit and daily_limit as of the
            // request_ai_enrichment_slot migration that computes it from the
            // oldest request in each window, not a flat guess.
            const displaySeconds =
              typeof error.retryAfterSeconds === "number" &&
              error.retryAfterSeconds > 0
                ? error.retryAfterSeconds
                : cooldownMs / 1000;
            setAiQuotaExceeded({
              reason: error.reason ?? "rate_limited",
              retryAt: Date.now() + displaySeconds * 1000,
            });
          }
          // STASH #578 Phase 2: instead of just returning the rate-limited
          // sentinel, enqueue this bookmark for the background overflow
          // worker to retry later. Fire-and-forget in the strictest sense —
          // wrapped in its own try/catch (not just a promise .catch(), since a
          // missing session or a synchronous throw must not escape either):
          // an enqueue failure must never change what the caller sees for
          // this 429, and is never retried here.
          if (session) {
            // STASH-4D/4E: production keeps reporting "new row violates row-
            // level security policy for table pending_ai_enrichment" on this
            // insert even on builds carrying STASH-49's fix (this call
            // already reuses `session`, not the possibly-stale `auth.session`
            // — see the comment where `session` is assigned above). The same
            // session's token is independently proven valid moments earlier:
            // the edge function's forwarded-auth GET of this exact bookmark,
            // inside requestEnrichment above, just succeeded. Static review
            // of both call sites finds nothing further wrong, so capture
            // enough about the session actually used here — instead of
            // guessing a further fix — to tell "wrong identity" from
            // "empty/expired token" from "a session object requestEnrichment
            // didn't use" apart on the next occurrence.
            //
            // Codex review (PR #649) on the first cut of this diagnostic:
            // - `session === auth.session` is nearly always false even in
            //   the healthy case, since ensureAnonymousSession() restores
            //   from storage and allocates a fresh object every call — it
            //   can't distinguish "actually different" from "just
            //   re-deserialized". Compare the token VALUE instead.
            // - session.user.id is only what the JS session object claims;
            //   the RLS check evaluates auth.uid() from the access token's
            //   own `sub` claim. Decode it locally (jwtSubject — no
            //   atob/Buffer dependency, never logs the raw token) so a
            //   divergence between the two is directly visible instead of
            //   assumed away.
            // Field names here deliberately avoid "token"/"auth"/"session"/
            // "secret"/"credential" — Sentry's default project-level Data
            // Scrubber redacts (replaces with "[Filtered]") any value whose
            // containing field looks like one of those words, and since each
            // log line ships as one opaque string (not a structured object
            // Sentry can scrub key-by-key), a single matched word blanks the
            // WHOLE line — including the original error text before it. The
            // first cut of this diagnostic used exactly those words and every
            // occurrence came back as "[Filtered]" (STASH-4F), hiding even
            // the baseline message that used to be visible pre-#649.
            //
            // STASH-4G/4H: with the scrubbing fixed, real diagnostics came
            // back — and every field was healthy (correct owner, JWT sub
            // matches, not anonymous, same bearer as the reactive session,
            // ~an hour from expiry), repeated across a dozen+ failures. That
            // rules out every session-identity theory this diagnostic was
            // built to test. What's left of the insert policy is the OTHER
            // clause: `EXISTS (SELECT 1 FROM bookmarks WHERE id = bookmark_id
            // AND user_id = auth.uid())`. Since auth.uid() is now proven
            // correct, a failure there means THIS bookmark_id specifically
            // doesn't resolve — logging it is what actually lets that be
            // checked against the database on the next occurrence.
            const jwtSub = jwtSubject(session.access_token);
            const enqueueSessionDiagnostics = JSON.stringify({
              bookmarkId,
              enqueueOwnerId: session.user.id,
              jwtSubMatchesOwnerId:
                jwtSub === null ? null : jwtSub === session.user.id,
              ownerIsAnonymous: session.user.is_anonymous ?? null,
              reactiveOwnerId: auth.session?.user.id ?? null,
              bearerMatchesReactive:
                session.access_token === auth.session?.access_token,
              bearerLength: session.access_token?.length ?? 0,
              expiresAt: session.expires_at ?? null,
              secondsUntilExpiry:
                session.expires_at != null
                  ? session.expires_at - Math.floor(Date.now() / 1000)
                  : null,
            });
            // Snapshotted now (before the enqueue POST's round trip) so the
            // .then() below can detect a set-after-clear race: this call's
            // own aiEnriching guard releases in the `finally` below as soon
            // as this 429 branch returns, well before this un-awaited
            // promise settles — so a later call for the SAME bookmark (a
            // manual retry, which deliberately ignores backoff and fires
            // immediately) can start and even succeed in the meantime,
            // landing a real enrichment and calling clearAiServerQueued
            // (currently a no-op, since nothing is set yet). If this
            // confirmation then lands afterward and sets the marker
            // unconditionally, nothing would ever clear it again — the
            // sync-pull clear only fires for a strictly newer arrival, and
            // this bookmark is already done. Reference identity, not a
            // timestamp: `updated_at` is server time and has no reliable
            // relationship to the client clock at enqueue time, but every
            // write to `enrichments` (direct success or sync-pull) replaces
            // the array with fresh objects, so an unchanged reference here
            // reliably means "nothing arrived for this bookmark meanwhile".
            const enrichmentBeforeEnqueue = enrichmentsRef.current.find(
              (item) => item.bookmark_id === bookmarkId,
            );
            // CONFIRMED: the server durably accepted this bookmark into the
            // overflow queue, so the background worker will deliver a real
            // result via normal sync. Only set on this resolution — never
            // eagerly, and never from a failure branch, which falls back to
            // the generic armAiRetry marker above alone.
            //
            // But skip it if a real enrichment already landed for this
            // bookmark since the enqueue was fired (a faster manual retry,
            // or — in principle — an extremely fast worker delivery): marking
            // it queued now would strand a "will arrive automatically" note
            // on an already-complete bookmark forever. See the snapshot
            // comment above. Un-awaited, so this can also land AFTER a
            // library reset that ran while the enqueue round-tripped — in
            // which case the reference-equality check below would pass
            // vacuously (both sides undefined once the reset emptied the
            // cache) and strand a marker for a deleted bookmark. Same epoch
            // guard as the other settle paths.
            const enqueueSession = session;
            const attemptEnqueue = async (): Promise<void> => {
              await createSyncApi(enqueueSession).enqueuePendingEnrichment(
                bookmarkId,
                localeRef.current ?? undefined,
              );
              if (resetEpoch.current !== epochAtStart) {
                return;
              }
              const enrichmentNow = enrichmentsRef.current.find(
                (item) => item.bookmark_id === bookmarkId,
              );
              if (enrichmentNow === enrichmentBeforeEnqueue) {
                markAiServerQueued(bookmarkId);
              }
            };
            try {
              attemptEnqueue().catch(async (enqueueError: unknown) => {
                // STASH-4J: a single bounded retry for the specific failure
                // this diagnostic (STASH-4G/4H) already proved is transient
                // — an RLS violation (HTTP 403) with otherwise healthy
                // session/identity diagnostics and a bookmark that
                // demonstrably exists. Anything else (network failure, a
                // genuine permissions problem) logs immediately, unretried,
                // same as before.
                if (
                  !(enqueueError instanceof SupabaseRequestError) ||
                  enqueueError.status !== 403
                ) {
                  recordLog(
                    "warn",
                    `pending_ai_enrichment enqueue failed: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)} ${enqueueSessionDiagnostics}`,
                  );
                  return;
                }
                await new Promise((resolve) =>
                  setTimeout(resolve, ENQUEUE_RLS_RETRY_DELAY_MS),
                );
                try {
                  await attemptEnqueue();
                } catch (retryError) {
                  recordLog(
                    "warn",
                    `pending_ai_enrichment enqueue failed after retry: ${retryError instanceof Error ? retryError.message : String(retryError)} ${enqueueSessionDiagnostics}`,
                  );
                }
              });
            } catch (enqueueError) {
              recordLog(
                "warn",
                `pending_ai_enrichment enqueue threw: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)} ${enqueueSessionDiagnostics}`,
              );
            }
          }
          return AI_RATE_LIMITED;
        }
        // Anything else is a genuine failure the user can't act on (e.g. the
        // ai-enrich edge function returning 400/500). It was only ever surfaced
        // in the Detail UI; record it so it also lands in the in-app diagnostics
        // buffer and reaches Sentry (URL/email-scrubbed at the bridge), the way
        // preview-fetch failures already do — otherwise an outage is invisible.
        const detail = error instanceof Error ? error.message : String(error);
        const isHttpError = error instanceof SupabaseRequestError;
        const status = isHttpError ? ` (HTTP ${error.status})` : "";
        // A raw client-side transport failure (device offline, DNS unresolved)
        // never reached the function — an expected condition, not an outage — so
        // log it as a warn breadcrumb instead of an error that forwards to Sentry
        // and floods the issue stream (STASH-4). A SupabaseRequestError means the
        // function actually responded with an error status: a genuine server/
        // function failure that stays at 'error' even when its body echoes a
        // transport-looking message (e.g. the function's own upstream fetch failed).
        const level =
          !isHttpError && isTransientNetworkError(error) ? "warn" : "error";
        recordLog(level, `ai-enrich failed${status}: ${detail}`);
        return error instanceof Error
          ? error.message
          : "Could not generate AI suggestions.";
      } finally {
        aiEnriching.current.delete(bookmarkId);
        const remove = (prev: ReadonlySet<string>): ReadonlySet<string> => {
          if (!prev.has(bookmarkId)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(bookmarkId);
          return next;
        };
        setEnrichingIds(remove);
        if (source === "manual") {
          setManualEnrichingIds(remove);
        }
        // Refresh the reactive retry-id mirror in this same synchronous block
        // as the isEnriching flip above (see aiRetryIds' declaration comment)
        // — armAiRetry/clearAiRetry above have already updated the ref.
        syncAiRetryIds();
      }
    },
    [
      auth,
      noteUnseenSuggestions,
      armAiRetry,
      clearAiRetry,
      syncAiRetryIds,
      clearPendingAiTrigger,
      markAiServerQueued,
      clearAiServerQueued,
      hasSyncedOnce,
    ],
  );
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
      if (!hasSyncedOnce(bookmarkId)) {
        return "Tags can be added once this bookmark has synced.";
      }
      const valid = suggestions.filter(
        (suggestion) => suggestion.name.trim().length > 0,
      );
      if (valid.length === 0) {
        return null;
      }
      const userId = auth.userId ?? mockUserId;
      const now = new Date().toISOString();
      let nextData = tagDataRef.current;
      let nextOps = pendingTagOpsRef.current;
      for (const suggestion of valid) {
        const op: PendingTagOp = {
          id: makeUuid(),
          bookmark_id: bookmarkId,
          tag_name: suggestion.name,
          op: "add",
          source: "ai",
          confidence: suggestion.confidence,
          created_at: now,
        };
        nextData = applyTagOp(nextData, op, userId);
        nextOps = enqueueTagOp(nextOps, op);
      }
      applyTagData(nextData);
      applyTagOps(nextOps);
      // Accepting a suggestion counts as reviewing it, so removing the tag later
      // won't bring the "✨" badge back for a name the user already decided on.
      markSuggestionsReviewed(
        bookmarkId,
        valid.map((suggestion) => suggestion.name),
      );
      void syncTagOps();
      return null;
    },
    [
      auth.userId,
      applyTagData,
      applyTagOps,
      markSuggestionsReviewed,
      syncTagOps,
      hasSyncedOnce,
    ],
  );

  const assignCollection = useCallback(
    (bookmarkId: string, collectionId: string | null) => {
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
      applyBookmarkUpdate(bookmarkId, { collection_id: collectionId });
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

  // Same batch-attach RPC as syncTagOps above (issue #713): group eligible
  // imported-collection intents by bookmark, chunk, and resolve-or-create each
  // collection server-side in one call per chunk instead of one
  // `createCollection`/`updateBookmark` round trip per bookmark.
  const syncPendingImportCollections =
    useCallback(async (): Promise<boolean> => {
      if (!auth.session || syncPausedRef.current) {
        return false;
      }
      const eligible = pendingImportCollectionsRef.current.filter((item) =>
        hasSyncedOnce(item.bookmark_id),
      );
      if (eligible.length === 0) {
        return false;
      }

      const api = createSyncApi(auth.session);
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
    useCallback(async (): Promise<boolean> => {
      if (!auth.session || syncPausedRef.current) {
        return false;
      }
      const eligible = pendingEnrichmentRestoresRef.current.filter((item) =>
        hasSyncedOnce(item.bookmark_id),
      );
      if (eligible.length === 0) {
        return false;
      }

      const api = createSyncApi(auth.session);
      let mutationsPushed = false;

      for (
        let i = 0;
        i < eligible.length;
        i += BULK_CREATE_SYNC_CHUNK_SIZE
      ) {
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
      options: { persist?: boolean } = {},
    ): Promise<IdentityRekeyState> => {
      for (const [oldId, newId] of idMap) {
        idAliases.current.set(oldId, newId);
      }
      const rekeyedTagOps = rekeyPendingTagOps(pendingTagOpsRef.current, idMap);
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
    },
    [remapAiRetryIdentity],
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
        const previousUserId = await repository.getMeta(SYNCED_USER_ID_KEY);
        const previousAnon =
          (await repository.getMeta(SYNCED_USER_ANON_KEY)) === "true";
        const plan = planAccountTransition(
          previousUserId
            ? { id: previousUserId, isAnonymous: previousAnon }
            : null,
          currentUser,
          bookmarksRef.current ?? [],
        );
        await applyAccountTransition(
          plan,
          repository,
          setBookmarks,
          setQueue,
          makeBookmarkId,
          ensureRepositoryReady,
          {
            rehome: (idMap) => rekeyBookmarkIdentity(idMap, { persist: false }),
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
        );
        return true;
      } catch (error) {
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
    ],
  );

  const syncNow = useCallback(
    async (options?: { force?: boolean }): Promise<boolean> => {
      const force = options?.force === true;
      if (syncInFlight.current) {
        syncPendingRef.current = true;
        return false;
      }
      if (localCreateFlushesInFlight.current > 0) {
        syncPendingRef.current = true;
        return false;
      }
      if (!auth.session) {
        return false;
      }
      if (syncPausedRef.current) {
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
        await ensureRepositoryReady();
        const previousUserId = await repository.getMeta(SYNCED_USER_ID_KEY);
        const sessionUser = auth.session.user;
        if (previousUserId !== null && previousUserId !== sessionUser.id) {
          syncInFlight.current = true;
          try {
            await reconcileAccountTransition({
              id: sessionUser.id,
              isAnonymous: sessionUser.is_anonymous !== false,
            });
          } finally {
            syncInFlight.current = false;
          }
        }
        syncPendingRef.current = true;
        return false;
      }
      syncInFlight.current = true;
      setIsSyncing(true);
      let mutationsPushed = false;
      let syncFailed = 0;
      try {
        await ensureRepositoryReady();
        // Re-ensure the session so a token that expired while the app stayed
        // open is refreshed before we sync; otherwise every entry would fail
        // against a stale bearer token until restart.
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
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
        const durableBookmarks = await repository.listBookmarks();
        const durableQueue = await repository.listQueue();
        bookmarksRef.current = durableBookmarks;
        queueRef.current = durableQueue;
        setBookmarks(durableBookmarks);
        setQueue(durableQueue);

        // Upload-then-pull: even with nothing to upload, the pull still runs.
        // Defer creates whose metadata is still fetching, so that metadata rides
        // along with the create payload instead of syncing twice.
        const syncable = durableQueue.filter((entry) => {
          // `force` (Settings' manual "Sync now" tap, or a test simulating it)
          // bypasses the retry backoff so an explicit user request always
          // attempts a failed entry immediately, matching the existing "Failed
          // entries are retried on the next save or via the manual Sync now
          // action" contract below. Every OTHER call to syncNow (auto-sync
          // effect, realtime nudge, a save) must leave force unset, or the
          // backoff it's gated by never actually throttles anything.
          if (!isSyncable(entry, { ignoreBackoff: force })) {
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

        const api = createSyncApi(session);
        const createdIdsSyncedThisRun = new Set<string>();
        const getLatestBookmark = (id: string) =>
          bookmarksRef.current?.find((bookmark) => bookmark.id === id);
        const applySyncEntryResult = async (
          entry: LocalPendingBookmark,
          result: Awaited<ReturnType<typeof syncQueueEntry>>,
        ): Promise<boolean> => {
          if (result.entry.sync_status === "failed") {
            syncFailed += 1;
          }
          if (
            crossedHealthEscalationThreshold(
              entry.retry_count,
              result.entry.retry_count,
            )
          ) {
            reportSyncQueueHealthEscalation({
              operation: entry.operation,
              retryCount: result.entry.retry_count,
              lastError: result.entry.last_error,
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
            if (
              result.entry.remote_id &&
              result.entry.remote_id !== entry.local_id
            ) {
              // The upload created a remote row for a bookmark the user already
              // deleted. Enqueue a durable delete (not a best-effort request) so
              // the removal survives app exit and request failures; the next
              // sync pass processes it.
              enqueueMutation(result.entry.remote_id, "delete");
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
              ? {
                  ...latest,
                  id: update.id,
                  sync_status: update.sync_status,
                  ever_synced: update.ever_synced,
                  updated_at: update.updated_at,
                }
              : null;
            if (merged) {
              // Collapse onto the destination id: a pull that already inserted
              // this bookmark under the existing row's id would otherwise
              // coexist with the just-swapped row as a same-id duplicate.
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
                const titleChangedByUser =
                  pendingUserTitleEdits.current.has(lookupId) ||
                  pendingUserTitleEdits.current.has(merged.id);
                const isDuplicateSwap =
                  Boolean(result.originalLocalId) &&
                  result.originalLocalId !== merged.id;
                if (
                  isDuplicateSwap ||
                  createNeedsReconcileUpdate(merged, payload, {
                    titleChangedByUser,
                  })
                ) {
                  const reasons: Record<string, number> = {};
                  if (isDuplicateSwap) reasons.duplicate_swap = 1;
                  if (merged.deleted_at !== null) reasons.deleted_at = 1;
                  if (merged.is_archived) reasons.is_archived = 1;
                  if (merged.collection_id !== null) reasons.collection_id = 1;
                  if (
                    merged.title !== (payload?.title ?? null) &&
                    titleChangedByUser
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
          return true;
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
          for (const { bookmark: update, originalLocalId } of completions) {
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
              const titleChangedByUser =
                pendingUserTitleEdits.current.has(lookupId) ||
                pendingUserTitleEdits.current.has(merged.id);
              const isDuplicateSwap =
                Boolean(originalLocalId) && originalLocalId !== merged.id;
              if (
                isDuplicateSwap ||
                createNeedsReconcileUpdate(merged, uploadedPayload, {
                  titleChangedByUser,
                })
              ) {
                followUpUpdates.push(merged);
                const reasons: Record<string, number> = {};
                if (isDuplicateSwap) reasons.duplicate_swap = 1;
                if (merged.deleted_at !== null) reasons.deleted_at = 1;
                if (merged.is_archived) reasons.is_archived = 1;
                if (merged.collection_id !== null) reasons.collection_id = 1;
                if (
                  merged.title !== (uploadedPayload.title ?? null) &&
                  titleChangedByUser
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
            hasBulkCreateResultKey(entry) &&
            isSyncable(entry, { ignoreBackoff: force }),
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
                  failedEntries.set(entry.local_id, {
                    ...entry,
                    sync_status: "failed",
                    retry_count: entry.retry_count + 1,
                    last_error: message,
                    // These entries were actually attempted (the failed bulk
                    // request), so the retry backoff clock starts now — see
                    // isSyncable/uploadRetryBackoffMs. The untried entries below
                    // deliberately do NOT get this: they never made a request,
                    // so they keep whatever backoff state (if any) they already
                    // had instead of newly earning one.
                    last_attempt_at: failedAt,
                    updated_at: failedAt,
                  });
                }
                for (const entry of untriedEntries) {
                  failedEntries.set(entry.local_id, {
                    ...entry,
                    sync_status: "failed",
                    last_error:
                      "Not attempted: an earlier chunk in this bulk sync failed.",
                    updated_at: failedAt,
                  });
                }
                syncFailed += failedEntries.size;

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
                    if (
                      crossedHealthEscalationThreshold(
                        entry.retry_count,
                        failedEntry.retry_count,
                      )
                    ) {
                      reportSyncQueueHealthEscalation({
                        operation: failedEntry.operation,
                        retryCount: failedEntry.retry_count,
                        lastError: failedEntry.last_error,
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
            );
            await applySyncEntryResult(entry, result);
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
              last_attempt_at: failedAt,
              updated_at: failedAt,
            };
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
        const importCollectionsSynced = await syncPendingImportCollections();
        if (importCollectionsSynced) {
          mutationsPushed = true;
        }

        // Same reasoning, same seam: a restored AI enrichment snapshot (#671)
        // needs its bookmark's remote id resolved first too.
        const enrichmentRestoresSynced = await syncPendingEnrichmentRestores();
        if (enrichmentRestoresSynced) {
          mutationsPushed = true;
        }

        // Upload any queued local-first tag ops before pulling, so the pull's
        // server snapshot already reflects them.
        const tagsSynced = await syncTagOps();
        if (tagsSynced) {
          mutationsPushed = true;
        }
        if (
          pendingTagOpsRef.current.some((op) =>
            createdIdsSyncedThisRun.has(op.bookmark_id),
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
        if (!syncPausedRef.current) {
          try {
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
            );
            if (result.upserts.length > 0 || result.deletions.length > 0) {
              const upsertIds = new Set(
                result.upserts.map((bookmark) => bookmark.id),
              );
              const removed = new Set(result.deletions);
              setBookmarks((current) => [
                ...(current ?? []).filter(
                  (bookmark) =>
                    !upsertIds.has(bookmark.id) && !removed.has(bookmark.id),
                ),
                ...result.upserts,
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
                  noteUnseenSuggestions(enrichment);
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
            const mergedTagData = applyPendingTagOps(
              result.tagData,
              pendingTagOpsRef.current,
              auth.userId ?? mockUserId,
            );
            tagDataRef.current = mergedTagData;
            setTagData(mergedTagData);
            setLastPulledAt(result.pulledAt);
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
            logStorageError("pull", error);
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
          void trackSyncStatus({
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
        logStorageError("sync run", error);
      } finally {
        syncInFlight.current = false;
        setIsSyncing(false);
        if (syncPendingRef.current) {
          syncPendingRef.current = false;
          setTimeout(() => {
            void syncNowRef.current?.().catch(() => {});
          }, 50);
        }
      }
      if (mutationsPushed) {
        broadcastSyncNudgeRef.current?.();
      }
      return mutationsPushed;
    },
    [
      auth,
      queue,
      enqueueMutation,
      requestAiEnrichment,
      syncTagOps,
      syncPendingImportCollections,
      syncPendingEnrichmentRestores,
      noteUnseenSuggestions,
      reconcileAccountTransition,
    ],
  );

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

  // Backoff-scheduled AI-suggestion retries: re-attempt any bookmark with an
  // armed retry marker (a prior auto OR manual requestAiEnrichment failure)
  // once enough wall-clock time has passed since its last attempt (see
  // AI_RETRY_BACKOFF_MS). Reads aiRetryState directly (the ref, not the
  // reactive mirror) so it always sees the latest bookkeeping. STASH #573:
  // no-ops entirely when the mode is 'off'.
  const checkAiRetries = useCallback(() => {
    if (!auth.session || aiSuggestionsModeRef.current === "off") {
      return;
    }
    if (
      queueRef.current.some(
        (entry) =>
          entry.sync_status === "pending" || entry.sync_status === "syncing",
      )
    ) {
      return;
    }
    const now = Date.now();
    for (const [id, state] of Object.entries(aiRetryState.current)) {
      if (aiEnriching.current.has(id)) {
        continue; // a retry (or a manual tap) is already in flight for this id
      }
      const waitMs = AI_RETRY_BACKOFF_MS[state.attemptCount];
      if (waitMs === undefined) {
        continue; // defensive: the cap already clears entries before this can happen
      }
      if (now - new Date(state.lastAttemptAt).getTime() < waitMs) {
        continue; // backoff not yet elapsed
      }
      // STASH #574 Phase 1: queue for staggered dispatch (see the deferred
      // auto AI enrichment effect above for why).
      aiDispatchQueueRef.current = enqueueAiEnrichmentDispatch(
        aiDispatchQueueRef.current,
        id,
      );
    }
  }, [auth.session, requestAiEnrichment]);

  // STASH #574 Phase 1: drains aiDispatchQueueRef at a steady stagger, calling
  // requestAiEnrichment for one queued id at a time instead of a whole burst
  // firing simultaneously. Both producers above (the deferred first-trigger
  // effect and checkAiRetries) only enqueue; this is the one place that
  // actually dispatches, so it's also the one place that knows when a burst
  // has fully drained — which is what decides whether the completion toast is
  // worth showing.
  useEffect(() => {
    if (!auth.session) {
      return;
    }
    const interval = setInterval(() => {
      // Display-only cleanup, independent of the mode/dispatch gating below:
      // once the server-accurate reset time has passed, stop telling Settings
      // and feedback diagnostics the quota is still exceeded. A future 429
      // (if the wait wasn't actually over, or a fresh burst re-exhausts it)
      // re-arms this the same way.
      setAiQuotaExceeded((current) =>
        current && Date.now() >= current.retryAt ? null : current,
      );
      if (aiSuggestionsModeRef.current === "off") {
        // Mode flipped off mid-burst: drop whatever's left rather than keep
        // firing requests for a feature the user just turned off.
        aiDispatchQueueRef.current = EMPTY_AI_ENRICHMENT_BURST_QUEUE;
        return;
      }
      if (aiDispatchInFlight.current) {
        return; // still waiting on the previous dispatch to settle
      }
      if (Date.now() < aiQuotaCooldownUntil.current) {
        // STASH-4K follow-up: the quota is known exhausted (armed by a
        // recent 429) — leave the queue as-is (unlike the mode==='off'
        // branch above, this isn't abandoned work) and simply wait out the
        // cooldown instead of dispatching into more guaranteed rejections.
        return;
      }
      if (
        queueRef.current.some(
          (entry) =>
            entry.sync_status === "pending" || entry.sync_status === "syncing",
        )
      ) {
        return; // let bookmark sync settle before starting AI work for freshly-created rows
      }
      if (bulkReconcileInFlight.current > 0) {
        // A bulk-create chunk's reconcile follow-up can leave the queue
        // with nothing pending/syncing for a window that outlasts this
        // interval's own tick (its writes now genuinely await SQLite calls
        // in sequence) — without this, that gap looks like "sync settled"
        // and this would start firing AI requests during the exact SQLite
        // stall the STASH-3Y fix is meant to relieve (caught in PR review).
        return;
      }
      const { queue, id } = dequeueAiEnrichmentDispatch(
        aiDispatchQueueRef.current,
      );
      aiDispatchQueueRef.current = queue;
      if (!id) {
        return;
      }
      aiDispatchInFlight.current = true;
      const dispatchEpochAtStart = aiDispatchEpoch.current;
      void requestAiEnrichment(id, "auto")
        .then((error) => {
          if (!error) {
            void clearPendingAiTrigger(id);
          }
        })
        .finally(() => {
          aiDispatchInFlight.current = false;
          if (aiDispatchEpoch.current !== dispatchEpochAtStart) {
            // An account boundary was crossed while this dispatch was in
            // flight — aiDispatchQueueRef now belongs to a different
            // session; discard rather than count this settle toward its
            // burst total (#691).
            return;
          }
          aiDispatchQueueRef.current = recordAiEnrichmentDispatchSettled(
            aiDispatchQueueRef.current,
          );
          if (isBurstComplete(aiDispatchQueueRef.current)) {
            const completed = aiDispatchQueueRef.current.completedInBurst;
            aiDispatchQueueRef.current = clearBurstCompletion(
              aiDispatchQueueRef.current,
            );
            if (completed >= AI_ENRICHMENT_BURST_TOAST_MIN) {
              aiBurstTokenSeq.current += 1;
              setAiEnrichmentBurstToast({
                count: completed,
                token: aiBurstTokenSeq.current,
              });
            }
          }
        });
    }, AI_ENRICHMENT_DISPATCH_STAGGER_MS);
    return () => clearInterval(interval);
  }, [auth.session, requestAiEnrichment, clearPendingAiTrigger]);

  // Cold-launch retry check: once storage has loaded and auth is ready, run
  // the backoff check once so a bookmark whose wait already elapsed while the
  // app was closed retries immediately rather than waiting for the next
  // foreground transition or periodic tick.
  const coldLaunchRetryChecked = useRef(false);
  useEffect(() => {
    if (bookmarks === null || !auth.session || coldLaunchRetryChecked.current) {
      return;
    }
    coldLaunchRetryChecked.current = true;
    checkAiRetries();
  }, [bookmarks, auth.session, checkAiRetries]);

  // Foreground-transition + periodic retry check: re-run the backoff check
  // whenever the app returns to the foreground, and (while foregrounded) every
  // AI_RETRY_CHECK_INTERVAL_MS so a bookmark isn't stuck waiting for the next
  // background/foreground cycle if the app is simply left open for hours.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(checkAiRetries, AI_RETRY_CHECK_INTERVAL_MS);
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        checkAiRetries();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [checkAiRetries]);

  // Reconcile aiServerQueued against the queue's real remote status (Codex
  // review, PR #656). Unlike checkAiRetries, this deliberately does NOT gate
  // on aiSuggestionsMode === "off": the overflow worker keeps processing
  // already-queued rows server-side regardless of the local dispatch/retry
  // pause, so this must keep running too — it's reading server truth, not
  // driving new dispatch. A row the worker gave up on (status: 'failed', past
  // MAX_ENRICHMENT_ATTEMPTS) or that no longer exists (a deleted bookmark
  // cascades its row away) never produces an ai_enrichments row, so without
  // this clearAiServerQueued's only trigger (a real enrichment landing via
  // sync) would never fire for it — the local marker, and the "still queued"
  // backlog count it drives, would say so forever for a bookmark that will in
  // fact never complete.
  const reconcileAiServerQueued = useCallback(() => {
    const session = auth.session;
    const ids = [...aiServerQueued.current];
    if (!session || ids.length === 0) {
      return;
    }
    const api = createSyncApi(session);
    // Bounded chunks (Codex review, PR #660): a bulk-import-sized backlog
    // (500+ confirmed-queued ids) in one `bookmark_id=in.(...)` query target
    // runs well into tens of KB, which common HTTP gateways reject as
    // URI-too-long — the failed request would then just retry itself
    // unchanged every tick, forever unable to reconcile anything.
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += AI_SERVER_QUEUED_STATUS_CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + AI_SERVER_QUEUED_STATUS_CHUNK_SIZE));
    }
    Promise.all(
      chunks.map((chunk) => api.fetchPendingEnrichmentStatuses(chunk)),
    )
      .then((results) => {
        const statusById = new Map(
          results.flat().map((row) => [row.bookmark_id, row.status]),
        );
        // Batch removal: mutate the ref directly and persist/sync the mirror
        // ONCE for the whole pass, instead of once per terminal id via
        // clearAiServerQueued. A device returning after many rows failed or
        // disappeared would otherwise fan that many separate native setMeta
        // writes onto the single-connection SQLite actor — the documented
        // tail-wait contention pattern (STASH-3B, -3N, -3Y; see
        // docs/architecture/sqlite-write-contention.md), which recurs
        // whenever a loop persists once per item instead of once per batch
        // (Codex review, PR #660).
        let removedAny = false;
        for (const id of ids) {
          const status = statusById.get(id);
          // 'done' is terminal too, alongside 'failed'/missing: a later 429
          // against a bookmark whose pending_ai_enrichment row the worker
          // already finished resolves via enqueuePendingEnrichment's
          // ignore-duplicates without reviving that row, so the worker will
          // never revisit it and — since the existing ai_enrichments row is
          // unchanged, not newer — no pull will ever clear this marker the
          // normal way either (Codex review, PR #660).
          if (
            status === undefined ||
            status === "failed" ||
            status === "done"
          ) {
            if (aiServerQueued.current.delete(id)) {
              removedAny = true;
            }
          }
        }
        if (removedAny) {
          persistAiServerQueued();
          syncAiServerQueuedIds();
        }
      })
      .catch((error: unknown) => {
        recordLog(
          "warn",
          `pending_ai_enrichment status reconcile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, [auth.session, persistAiServerQueued, syncAiServerQueuedIds]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(
        reconcileAiServerQueued,
        AI_RETRY_CHECK_INTERVAL_MS,
      );
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        reconcileAiServerQueued();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [reconcileAiServerQueued]);

  // Account-wide AI overflow snapshot (fixes the Settings AI counter reading
  // 0 while the server-side worker is actively
  // draining a real backlog it never learned about — e.g. a direct
  // `pending_ai_enrichment` backfill, another device's 429, or the
  // server-side dispatch trigger). Purely a diagnostic/display read: never
  // throws, never blocks anything, and on failure just leaves the last known
  // value in place rather than blanking an already-correct display.
  const fetchAiServerQueueSnapshot = useCallback(async () => {
    if (!auth.session) {
      return;
    }
    // Diagnostic/display-only, but reuses the same "ensure a fresh token
    // first" pattern as syncNow/requestAiEnrichment (rather than trusting the
    // possibly-stale reactive `auth.session` directly) — a soon-to-expire
    // token would otherwise just fail this GET for no reason. Wrapped in
    // try/catch so neither the ensure call nor the fetch itself can ever
    // throw out of this fire-and-forget helper.
    try {
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      if (!session) {
        return;
      }
      const snapshot = await createSyncApi(session).fetchAiQueueSnapshot();
      setAiServerQueueSnapshot(snapshot);
    } catch (error) {
      recordLog(
        "warn",
        `AI server queue snapshot fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [auth]);

  // Same foreground + periodic-tick shape as checkAiRetries/
  // reconcileAiServerQueued above — reuses AI_RETRY_CHECK_INTERVAL_MS rather
  // than a new interval constant, since this is the same class of "keep a
  // background diagnostic in sync every few minutes" work.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    const startInterval = () => {
      if (interval) {
        return;
      }
      interval = setInterval(
        fetchAiServerQueueSnapshot,
        AI_RETRY_CHECK_INTERVAL_MS,
      );
    };
    const unregister = registerForForegroundState({
      onForeground: () => {
        void fetchAiServerQueueSnapshot();
        startInterval();
      },
      onBackground: stopInterval,
    });
    startInterval(); // the app is foregrounded when this first mounts
    return () => {
      unregister();
      stopInterval();
    };
  }, [fetchAiServerQueueSnapshot]);

  // Background sync: upload as soon as auth and local data are ready, and
  // whenever a new pending entry appears. Failed entries are retried on the
  // next save (once its own backoff window elapses — see isSyncable in
  // sync/sync-bookmarks.ts) or immediately via the manual Sync now action
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
          void syncNowRef.current?.().catch(() => {});
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
    queue,
    pendingImportCollections,
    pendingEnrichmentRestores,
    isSyncingState,
    syncNow,
    hasSyncedOnce,
  ]);

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
  useEffect(() => {
    if (auth.status !== "signed_out") {
      lazyMintInFlight.current = false;
      return;
    }
    if (
      lazyMintInFlight.current ||
      bookmarks === null ||
      !queue.some(
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
  }, [auth, bookmarks, queue]);

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
      lastSyncedUserId.current !== auth.userId
    ) {
      // Only claim this user as synced once we can actually start — otherwise a
      // sign-in landing mid-flight (the startup anonymous sync still running)
      // would set the ref and then syncNow() would early-return on its in-flight
      // guard, and with the ref already matching, the effect would never retry.
      // Gating on isSyncing makes the effect re-run when the in-flight sync
      // settles, so the new user's pull still fires.
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
    bookmarks,
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
  const wasAnonymousRef = useRef<boolean | null>(null);
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
        await applyAccountTransition(
          plan,
          repository,
          setBookmarks,
          setQueue,
          makeBookmarkId,
          ensureRepositoryReady,
          {
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
        );
        // Reset the synced-user meta + watermark so the next session does a full
        // refresh (planAccountTransition + pullRemoteChanges read these). Empty
        // strings read back as falsy/null in both call sites.
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

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      loadError,
      inbox: loadedBookmarks
        .filter((bookmark) => isActiveBookmark(bookmark))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      trash: loadedBookmarks
        .filter((bookmark) => bookmark.deleted_at != null)
        .sort((a, b) => (b.deleted_at ?? "").localeCompare(a.deleted_at ?? "")),
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      resetLibrary,
      isResettingLibrary,
      processingStats,
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
      addTagsToBookmark,
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
    }),
    [
      bookmarks,
      loadError,
      loadedBookmarks,
      queue,
      getBookmark,
      getTagsForBookmark,
      getCollection,
      getEnrichment,
      addBookmark,
      importBookmarks,
      trashBookmark,
      restoreBookmark,
      emptyTrash,
      resetLibrary,
      isResettingLibrary,
      processingStats,
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
      addTagsToBookmark,
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
    ],
  );

  return (
    <BookmarksContext.Provider value={value}>
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
