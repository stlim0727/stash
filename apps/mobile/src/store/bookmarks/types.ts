import {
  type AiSuggestionsMode
} from "@/domain/ai-suggestions-pref";
import { type BookmarkProcessingSnapshot } from "@/domain/bookmark-processing";
import {
  type SharedImage
} from "@/domain/image-share";
import { type ImportItem } from "@/domain/import";
import { type LibrarySyncFlow } from "@/domain/library-sync-status";
import {
  type ProcessingStats
} from "@/domain/processing-status";
import type {
  AIEnrichment,
  Bookmark,
  Collection,
  LocalPendingBookmark,
  SuggestedTag,
  Tag,
  TextFormat
} from "@/domain/types";

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

export interface BookmarksContextValue {
  /** True until the durable store has been read on startup. */
  isLoading: boolean;
  /** Set when the durable store failed to load and in-memory fallback is used. */
  loadError: boolean;
  /** Account library verification is distinct from an empty library. */
  accountLibraryState: "ready" | "checking" | "error";
  accountTransferCount: number;
  dismissAccountTransfer: () => void;
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
  getBookmarkProcessing: (bookmarkId: string) => BookmarkProcessingSnapshot | undefined;
  /** Local-first creation: the bookmark is visible immediately with pending states. */
  addBookmark: (input: {
    url?: string;
    title?: string;
    /** True when the title came from a source app rather than the user. */
    title_is_derived?: boolean;
    notes?: string;
    /** Explicit manual save may replace notes on an existing URL. */
    replace_existing_notes?: boolean;
    /** Stable native share attempt UUID used to dedupe replayed text/images. */
    capture_client_id?: string;
    description_format?: TextFormat;
    notes_format?: TextFormat;
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
  /** Edit user-authored text. Local-first; empty strings clear the field. */
  updateBookmarkFields: (
    id: string,
    fields: { title?: string; notes?: string; description?: string; description_format?: TextFormat; notes_format?: TextFormat },
    source?: "user_edit" | "ai_apply",
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
  /** All tags known to the user (refreshed by pull sync and local edits). */
  tags: Tag[];
  /** Add tags locally, including before the bookmark has synced. Resolves to an error message, or null. */
  addTagsToBookmark: (
    bookmarkId: string,
    names: string[],
  ) => Promise<string | null>;
  /** Add tags locally across multiple bookmarks. Resolves to an error message, or null. */
  addTagsToBookmarks: (
    bookmarkIds: string[],
    names: string[],
  ) => Promise<string | null>;
  /** Remove a tag locally, retaining a durable removal intent. Resolves to an error message, or null. */
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
  assignCollection: (bookmarkId: string, collectionId: string | null, source?: "user_edit" | "ai_apply") => void;
  /** Create a cloud collection. Resolves to the collection or an error message. */
  createCollection: (
    name: string,
  ) => Promise<{ collection?: Collection; error?: string }>;
  /** Rename an existing collection. */
  renameCollection: (
    collectionId: string,
    name: string,
  ) => Promise<{ collection?: Collection; error?: string }>;
  /** Delete a collection, either moving its bookmarks to trash or leaving them uncategorized. */
  deleteCollection: (
    collectionId: string,
    action: "uncategorize" | "trash",
  ) => Promise<{ error?: string }>;
  /** Bulk delete collections, either moving bookmarks to trash or leaving them uncategorized. */
  deleteCollections: (
    collectionIds: string[],
    action: "uncategorize" | "trash",
  ) => Promise<{ error?: string }>;
  /** Merge source collections into a target collection, reassigning bookmarks. */
  mergeCollections: (
    sourceCollectionIds: string[],
    targetCollectionId: string,
  ) => Promise<{ error?: string }>;
  /** Mutually-exclusive user-facing stages plus overlapping raw diagnostic
   *  counters (developer mode) for the Settings background-processing card. */
  processingStats: ProcessingStats;
  librarySyncFlow: LibrarySyncFlow;
  /** The most recent AI-enrichment 429's reason and accurate reset time, for
   *  the Settings backlog row and feedback diagnostics. `null` once the
   *  window has passed (or on account switch) — see `aiQuotaExceeded`. */
  aiQuotaExceeded: { reason: string; retryAt: number } | null;
}

export interface AiRetryState {
  /** When the first attempt (of the current, unexhausted streak) failed. */
  firstAttemptAt: string;
  /** When the most recent attempt failed — the backoff clock runs from here. */
  lastAttemptAt: string;
  /** Failed attempts since the streak began; 0 means waiting for sync. */
  attemptCount: number;
}
