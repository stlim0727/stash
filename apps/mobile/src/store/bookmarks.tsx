import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { resolveAliasedId } from '@/domain/bookmark-id-swap';
import { mockUserId } from '@/domain/mock-data';
import { canonicalizeUrl, isUrlTooLong, normalizeUrl } from '@/domain/urls';
import { createConcurrencyLimiter } from '@/domain/concurrency';
import { enrichBookmark } from '@/domain/enrichment';
import { isTransientNetworkError } from '@/domain/network-errors';
import { planTitleBackfill } from '@/domain/title-backfill';
import type { TitleBackfillPatch } from '@/domain/title-backfill';
import {
  imageTitleFromFileName,
  localImageFileName,
  type SharedImage,
} from '@/domain/image-share';
import type { ImportItem } from '@/domain/import';
import type {
  AIEnrichment,
  Bookmark,
  BookmarkTag,
  Collection,
  LocalPendingBookmark,
  SuggestedTag,
  Tag,
} from '@/domain/types';
import { sanitizeTagData } from '@/domain/tag-data';
import { normalizeTag } from '@/domain/tag-input';
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
} from '@/domain/ai-suggestions';
import { acceptSuggestionBundle } from '@/domain/suggestion-actions';
import {
  AI_SUGGESTIONS_MODE_PREF_KEY,
  DEFAULT_AI_SUGGESTIONS_MODE,
  parseAiSuggestionsMode,
  serializeAiSuggestionsMode,
  type AiSuggestionsMode,
} from '@/domain/ai-suggestions-pref';
import {
  AI_ENRICHMENT_BURST_TOAST_MIN,
  AI_ENRICHMENT_DISPATCH_STAGGER_MS,
  EMPTY_AI_ENRICHMENT_BURST_QUEUE,
  clearBurstCompletion,
  dequeueAiEnrichmentDispatch,
  enqueueAiEnrichmentDispatch,
  isBurstComplete,
  recordAiEnrichmentDispatchSettled,
  type AiEnrichmentBurstQueue,
} from '@/domain/ai-enrichment-burst';
import { parseStringSetMap } from '@/domain/string-set-map';
import type { StringSetMap } from '@/domain/string-set-map';
import {
  applyPendingTagOps,
  applyTagOp,
  dequeueTagOp,
  dropPendingTagOpsForBookmarks,
  enqueueTagOp,
  reconcileSyncedAdd,
  rekeyPendingTagOps,
  type PendingTagOp,
} from '@/domain/pending-tags';
import { useI18n } from '@/i18n';
import { recordLog } from '@/observability/log-buffer';
import { armHydrationWatchdog } from '@/observability/hydration-watchdog';
import { armLoopStallWatchdog } from '@/observability/loop-stall-watchdog';
import { reportSyncQueueHealthEscalation } from '@/observability/sentry';
import { registerForForegroundState } from '@/storage/sqlite-app-lifecycle';
import { repository } from '@/storage/repository';
import { copyImageToLibrary } from '@/storage/image-store';
import type { EnrichmentMetadataHint } from '@/api/bookmarks';
import type { CreateSyncCompletion, TagData } from '@/storage/types';
import { useSupabaseAuth } from '@/supabase/auth-provider';
import { useRealtimeSync } from '@/supabase/realtime';
import { SupabaseRequestError } from '@/supabase/client';
import {
  applyAccountTransition,
  planAccountTransition,
  planLogoutCacheClear,
} from '@/sync/account-transition';
import {
  LAST_PULLED_AT_KEY,
  SYNCED_USER_ANON_KEY,
  SYNCED_USER_ID_KEY,
  pullRemoteChanges,
} from '@/sync/pull-bookmarks';
import {
  BULK_CREATE_SYNC_CHUNK_SIZE,
  createNeedsReconcileUpdate,
  createSyncApi,
  crossedHealthEscalationThreshold,
  hasBulkCreateResultKey,
  hasRemoteIdentity,
  isSyncable,
  makeMutationEntry,
  reconcileOrphanedQueueEntries,
  removeQueueEntryIfNotSuperseded,
  syncCreateQueueEntryBatch,
  syncQueueEntry,
} from '@/sync/sync-bookmarks';

export type AddBookmarkResult =
  | {
      status: 'created' | 'duplicate';
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
      status: 'invalid';
      error: string;
      /** Coarse, i18n-free reason code for the UI layer to pick a localized
       *  message when the raw `error` string (English-only, matching this
       *  store's existing i18n-free convention) isn't specific enough — e.g.
       *  a toast-only caller that doesn't display `error` directly. */
      reason?: 'too_long';
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
  | { ok: false; reason: 'busy' | 'auth' | 'remote' | 'local'; message?: string };

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
   * (and within the batch). Returns a count summary. Note: tags/collections from
   * the source are not restored yet — see the import UI copy.
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
  updateBookmarkFields: (id: string, fields: { title?: string; notes?: string }) => void;
  /**
   * Record that the user opened a bookmark (viewed Detail or opened its link),
   * setting its local-only `last_accessed_at`. Powers the "Recently opened"
   * sort. Never synced and never bumps `updated_at`.
   */
  markBookmarkAccessed: (id: string) => void;
  /** Permanently remove a bookmark and any pending queue entry for it. */
  deleteBookmark: (id: string) => void;
  /** True while the background sync service is uploading queue entries. */
  isSyncing: boolean;
  /** Upload pending/failed queue entries to Supabase. No-op without auth. */
  syncNow: () => Promise<boolean>;
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
  addTagsToBookmark: (bookmarkId: string, names: string[]) => Promise<string | null>;
  /** Remove a tag from a synced bookmark. Resolves to an error message, or null. */
  removeTagFromBookmark: (bookmarkId: string, tagName: string) => Promise<string | null>;
  /** Generate AI suggestions for a synced bookmark. Resolves to an error, or
   *  null. `source` defaults to 'manual' (an explicit user tap); the deferred
   *  post-capture auto-trigger passes 'auto' so the UI can stay silent for work
   *  the user never asked to wait on. */
  requestAiEnrichment: (
    bookmarkId: string,
    source?: 'auto' | 'manual',
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
  acceptSuggestedTags: (bookmarkId: string, suggestions: SuggestedTag[]) => Promise<string | null>;
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
  dismissFolderSuggestion: (bookmarkId: string, tokens: string | string[]) => void;
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
  createCollection: (name: string) => Promise<{ collection?: Collection; error?: string }>;
}

const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };
// Shared empty result so getTagsForBookmark returns a stable reference for
// bookmarks with no tags (avoids reallocating + breaking memo equality).
const EMPTY_TAGS: Tag[] = [];

/** Durable key for the local-first tag operation queue (JSON in meta). */
const PENDING_TAG_OPS_KEY = 'pending_tag_ops';

/** Durable key (JSON id array in meta) for bookmarks awaiting their first auto
 *  AI enrichment. Persisted so a kill during the metadata-fetch window doesn't
 *  drop the auto-trigger — the marker is re-hydrated and fired on next launch. */
const PENDING_AI_TRIGGER_KEY = 'pending_ai_trigger';

/** Durable key (JSON `{ [bookmarkId]: AiRetryState }` in meta) for bookmarks
 *  with a failed AI-enrichment attempt (auto OR manual) that wrote no
 *  `ai_enrichments` row, awaiting a backoff-scheduled retry. Populated by any
 *  `requestAiEnrichment` failure and cleared once a later attempt succeeds or
 *  the attempt cap (`AI_RETRY_MAX_ATTEMPTS`) is exhausted. Purely local
 *  bookkeeping, parallel to `PENDING_AI_TRIGGER_KEY`: it never touches the
 *  bookmark row, `updated_at`, or the sync queue. */
const AI_RETRY_STATE_KEY = 'ai_suggestion_retry';

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
const AI_SERVER_QUEUED_KEY = 'ai_server_queued';

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

/** Parse the persisted AI-retry bookkeeping map, tolerating absent/corrupt
 *  values (mirrors `parseIdSet`/`parseTagOps` for the store's other durable
 *  meta blobs). */
function parseAiRetryState(raw: string | null): Record<string, AiRetryState> {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, AiRetryState> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as AiRetryState).firstAttemptAt === 'string' &&
        typeof (value as AiRetryState).lastAttemptAt === 'string' &&
        typeof (value as AiRetryState).attemptCount === 'number'
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
const REVIEWED_SUGGESTIONS_KEY = 'reviewed_ai_suggestions';

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the folder
 *  (collection) suggestions the user has dismissed on a bookmark's Detail, keyed
 *  by a stable token (see `suggestedFolderToken`). Persisted so a dismissed
 *  folder chip stays gone when the user re-enters Detail or relaunches — a later
 *  enrichment proposing a *different* folder yields a different token and still
 *  re-surfaces. */
const DISMISSED_FOLDERS_KEY = 'dismissed_folder_suggestions';

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the AI summaries
 *  the user has reviewed (used as a note or dismissed) on a bookmark's Detail,
 *  keyed by a stable token (see `summaryToken`). Persisted so a summary the user
 *  acted on stays gone when they re-enter Detail or relaunch — a later
 *  enrichment producing a *different* summary yields a different token and still
 *  re-surfaces. */
const REVIEWED_SUMMARIES_KEY = 'reviewed_ai_summaries';

/** Durable key (JSON id array in meta) for bookmarks whose AI suggestions
 *  arrived while the user wasn't looking — a background auto-enrichment, a
 *  server-side trigger result, or another device's enrichment pulled in. Drives
 *  the Inbox "new AI suggestions" banner so freshly-suggested items aren't
 *  stranded behind a per-card badge the user has to scroll to find; an id is
 *  cleared once the user witnesses it (opens its Detail, or visits Review).
 *  Persisted so a suggestion that landed in a session the user never returned to
 *  still announces itself on the next launch. */
const UNSEEN_SUGGESTIONS_KEY = 'unseen_ai_suggestions';

/** Manual "pause sync" safety valve (Sentry STASH-3K follow-up): while on,
 *  syncNow no-ops entirely (no upload, no pull) so a bulk import can be
 *  reviewed — and unwanted rows deleted — before anything reaches the
 *  network. Persisted so it survives leaving the app mid-review. */
const SYNC_PAUSED_KEY = 'pref.sync.paused';

/** Opaque sentinel `requestAiEnrichment` returns when the AI endpoint rate-limits
 *  (HTTP 429). The store is i18n-free, so it can't localize the message itself;
 *  the Detail screen maps this to a translated string. Any non-UI caller (the
 *  deferred auto-trigger) only checks for a non-null error, so the value is
 *  inert there. */
export const AI_RATE_LIMITED = 'ai-rate-limited';

function parseIdSet(raw: string | null): Set<string> {
  if (!raw) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === 'string'))
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
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
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
function currentDedupeKey(bookmark: Pick<Bookmark, 'url' | 'url_hash'>): string | null {
  return bookmark.url ? canonicalizeUrl(bookmark.url) : bookmark.url_hash;
}

/**
 * "Active" the same way the inbox filter defines it: not trashed and not
 * archived. Save-time dedupe must only match active rows — otherwise re-saving a
 * URL that is sitting in Trash folds into the trashed row and leaves it hidden,
 * so it never comes back. Mirrors the server-side active-URL predicate.
 */
function isActiveBookmark(bookmark: Pick<Bookmark, 'deleted_at' | 'is_archived'>): boolean {
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
            typeof op.bookmark_id === 'string' &&
            typeof op.tag_name === 'string' &&
            (op.op === 'add' || op.op === 'remove'),
        )
      : [];
  } catch {
    return [];
  }
}

function logStorageError(operation: string, error: unknown) {
  console.warn(`[stash] failed to persist ${operation}; state remains in memory`, error);
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
function mergeById<T>(current: T[], loaded: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  return [...current, ...loaded.filter((item) => !seen.has(key(item)))];
}

export function BookmarksProvider({ children }: { children: ReactNode }) {
  const auth = useSupabaseAuth();
  const broadcastSyncNudgeRef = useRef<(() => void) | null>(null);
  const syncPendingRef = useRef(false);
  const syncNowRef = useRef<(() => Promise<boolean>) | null>(null);
  const localCreateFlushesInFlight = useRef(0);
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
  // Bookmark ids whose AI suggestions arrived unwitnessed (drives the Inbox
  // banner). The ref mirrors state so the arrival paths (auto enrichment, pull)
  // can read-modify-write synchronously across back-to-back updates.
  const [unseenSuggestionIds, setUnseenSuggestionIds] = useState<ReadonlySet<string>>(new Set());
  const unseenSuggestionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
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
  const enrichmentSlots = useRef(createConcurrencyLimiter(ENRICHMENT_FETCH_CONCURRENCY));
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
  const [aiServerQueuedIds, setAiServerQueuedIds] = useState<ReadonlySet<string>>(new Set());
  // Reactive mirror of `aiEnriching` so the UI can show an ambient "filling in"
  // placeholder while a request (auto-triggered or manual) is in flight.
  const [enrichingIds, setEnrichingIds] = useState<ReadonlySet<string>>(new Set());
  // Subset of `enrichingIds` started by an explicit user action, so the UI can
  // give direct button feedback for a manual tap while keeping the auto-trigger
  // silent (it should just fill suggestions in, not look like a blocking wait).
  const [manualEnrichingIds, setManualEnrichingIds] = useState<ReadonlySet<string>>(new Set());
  const [previewRefreshingIds, setPreviewRefreshingIds] = useState<ReadonlySet<string>>(new Set());
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
        source?: 'auto' | 'manual',
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
  const aiSuggestionsModeRef = useRef<AiSuggestionsMode>(DEFAULT_AI_SUGGESTIONS_MODE);
  const [aiSuggestionsMode, setAiSuggestionsModeState] = useState<AiSuggestionsMode>(
    DEFAULT_AI_SUGGESTIONS_MODE,
  );
  // Staggered dispatch queue for automatic AI-enrichment triggers (STASH #574
  // Phase 1) — see `domain/ai-enrichment-burst.ts`. Only the two background
  // "trigger for a batch of ids" call sites route through this; the single-
  // bookmark preview-refresh follow-up trigger fires immediately as before,
  // since it's a direct continuation of a user-initiated action, not a burst.
  const aiDispatchQueueRef = useRef<AiEnrichmentBurstQueue>(EMPTY_AI_ENRICHMENT_BURST_QUEUE);
  const aiDispatchInFlight = useRef(false);
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
      .then(() => repository.setMeta(SYNC_PAUSED_KEY, paused ? 'true' : 'false'))
      .catch((error) => logStorageError('sync paused pref', error));
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
      .then(() => repository.setMeta(AI_SUGGESTIONS_MODE_PREF_KEY, serializeAiSuggestionsMode(mode)))
      .catch((error) => logStorageError('ai suggestions mode', error));
  }, []);

  // STASH #574 Phase 1: dismiss the "N bookmarks summarized & tagged" toast
  // signal once it's been shown.
  const dismissAiEnrichmentBurstToast = useCallback(() => {
    setAiEnrichmentBurstToast(null);
  }, []);

  // Apply + persist a new tag-data snapshot in one step. The ref is updated
  // synchronously so a follow-up tag op in the same tick reads the latest.
  const applyTagData = useCallback((next: TagData) => {
    tagDataRef.current = next;
    setTagData(next);
    ensureRepositoryReady()
      .then(() => repository.replaceTagData(next))
      .catch((error) => logStorageError('tag data', error));
  }, []);

  // Persist the local-first tag-op queue (ref updated synchronously).
  const applyTagOps = useCallback((next: PendingTagOp[]) => {
    pendingTagOpsRef.current = next;
    setPendingTagOps(next);
    ensureRepositoryReady()
      .then(() => repository.setMeta(PENDING_TAG_OPS_KEY, JSON.stringify(next)))
      .catch((error) => logStorageError('tag ops', error));
  }, []);

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
    return hasRemoteIdentity(bookmark.id) && (bookmark.sync_status === 'synced' || bookmark.ever_synced === true);
  }, []);

  // Queue a remote mutation for a bookmark that already exists on the server.
  // One entry per bookmark: a newer mutation supersedes an older one.
  const enqueueMutation = useCallback((bookmarkId: string, operation: 'update' | 'delete') => {
    const entry = makeMutationEntry(bookmarkId, operation);
    setQueue((current) => [...current.filter((queued) => queued.local_id !== bookmarkId), entry]);
    ensureRepositoryReady()
      .then(() => repository.enqueue(entry))
      .catch((error) => logStorageError(`${operation} mutation enqueue`, error));
  }, []);

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
            sync_status: syncsRemotely ? 'pending' : bookmark.sync_status,
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
          sync_status: syncsRemotely ? 'pending' : existing.sync_status,
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
        bookmarksRef.current = bookmarksRef.current!.map((b) => (b.id === id ? next : b));
        ensureRepositoryReady()
          .then(() => repository.updateBookmark(next))
          .catch((error) => logStorageError('bookmark update', error));
        if (syncsRemotely) {
          enqueueMutation(id, 'update');
        }
      }
    },
    [enqueueMutation, hasSyncedOnce],
  );

  // Suggestion review/dismissal helpers
  const getReviewedSuggestions = useCallback(
    (bookmarkId: string) => {
      const bookmark = bookmarks?.find((b) => b.id === bookmarkId);
      return new Set((bookmark?.dismissed_suggested_tags ?? []).map((name) => name.toLowerCase()));
    },
    [bookmarks],
  );

  const markSuggestionsReviewed = useCallback(
    (bookmarkId: string, names: string[]) => {
      const bookmark = bookmarksRef.current?.find((b) => b.id === bookmarkId);
      const trimmedNames = names.map((n) => n.trim().toLowerCase());
      const updatedTags = [...new Set([...(bookmark?.dismissed_suggested_tags ?? []), ...trimmedNames])];
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_tags: updatedTags });
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
      const updatedFolders = [...new Set([...(bookmark?.dismissed_suggested_folders ?? []), ...tokenList])];
      applyBookmarkUpdate(bookmarkId, { dismissed_suggested_folders: updatedFolders });
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
      const updatedSummaries = [...new Set([...(bookmark?.reviewed_summary_tokens ?? []), token])];
      applyBookmarkUpdate(bookmarkId, { reviewed_summary_tokens: updatedSummaries });
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
      .then(() => repository.setMeta(UNSEEN_SUGGESTIONS_KEY, JSON.stringify([...next])))
      .catch((error) => logStorageError('unseen suggestions', error));
  }, []);

  // The bookmark's currently-applied tag names, lowercased — read off the ref so
  // it's usable from the synchronous arrival paths (mirrors getTagsForBookmark's
  // cloud-link lookup, without the seeded-sample fallback those rows don't need).
  const appliedTagNamesRef = useCallback((bookmarkId: string): Set<string> => {
    const data = tagDataRef.current;
    const linkedIds = new Set(
      data.bookmarkTags.filter((link) => link.bookmark_id === bookmarkId).map((l) => l.tag_id),
    );
    return new Set(
      data.tags.filter((tag) => linkedIds.has(tag.id)).map((tag) => tag.name.toLowerCase()),
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
      const reviewed = new Set((bookmark?.dismissed_suggested_tags ?? []).map((name) => name.toLowerCase()));
      const dismissedFolderTokens = new Set(bookmark?.dismissed_suggested_folders ?? []);
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
          bookmark?.metadata_status ?? 'complete',
          enrichment,
          new Set(bookmark?.reviewed_summary_tokens ?? []),
          bookmark?.title,
        ) !== null;
      if (pendingSuggestions(enrichment, applied, reviewed).length === 0 && !hasFolder && !hasSummary) {
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
      .then(() => repository.setMeta(PENDING_AI_TRIGGER_KEY, JSON.stringify(ids)))
      .catch((error) => logStorageError('ai trigger queue', error));
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
      repository.setMeta(AI_RETRY_STATE_KEY, JSON.stringify(aiRetryState.current)),
    );
  }, []);

  // Persist the AI-retry bookkeeping map after a ref mutation (mirrors
  // persistPendingAiTrigger). Does NOT touch React state — callers update the
  // reactive `aiRetryIds` mirror themselves via `syncAiRetryIds`, at the point
  // that's safe for their caller (see requestAiEnrichment's `finally`).
  // Returns the write's promise for the same reason persistPendingAiTrigger
  // does.
  const persistAiRetryState = useCallback((): Promise<void> => {
    return writeAiRetryState().catch((error) => logStorageError('ai retry state', error));
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
      const forBookmark = bookmarksRef.current?.find((item) => item.id === bookmarkId);
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
          logStorageError('ai retry state', error);
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
      .catch((error) => logStorageError('ai server-queued', error));
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
  const enrichInBackground = useCallback((bookmark: Bookmark) => {
    if (bookmark.metadata_status !== 'pending' || enriching.current.has(bookmark.id)) {
      return;
    }
    enriching.current.add(bookmark.id);
    // `enriching` (the dedupe guard) is set synchronously above; the fetch
    // itself waits for a limiter slot so bulk passes stay bounded.
    void enrichmentSlots.current(async () => {
      try {
        const { patch, metadata_status } = await enrichBookmark(bookmark);
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
            'info',
            `enrich: bookmark re-keyed ${bookmark.id} -> ${currentId} mid-fetch; applying metadata to current id`,
          );
        }
        if (deletedIds.current.has(bookmark.id) || deletedIds.current.has(currentId)) {
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
                sync_status: hasSyncedOnce(currentId) ? 'synced' : source.sync_status,
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
        if (patch.preview_image_url !== undefined && latest.preview_image_url === null) {
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
            : current.map((item) => (item.id === updated.id ? updated : item)),
        );
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
        } catch (error) {
          logStorageError('metadata enrichment', error);
        }
        // Push the freshly fetched metadata to the cloud so other devices see
        // it on their next pull. Only for already-synced bookmarks: a local
        // bookmark's create upload already sends its latest fields.
        if (hasSyncedOnce(updated.id)) {
          enqueueMutation(updated.id, 'update');
        }
      } finally {
        enriching.current.delete(bookmark.id);
      }
    });
  }, [enqueueMutation, hasSyncedOnce]);

  useEffect(() => {
    let cancelled = false;
    // Observe (never abort) the cold-start load: if it wedges — the Android
    // background-handle SQLite stall, or any await that never resolves — the
    // Inbox stays stuck on its loading state with no crash and no event
    // (Sentry STASH-F). The watchdog makes that stall self-report; `phase`
    // gives the report a coarse, non-identifying hint of how far we got.
    let phase = 'opening';
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
            const storedAiSuggestionsMode = parseAiSuggestionsMode(storedAiSuggestionsModeRaw);
            aiSuggestionsModeRef.current = storedAiSuggestionsMode;
            setAiSuggestionsModeState(storedAiSuggestionsMode);
            // Re-hydrate the sync-paused pref so a review left mid-way (app
            // closed before turning it back off) doesn't silently resume
            // uploading on the next launch.
            const storedSyncPaused = storedSyncPausedRaw === 'true';
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
            const legacyDismissedFolders = parseStringSetMap(storedDismissedFoldersRaw);
            const legacyReviewedSummaries = parseStringSetMap(storedReviewedSummariesRaw);

            let migratedBookmarks = storedBookmarks;

            if (Object.keys(legacyReviewedTags).length > 0 ||
                Object.keys(legacyDismissedFolders).length > 0 ||
                Object.keys(legacyReviewedSummaries).length > 0) {

              migratedBookmarks = storedBookmarks.map((bookmark) => {
                const tags = legacyReviewedTags[bookmark.id] ?? [];
                const folders = legacyDismissedFolders[bookmark.id] ?? [];
                const summaries = legacyReviewedSummaries[bookmark.id] ?? [];

                if (tags.length > 0 || folders.length > 0 || summaries.length > 0) {
                  const updated: Bookmark = {
                    ...bookmark,
                    dismissed_suggested_tags: [
                      ...new Set([...(bookmark.dismissed_suggested_tags ?? []), ...tags])
                    ],
                    dismissed_suggested_folders: [
                      ...new Set([...(bookmark.dismissed_suggested_folders ?? []), ...folders])
                    ],
                    reviewed_summary_tokens: [
                      ...new Set([...(bookmark.reviewed_summary_tokens ?? []), ...summaries])
                    ],
                    // Queue for sync to remote DB
                    sync_status: 'pending',
                    ever_synced: true,
                    updated_at: new Date().toISOString(),
                  };
                  ensureRepositoryReady()
                    .then(() => repository.updateBookmark(updated))
                    .catch((error) => logStorageError('migrate legacy suggestion metadata', error));
                  enqueueMutation(updated.id, 'update');
                  return updated;
                }
                return bookmark;
              });

              // Clear legacy meta values
              ensureRepositoryReady().then(async () => {
                await repository.setMeta(REVIEWED_SUGGESTIONS_KEY, '{}');
                await repository.setMeta(DISMISSED_FOLDERS_KEY, '{}');
                await repository.setMeta(REVIEWED_SUMMARIES_KEY, '{}');
              }).catch((e) => logStorageError('clear legacy suggestion keys', e));
            }
            // Merge instead of replace: saves made while loading must survive.
            setBookmarks((current) =>
              current === null
                ? migratedBookmarks
                : mergeById(current, migratedBookmarks, (bookmark) => bookmark.id),
            );
            setQueue((current) => mergeById(current, storedQueue, (entry) => entry.local_id));
            // Self-heal stranded bookmarks: a non-synced row whose queue entry
            // never persisted (storage hiccup, or the app killed between the two
            // writes) has nothing to drive its sync and would show "sync
            // pending" forever. Re-enqueue an upload so the background loop
            // finishes it. Idempotent on the server, so it's safe to repeat.
            const orphanEntries = reconcileOrphanedQueueEntries(migratedBookmarks, storedQueue);
            if (orphanEntries.length > 0) {
              const orphanIds = new Set(orphanEntries.map((entry) => entry.local_id));
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
              })().catch((error) => logStorageError('orphan re-enqueue', error));
            }
            setEnrichments(storedEnrichments);
            // One-time cleanup: purge blank-named tags/collections (and orphaned
            // links) a prior version may have stored, so they stop showing as
            // empty Browse chips. Persist the cleaned set back when it changed.
            const { tagData: cleanTagData, changed } = sanitizeTagData(storedTagData);
            if (changed) {
              void repository
                .replaceTagData(cleanTagData)
                .catch((error) => logStorageError('blank-tag cleanup', error));
            }
            // Layer not-yet-synced local tag ops on top of the cached snapshot.
            const storedOps = parseTagOps(storedTagOpsRaw);
            pendingTagOpsRef.current = storedOps;
            setPendingTagOps(storedOps);
            tagDataRef.current = applyPendingTagOps(cleanTagData, storedOps, mockUserId);
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
          logStorageError('startup load', error);
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

  // Continuously watch the JS event loop for multi-second stalls — the "button
  // press does nothing for several seconds after sharing" freeze (Sentry
  // STASH-H) the native ANR/app-hang detectors miss because they watch the main
  // thread, not the JS thread. Reporting-only: it self-reports a coarse,
  // non-identifying snapshot (sync/queue counts — never bookmark content) so an
  // otherwise invisible freeze reaches monitoring. Paused while backgrounded so
  // a frozen-then-resumed app is not misread as a stall.
  useEffect(() => {
    const watchdog = armLoopStallWatchdog({
      describe: () => `syncing=${syncInFlight.current} queue=${queueRef.current.length}`,
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
      if (!current || enrichment.created_at.localeCompare(current.created_at) > 0) {
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
          title: title?.trim() ? title.trim() : imageTitleFromFileName(image.fileName),
          title_is_derived: title?.trim() ? false : undefined,
          description: null,
          notes: notes?.trim() ? notes.trim() : null,
          source_app: null,
          content_type: 'image',
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
          metadata_status: 'skipped',
          sync_status: 'synced',
          // Temporary share URI for the optimistic render; swapped for the
          // durable copy once `copyImageToLibrary` resolves below.
          local_image_uri: image.uri,
        };

        setBookmarks((current) => [imageBookmark, ...(current ?? [])]);
        const persisted = ensureRepositoryReady()
          .then(() => copyImageToLibrary(image.uri, fileName))
          .then((durableUri) => {
            const stored: Bookmark = { ...imageBookmark, local_image_uri: durableUri };
            setBookmarks((current) =>
              current === null ? current : current.map((b) => (b.id === id ? stored : b)),
            );
            return repository.insertBookmark(stored);
          })
          .then(() => true)
          .catch((error) => {
            logStorageError('new image bookmark', error);
            return false;
          });

        return { status: 'created', bookmark: imageBookmark, persisted };
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
            status: 'invalid',
            error: 'Enter a valid web address, like example.com or https://example.com.',
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
          content_type: 'text',
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: noteNow,
          updated_at: noteNow,
          last_saved_at: noteNow,
          metadata_status: 'pending',
          sync_status: 'pending',
        };

        const noteEntry: LocalPendingBookmark = {
          local_id: note.id,
          remote_id: null,
          operation: 'create',
          payload: {
            id: note.id,
            title: note.title ?? undefined,
            notes: note.notes ?? undefined,
            shared_text: text,
            client_id: noteClientId,
          },
          sync_status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: noteNow,
          updated_at: noteNow,
        };

        setBookmarks((current) => [note, ...(current ?? [])]);
        setQueue((current) => [...current, noteEntry]);
        const persisted = ensureRepositoryReady()
          .then(() =>
            Promise.all([repository.insertBookmark(note), repository.enqueue(noteEntry)]),
          )
          .then(() => true)
          .catch((error) => {
            logStorageError('new text note', error);
            return false;
          });

        // No URL to derive metadata from; this transitions metadata_status to
        // 'skipped' via the existing, tested enrichment path.
        enrichInBackground(note);

        return { status: 'created', bookmark: note, persisted };
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
          status: 'invalid',
          error: 'This web address is too long to save.',
          reason: 'too_long',
        };
      }

      const existing = loadedBookmarks.find(
        (bookmark) => isActiveBookmark(bookmark) && currentDedupeKey(bookmark) === dedupeKey,
      );
      if (existing) {
        const updated = { ...existing, last_saved_at: now };
        setBookmarks((current) =>
          (current ?? []).map((bookmark) => (bookmark.id === existing.id ? updated : bookmark)),
        );
        const persisted = ensureRepositoryReady()
          .then(() => repository.updateBookmark(updated))
          .then(() => true)
          .catch((error) => {
            logStorageError('duplicate save', error);
            return false;
          });
        return { status: 'duplicate', bookmark: existing, persisted };
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
        content_type: 'url',
        preview_image_url: null,
        favicon_url: null,
        site_name: null,
        collection_id: null,
        is_archived: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        last_saved_at: now,
        metadata_status: 'pending',
        sync_status: 'pending',
      };

      const queueEntry: LocalPendingBookmark = {
        local_id: bookmark.id,
        remote_id: null,
        operation: 'create',
        payload: {
          id: bookmark.id,
          url: normalized,
          title: bookmark.title ?? undefined,
          notes: bookmark.notes ?? undefined,
          client_id: clientId,
        },
        sync_status: 'pending',
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
          Promise.all([repository.insertBookmark(bookmark), repository.enqueue(queueEntry)]),
        )
        .then(() => true)
        .catch((error) => {
          logStorageError('new bookmark', error);
          return false;
        });

      // Enrich after the bookmark is already visible and persisted.
      enrichInBackground(bookmark);

      return { status: 'created', bookmark, persisted };
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
      // synced rows (isSyncing true covers this window too, since the pull-
      // on-first-ready effect fires essentially immediately after load).
      // Importing during either window can't recognize already-existing
      // rows and durably re-creates every one of them as a fresh duplicate —
      // this is the exact "561 -> 1122" doubling reported twice. Refuse
      // outright rather than risk it; the caller asks the user to retry.
      if (bookmarksRef.current === null || isSyncing) {
        recordLog(
          'warn',
          `import: refused (not ready) items=${items.length} loaded=${bookmarksRef.current !== null} isSyncing=${isSyncing}`,
        );
        return { imported: 0, duplicates: 0, skipped: 0, notReady: true };
      }
      const now = new Date().toISOString();
      // Latest committed rows (the ref), so an import right after a save sees it.
      const activeLocalBookmarks = (bookmarksRef.current ?? loadedBookmarks).filter(
        (bookmark) => isActiveBookmark(bookmark),
      );
      const seen = new Set(
        activeLocalBookmarks
          .map((bookmark) => currentDedupeKey(bookmark))
          .filter((hash): hash is string => hash !== null),
      );
      // Sentry STASH-3K/3M: a bulk import has repeatedly doubled a user's
      // library (their local total exactly 2x the cloud count) with no
      // evidence of why — this and the summary log below are the
      // instrumentation needed to tell apart "dedupe ran against a near-empty
      // snapshot" (activeLocal/seenKeys far below the real library size) from
      // "dedupe saw everything but let duplicates through anyway" (seenKeys
      // matches the library size but `duplicates` is still ~0 on a re-import).
      recordLog(
        'info',
        `import: starting items=${items.length} activeLocal=${activeLocalBookmarks.length} seenKeys=${seen.size}`,
      );
      const newBookmarks: Bookmark[] = [];
      const newEntries: LocalPendingBookmark[] = [];
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
        if (seen.has(dedupeKey)) {
          duplicates += 1;
          continue;
        }
        seen.add(dedupeKey);

        const id = makeBookmarkId();
        const clientId = makeClientId();
        const title = item.title?.trim() ? item.title.trim() : null;
        const notes = item.notes?.trim() ? item.notes.trim() : null;
        newBookmarks.push({
          id,
          user_id: mockUserId,
          url: normalized,
          canonical_url: null,
          url_hash: dedupeKey,
          title,
          title_is_derived: title ? false : undefined,
          client_id: clientId,
          description: null,
          notes,
          source_app: null,
          content_type: 'url',
          preview_image_url: null,
          favicon_url: null,
          site_name: null,
          collection_id: null,
          is_archived: false,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          last_saved_at: now,
          metadata_status: 'pending',
          sync_status: 'pending',
        });
        newEntries.push({
          local_id: id,
          remote_id: null,
          operation: 'create',
          payload: {
            id,
            url: normalized,
            title: title ?? undefined,
            notes: notes ?? undefined,
            client_id: clientId,
          },
          sync_status: 'pending',
          retry_count: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        });
        imported += 1;
      }

      if (newBookmarks.length > 0) {
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
            // Sequential on purpose (Sentry STASH-3B): a 500+ item import via
            // Promise.all meant ~1000 simultaneous pending native SQLite calls.
            // newBookmarks/newEntries are parallel arrays (pushed together above).
            for (let i = 0; i < newBookmarks.length; i += 1) {
              await repository.insertBookmark(newBookmarks[i]);
              await repository.enqueue(newEntries[i]);
              releaseAndEnrich(newBookmarks[i]);
            }
          })
          .catch((error) => logStorageError('imported bookmarks', error))
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
            if (localCreateFlushesInFlight.current === 0 && syncPendingRef.current) {
              setTimeout(() => {
                void syncNowRef.current?.().catch(() => {});
              }, 50);
            }
          });
      }

      recordLog(
        'info',
        `import: finished items=${items.length} imported=${imported} duplicates=${duplicates} skipped=${skipped}`,
      );
      return { imported, duplicates, skipped };
    },
    [loadedBookmarks, enrichInBackground, isSyncing],
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
    const existing = bookmarksRef.current?.find((bookmark) => bookmark.id === id);
    if (!existing) {
      return;
    }
    const updated: Bookmark = { ...existing, last_accessed_at: new Date().toISOString() };
    setBookmarks((current) =>
      current === null ? current : current.map((bookmark) => (bookmark.id === id ? updated : bookmark)),
    );
    ensureRepositoryReady()
      .then(() => repository.updateBookmark(updated))
      .catch((error) => logStorageError('bookmark access', error));
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
    if (!current || current.status !== 'complete') {
      return;
    }
    const stale: AIEnrichment = { ...current, status: 'stale', updated_at: new Date().toISOString() };
    setEnrichments((rows) => rows.map((row) => (row.id === stale.id ? stale : row)));
    ensureRepositoryReady()
      .then(() => repository.upsertEnrichments([stale]))
      .catch((error) => logStorageError('enrichment staleness', error));
  }, []);

  const updateBookmarkFields = useCallback(
    (id: string, fields: { title?: string; notes?: string }) => {
      const before = bookmarksRef.current?.find((bookmark) => bookmark.id === id);
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
        (patch.title !== undefined && patch.title !== (before?.title ?? null)) ||
        (patch.notes !== undefined && patch.notes !== (before?.notes ?? null));
      applyBookmarkUpdate(id, patch);
      if (textChanged) {
        markEnrichmentStale(id);
      }
    },
    [applyBookmarkUpdate, markEnrichmentStale],
  );

  const refreshBookmarkPreview = useCallback(
    async (id: string): Promise<string | null> => {
      const bookmark = bookmarksRef.current?.find((item) => item.id === id);
      if (!bookmark?.url) {
        return 'Preview refresh needs a URL bookmark.';
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
        const latest = bookmarksRef.current?.find((item) => item.id === id) ?? bookmark;
        const syncsRemotely = hasSyncedOnce(id);
        const updated: Bookmark = {
          ...latest,
          ...nextPatch,
          sync_status: syncsRemotely ? 'pending' : latest.sync_status,
          ever_synced: syncsRemotely ? true : latest.ever_synced,
          updated_at: new Date().toISOString(),
        };
        setBookmarks((current) =>
          current === null
            ? current
            : current.map((item) => (item.id === id ? updated : item)),
        );
        try {
          await ensureRepositoryReady();
          await repository.updateBookmark(updated);
          if (metadata_status === 'failed') {
            await repository.deleteEnrichment(id);
            setEnrichments((current) => current.filter((item) => item.bookmark_id !== id));
          }
        } catch (error) {
          logStorageError('preview refresh', error);
        }
        if (syncsRemotely) {
          enqueueMutation(id, 'update');
        }
        // STASH #573: 'off' means never auto-trigger AI enrichment. This is a
        // direct continuation of the user's own "refresh preview" tap (not a
        // background batch), so it fires immediately rather than through the
        // staggered burst queue below.
        if (metadata_status !== 'failed' && aiSuggestionsModeRef.current !== 'off') {
          void requestAiEnrichmentRef.current?.(id, 'auto', {
            title: updated.title,
            description: updated.description,
            notes: updated.notes,
            site_name: updated.site_name,
            content_type: updated.content_type,
          }).catch(() => {});
        }
        return null;
      } catch (error) {
        recordLog(
          isTransientNetworkError(error) ? 'warn' : 'error',
          `preview refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 'Could not refresh the preview.';
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
      setBookmarks((current) => (current === null ? current : current.filter((b) => b.id !== id)));
      // A gone-forever row has nothing left to retry enriching — drop any
      // armed AI-retry marker so a future backoff check doesn't keep firing
      // doomed requests against a deleted bookmark.
      clearAiRetry(id);
      syncAiRetryIds();
      // Same rationale as above: a permanently-gone row has nothing left to
      // wait for from the server-side overflow queue either.
      clearAiServerQueued(id);
      if (hasSyncedOnce(id)) {
        // The row exists remotely: replace any queued work with a durable
        // delete mutation so the removal reaches Supabase even after restart.
        ensureRepositoryReady()
          .then(() => repository.deleteBookmark(id))
          .catch((error) => logStorageError('delete bookmark', error));
        enqueueMutation(id, 'delete');
        return;
      }
      // Local-only: drop any pending queue entry so it is never created remotely.
      setQueue((current) => current.filter((entry) => entry.local_id !== id));
      ensureRepositoryReady()
        .then(() => Promise.all([repository.deleteBookmark(id), repository.removeQueueEntry(id)]))
        .catch((error) => logStorageError('delete bookmark', error));
    },
    [enqueueMutation, clearAiRetry, syncAiRetryIds, clearAiServerQueued, hasSyncedOnce],
  );

  const emptyTrash = useCallback(() => {
    const trashed = (bookmarksRef.current ?? []).filter((b) => b.deleted_at != null);
    for (const bookmark of trashed) {
      deleteBookmark(bookmark.id);
    }
  }, [deleteBookmark]);

  // Destructive library reset (issue #600). Remote first: one server-side RPC
  // wipes every cloud row the user owns set-wise (no per-bookmark delete
  // entries); only once that succeeds is local state cleared — repository,
  // sync queue, tag/collection cache, enrichments, AI bookkeeping, and the
  // pull watermark — so stale queued mutations can never re-upload the
  // just-deleted data. If the local clear fails the cloud is already empty and
  // the RPC is idempotent, so the explicit recovery is to run the reset again.
  const resetLibrary = useCallback(async (): Promise<ResetLibraryResult> => {
    if (syncInFlight.current) {
      return { ok: false, reason: 'busy' };
    }
    // An import's sequential durable-write loop (Sentry: user-reported "reset
    // doesn't clear the queue in one shot") uses this separate counter, not
    // syncInFlight. Without this check, a reset landing mid-import wipes
    // storage via clearAllData() and the import's still-running loop then
    // keeps calling insertBookmark/enqueue for its remaining items — silently
    // repopulating the library right after the "clear".
    if (localCreateFlushesInFlight.current > 0) {
      return { ok: false, reason: 'busy' };
    }
    if (!auth.session) {
      return { ok: false, reason: 'auth' };
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
        recordLog('warn', `library reset: remote wipe failed: ${String(error)}`);
        return {
          ok: false,
          reason: 'remote',
          message: error instanceof Error ? error.message : undefined,
        };
      }
      recordLog('warn', 'library reset: remote wipe succeeded; clearing local state');
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
        await repository.setMeta(LAST_PULLED_AT_KEY, '');
      } catch (error) {
        logStorageError('library reset local clear', error);
        return { ok: false, reason: 'local' };
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
      applyUnseenSuggestions(new Set());
      applyTagOps([]);
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
  // Failures stay queued for the next sync.
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
    for (const op of ops) {
      // The bookmark must exist remotely before its tags can be linked.
      if (!hasSyncedOnce(op.bookmark_id)) {
        continue;
      }
      try {
        if (op.op === 'add') {
          const ensured = await api.addTags({
            bookmark_id: op.bookmark_id,
            tags: [op.tag_name],
            source: op.source,
          });
          const serverTag =
            ensured.find((tag) => normalizeTag(tag.name) === normalizeTag(op.tag_name)) ??
            ensured[0];
          if (serverTag) {
            applyTagData(reconcileSyncedAdd(tagDataRef.current, op.tag_name, serverTag));
          }
        } else {
          await api.removeTags({ bookmark_id: op.bookmark_id, tags: [op.tag_name] });
        }
        applyTagOps(dequeueTagOp(pendingTagOpsRef.current, op.bookmark_id, op.tag_name));
        mutationsPushed = true;
      } catch (error) {
        // Keep the op queued; the next sync retries it.
        recordLog('warn', `tag sync failed (${op.op} ${op.tag_name}): ${String(error)}`);
      }
    }
    if (mutationsPushed) {
      broadcastSyncNudgeRef.current?.();
    }
    return mutationsPushed;
  }, [auth.session, applyTagData, applyTagOps, hasSyncedOnce]);

  // Local-first: apply the tag immediately and queue the upload. Works offline
  // and the moment a bookmark has synced; the queued op uploads on the next sync.
  const addTagsToBookmark = useCallback(
    async (bookmarkId: string, names: string[]): Promise<string | null> => {
      if (!hasSyncedOnce(bookmarkId)) {
        return 'Tags can be added once this bookmark has synced.';
      }
      const cleaned = names.map((name) => name.trim()).filter((name) => name.length > 0);
      if (cleaned.length === 0) {
        return 'Enter a tag name.';
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
          op: 'add',
          source: 'user',
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
        return 'Seeded sample tags cannot be edited.';
      }
      const op: PendingTagOp = {
        id: makeUuid(),
        bookmark_id: bookmarkId,
        tag_name: tagName,
        op: 'remove',
        source: 'user',
        confidence: null,
        created_at: new Date().toISOString(),
      };
      applyTagData(applyTagOp(tagDataRef.current, op, auth.userId ?? mockUserId));
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
      source: 'auto' | 'manual' = 'manual',
      overrideMetadata?: EnrichmentMetadataHint,
    ): Promise<string | null> => {
      if (!auth.session) {
        return 'AI suggestions need the cloud — Supabase is not available right now.';
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
        return 'AI suggestions are available once this bookmark has synced.';
      }
      if (aiEnriching.current.has(bookmarkId)) {
        return null;
      }
      // Library-reset race guard: snapshot the epoch now; every settle path
      // below re-checks it and discards if a reset completed meanwhile.
      const epochAtStart = resetEpoch.current;
      aiEnriching.current.add(bookmarkId);
      setEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      if (source === 'manual') {
        setManualEnrichingIds((prev) => new Set(prev).add(bookmarkId));
      }
      try {
        // The edge function forwards this access token to PostgREST, which 401s
        // on a stale one. The token can expire while the app sits idle, so
        // refresh it before the call (as the sync paths do) instead of reusing
        // the possibly-expired `auth.session`.
        const session = (await auth.ensureAnonymousSession()) ?? auth.session;
        if (!session) {
          return 'AI suggestions need the cloud — Supabase is not available right now.';
        }
        // Send the device's freshest metadata: the cloud row can still be a bare
        // URL (on-device OpenGraph enrichment may not have synced yet), and the
        // model would otherwise have nothing to reason about.
        const latest = bookmarksRef.current?.find((item) => item.id === bookmarkId);
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
            const refreshed = (await auth.ensureAnonymousSession(true)) ?? session;
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
          logStorageError('ai enrichment', error);
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
        if (aiSuggestionsModeRef.current === 'auto_accept') {
          try {
            await autoAcceptEnrichmentRef.current?.(bookmarkId, enrichment);
          } catch (error) {
            recordLog('warn', `ai-enrich auto_accept failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // A background auto-enrichment lands without the user looking at this
        // bookmark, so flag it for the Inbox "new suggestions" banner. A manual
        // "Suggest with AI" tap happens on the Detail screen — the user is
        // already witnessing it — so it doesn't (and Detail clears the flag).
        // In auto_accept mode this only fires for whatever auto-accept left
        // behind (e.g. a pending summary — auto-accept never touches notes).
        if (source === 'auto') {
          noteUnseenSuggestions(enrichment);
        }
        return null;
      } catch (error) {
        // A library reset completed while this request was in flight: the
        // bookmark is gone, so record nothing — no retry marker, no overflow
        // enqueue — or the reset's just-emptied bookkeeping gets repopulated.
        if (resetEpoch.current !== epochAtStart) {
          return error instanceof Error ? error.message : 'Could not generate AI suggestions.';
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
          // STASH #578 Phase 2: instead of just returning the rate-limited
          // sentinel, enqueue this bookmark for the background overflow
          // worker to retry later. Fire-and-forget in the strictest sense —
          // wrapped in its own try/catch (not just a promise .catch(), since a
          // missing session or a synchronous throw must not escape either):
          // an enqueue failure must never change what the caller sees for
          // this 429, and is never retried here.
          if (auth.session) {
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
            try {
              createSyncApi(auth.session)
                .enqueuePendingEnrichment(bookmarkId, localeRef.current ?? undefined)
                .then(() => {
                  // CONFIRMED: the server durably accepted this bookmark into
                  // the overflow queue, so the background worker will
                  // deliver a real result via normal sync. Only set on this
                  // resolution — never eagerly, and never below in the
                  // .catch()/synchronous-throw branches, which fall back to
                  // the generic armAiRetry marker above alone.
                  //
                  // But skip it if a real enrichment already landed for this
                  // bookmark since the enqueue was fired (a faster manual
                  // retry, or — in principle — an extremely fast worker
                  // delivery): marking it queued now would strand a "will
                  // arrive automatically" note on an already-complete
                  // bookmark forever. See the snapshot comment above.
                  // Un-awaited, so this can also land AFTER a library reset
                  // that ran while the enqueue round-tripped — in which case
                  // the reference-equality check below would pass vacuously
                  // (both sides undefined once the reset emptied the cache)
                  // and strand a marker for a deleted bookmark. Same epoch
                  // guard as the other settle paths.
                  if (resetEpoch.current !== epochAtStart) {
                    return;
                  }
                  const enrichmentNow = enrichmentsRef.current.find(
                    (item) => item.bookmark_id === bookmarkId,
                  );
                  if (enrichmentNow === enrichmentBeforeEnqueue) {
                    markAiServerQueued(bookmarkId);
                  }
                })
                .catch((enqueueError: unknown) => {
                  recordLog(
                    'warn',
                    `pending_ai_enrichment enqueue failed: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
                  );
                });
            } catch (enqueueError) {
              recordLog(
                'warn',
                `pending_ai_enrichment enqueue threw: ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}`,
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
        const status = isHttpError ? ` (HTTP ${error.status})` : '';
        // A raw client-side transport failure (device offline, DNS unresolved)
        // never reached the function — an expected condition, not an outage — so
        // log it as a warn breadcrumb instead of an error that forwards to Sentry
        // and floods the issue stream (STASH-4). A SupabaseRequestError means the
        // function actually responded with an error status: a genuine server/
        // function failure that stays at 'error' even when its body echoes a
        // transport-looking message (e.g. the function's own upstream fetch failed).
        const level = !isHttpError && isTransientNetworkError(error) ? 'warn' : 'error';
        recordLog(level, `ai-enrich failed${status}: ${detail}`);
        return error instanceof Error ? error.message : 'Could not generate AI suggestions.';
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
        if (source === 'manual') {
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
    (bookmarkId: string): boolean => aiRetryIds.has(bookmarkId) && !enrichingIds.has(bookmarkId),
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
    async (bookmarkId: string, suggestions: SuggestedTag[]): Promise<string | null> => {
      if (!hasSyncedOnce(bookmarkId)) {
        return 'Tags can be added once this bookmark has synced.';
      }
      const valid = suggestions.filter((suggestion) => suggestion.name.trim().length > 0);
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
          op: 'add',
          source: 'ai',
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
    [auth.userId, applyTagData, applyTagOps, markSuggestionsReviewed, syncTagOps, hasSyncedOnce],
  );

  const assignCollection = useCallback(
    (bookmarkId: string, collectionId: string | null) =>
      applyBookmarkUpdate(bookmarkId, { collection_id: collectionId }),
    [applyBookmarkUpdate],
  );

  const createCollection = useCallback(
    async (name: string): Promise<{ collection?: Collection; error?: string }> => {
      if (!auth.session) {
        return { error: 'Collections need the cloud — Supabase is not available right now.' };
      }
      if (!name.trim()) {
        return { error: 'Enter a collection name.' };
      }
      try {
        const api = createSyncApi(auth.session);
        const created = await api.createCollection(name);
        const current = tagDataRef.current;
        applyTagData({ ...current, collections: [...current.collections, created] });
        return { collection: created };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : 'Could not create the collection.',
        };
      }
    },
    [auth, applyTagData],
  );

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
      const bookmark = bookmarksRef.current?.find((item) => item.id === bookmarkId);
      if (!bookmark) {
        return; // gone (trashed/deleted) mid-flight — nothing to apply to
      }
      const applied = appliedTagNamesRef(bookmarkId);
      const reviewed = new Set(
        (bookmark.dismissed_suggested_tags ?? []).map((name) => name.toLowerCase()),
      );
      const suggestions = pendingSuggestions(enrichment, applied, reviewed);
      const dismissedFolderTokens = new Set(bookmark.dismissed_suggested_folders ?? []);
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
      const folderTokens = suggestedFolderTokens(folder, enrichment.suggested_collection_name);
      await acceptSuggestionBundle(
        { acceptSuggestedTags, addTagsToBookmark, assignCollection, createCollection, dismissFolderSuggestion },
        {
          bookmarkId,
          aiSuggestions: suggestions,
          folder,
          folderTokens,
          createCollectionError: 'Could not create the collection.',
        },
      );
    },
    [appliedTagNamesRef, acceptSuggestedTags, addTagsToBookmark, assignCollection, createCollection, dismissFolderSuggestion],
  );
  useEffect(() => {
    autoAcceptEnrichmentRef.current = autoAcceptEnrichment;
  }, [autoAcceptEnrichment]);

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
    async (currentUser: { id: string; isAnonymous: boolean }): Promise<void> => {
      try {
        const previousUserId = await repository.getMeta(SYNCED_USER_ID_KEY);
        const previousAnon = (await repository.getMeta(SYNCED_USER_ANON_KEY)) === 'true';
        const plan = planAccountTransition(
          previousUserId ? { id: previousUserId, isAnonymous: previousAnon } : null,
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
            rehome: (idMap) => {
              // Carry the old→new id forward so a screen holding a re-homed
              // bookmark's old id still resolves it via getBookmark.
              for (const [oldId, newId] of idMap) {
                idAliases.current.set(oldId, newId);
              }
              // Re-key tag state from the re-homed bookmarks' old ids onto their
              // new local ids so the carried-over tags upload (via syncTagOps)
              // against the row that now exists in the new account.
              applyTagOps(rekeyPendingTagOps(pendingTagOpsRef.current, idMap));
              const links = tagDataRef.current.bookmarkTags.map((link) => {
                const newId = idMap.get(link.bookmark_id);
                return newId ? { ...link, bookmark_id: newId } : link;
              });
              applyTagData({ ...tagDataRef.current, bookmarkTags: links });
              // Re-key AI-suggestion bookkeeping the same way, so the carried-
              // over bookmark keeps its retry eligibility under its new id
              // instead of stranding it on the stale old one.
              remapAiRetryIdentity(idMap);
            },
            drop: (ids) => {
              // Real A→real B switch: purge A's pending tag ops + links so a
              // later syncTagOps call (now under B's auth) can't upload A's
              // tags as B or surface them in B's UI.
              applyTagOps(dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, ids));
              const dropped = new Set(ids);
              const links = tagDataRef.current.bookmarkTags.filter(
                (link) => !dropped.has(link.bookmark_id),
              );
              applyTagData({ ...tagDataRef.current, bookmarkTags: links });
              // Purge A's AI-suggestion bookkeeping too, so checkAiRetries (no
              // ownership check) can't fire requestAiEnrichment against A's
              // bookmark id under B's now-active session.
              dropAiRetryBookkeeping(ids);
            },
          },
        );
      } catch (error) {
        logStorageError('account transition', error);
      }
    },
    [applyTagOps, applyTagData, remapAiRetryIdentity, dropAiRetryBookkeeping],
  );

  const syncNow = useCallback(async (): Promise<boolean> => {
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
    // Upload-then-pull: even with nothing to upload, the pull still runs.
    const syncable = queue.filter(isSyncable);
    // Sentry STASH-3K/3M: pairs with the import-side logging above. A bulk
    // import that already shows up here with a suspiciously large create
    // count (e.g. matching a prior "561 -> 1122" report) confirms the
    // duplication happened before upload, not during it; a normal count here
    // despite a later doubled server-side total would point at the upload
    // path instead. Gated on size so an everyday small sync doesn't spam it.
    const pendingCreateCount = syncable.filter((entry) => entry.operation === 'create').length;
    if (pendingCreateCount > 10) {
      recordLog(
        'info',
        `sync: uploading ${pendingCreateCount} pending create(s) (queue total ${queue.length})`,
      );
    }

    syncInFlight.current = true;
    setIsSyncing(true);
    let mutationsPushed = false;
    try {
      await ensureRepositoryReady();
      // Re-ensure the session so a token that expired while the app stayed
      // open is refreshed before we sync; otherwise every entry would fail
      // against a stale bearer token until restart.
      const session = (await auth.ensureAnonymousSession()) ?? auth.session;
      const api = createSyncApi(session);
      const getLatestBookmark = (id: string) =>
        bookmarksRef.current?.find((bookmark) => bookmark.id === id);
      const applySyncEntryResult = async (
        entry: LocalPendingBookmark,
        result: Awaited<ReturnType<typeof syncQueueEntry>>,
      ): Promise<boolean> => {
        if (crossedHealthEscalationThreshold(entry.retry_count, result.entry.retry_count)) {
          reportSyncQueueHealthEscalation({
            operation: entry.operation,
            retryCount: result.entry.retry_count,
            lastError: result.entry.last_error,
          });
        }

        // Deleted while a create/update was in flight: don't resurrect it.
        // Undo the rows syncQueueEntry just persisted and best-effort delete
        // the remote copy so the user's delete wins end to end.
        if (entry.operation !== 'delete' && deletedIds.current.has(entry.local_id)) {
          const replacementId = result.bookmarkUpdate?.id;
          ensureRepositoryReady()
            .then(() =>
              Promise.all([
                replacementId ? repository.deleteBookmark(replacementId) : Promise.resolve(),
                // Superseded-aware: a durable delete entry enqueued for this
                // bookmark while we were uploading must NOT be removed here.
                removeQueueEntryIfNotSuperseded(repository, entry),
              ]),
            )
            .catch((error) => logStorageError('post-delete sync cleanup', error));
          if (result.entry.remote_id && result.entry.remote_id !== entry.local_id) {
            // The upload created a remote row for a bookmark the user already
            // deleted. Enqueue a durable delete (not a best-effort request) so
            // the removal survives app exit and request failures; the next
            // sync pass processes it.
            enqueueMutation(result.entry.remote_id, 'delete');
          }
          return false;
        }

        setQueue((current) =>
          result.removeEntry
            ? current.filter((queued) => queued.local_id !== entry.local_id)
            : current.map((queued) =>
                queued.local_id === entry.local_id ? result.entry : queued,
              ),
        );
        if (result.removeEntry) {
          mutationsPushed = true;
        }
        if (result.removedBookmarkId) {
          // The row was deleted on another device while this device's
          // queued edit could never land (see sync-bookmarks.ts). Drop it
          // from in-memory state too — the repository row is already gone.
          const removedId = result.removedBookmarkId;
          setBookmarks((current) => (current ?? []).filter((bookmark) => bookmark.id !== removedId));
        }
        if (result.bookmarkUpdate) {
          const update = result.bookmarkUpdate;
          // The update was built from a snapshot taken before the upload.
          // Enrichment may have completed in the meantime, so apply only the
          // sync-owned fields (status) onto the LATEST row instead of writing
          // the stale snapshot back.
          //
          // Compute `merged` from the ref SYNCHRONOUSLY — never from inside the
          // setBookmarks updater. A functional updater doesn't run until React's
          // next render, so reading a variable it assigns right after the call
          // sees the pre-update value (null). That silently skipped this whole
          // block, so neither the metadata-reconciliation update nor the AI
          // auto-trigger ever fired after a create synced.
          const latest = bookmarksRef.current?.find((bookmark) => bookmark.id === update.id);
          const merged: Bookmark | null = latest
            ? {
                ...latest,
                sync_status: update.sync_status,
                ever_synced: update.ever_synced,
                updated_at: update.updated_at,
              }
            : null;
          if (merged) {
            setBookmarks((current) =>
              (current ?? []).map((bookmark) => (bookmark.id === merged.id ? merged : bookmark)),
            );
            ensureRepositoryReady()
              .then(() => repository.updateBookmark(merged))
              .catch((error) => logStorageError('post-sync merge', error));

            // `uploadedPayload` is set IFF a create just uploaded — whether
            // the entry began as a `create` or was promoted from an orphaned
            // `update` (a bookmark whose create never reached the server). Use
            // it, not `entry.operation`, so a promoted create reconciles and
            // AI-triggers too: the loop's `entry.operation` is still 'update'.
            const createUploaded = result.uploadedPayload !== undefined;
            // The create payload only carries url/title/notes, and the remote
            // row defaults to no generated metadata + pending status + active.
            // If the local row has since diverged — archived, filed into a
            // collection, edited, enriched, or TRASHED while the create was
            // uploading — reconcile with a follow-up update so those changes
            // reach the cloud. Without the `deleted_at` arm, a bookmark trashed
            // before it had a remote id would stay live in the cloud and
            // resurrect on other devices.
            if (createUploaded && createNeedsReconcileUpdate(merged, result.uploadedPayload)) {
              enqueueMutation(merged.id, 'update');
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
        const completedLocalIds = new Set<string>();
        const completions: CreateSyncCompletion[] = [];
        type UploadedPayload = NonNullable<typeof results[number]['uploadedPayload']>;
        const followUpUpdates: Array<{ id: string; payload: UploadedPayload }> = [];
        const pendingAiIds: string[] = [];
        let nextBookmarks = bookmarksRef.current ?? [];

        for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
          const entry = chunk[resultIndex]!;
          const result = results[resultIndex]!;

          if (entry.operation !== 'delete' && deletedIds.current.has(entry.local_id)) {
            const replacementId = result.bookmarkUpdate?.id;
            ensureRepositoryReady()
              .then(() =>
                Promise.all([
                  replacementId ? repository.deleteBookmark(replacementId) : Promise.resolve(),
                  removeQueueEntryIfNotSuperseded(repository, entry),
                ]),
              )
              .catch((error) => logStorageError('post-delete sync cleanup', error));
            if (result.entry.remote_id && result.entry.remote_id !== entry.local_id) {
              enqueueMutation(result.entry.remote_id, 'delete');
            }
            continue;
          }

          if (!result.removeEntry) {
            continue;
          }

          completedLocalIds.add(entry.local_id);

          if (!result.bookmarkUpdate) {
            continue;
          }

          const update = result.bookmarkUpdate;
          const latest = nextBookmarks.find((bookmark) => bookmark.id === update.id);
          if (!latest) {
            continue;
          }
          const merged: Bookmark = {
            ...latest,
            sync_status: update.sync_status,
            ever_synced: update.ever_synced,
            updated_at: update.updated_at,
          };
          nextBookmarks = nextBookmarks.map((bookmark) =>
            bookmark.id === merged.id ? merged : bookmark,
          );
          completions.push({ bookmark: merged, entry });

          if (result.uploadedPayload !== undefined) {
            if (createNeedsReconcileUpdate(merged, result.uploadedPayload)) {
              followUpUpdates.push({ id: merged.id, payload: result.uploadedPayload });
            }
            pendingAiIds.push(merged.id);
          }
        }

        if (completedLocalIds.size === 0) {
          return;
        }

        mutationsPushed = true;
        bookmarksRef.current = nextBookmarks;
        setBookmarks(nextBookmarks);
        setQueue((current) => current.filter((queued) => !completedLocalIds.has(queued.local_id)));

        await ensureRepositoryReady();
        if (repository.completeCreateSyncBatch) {
          await repository.completeCreateSyncBatch(completions);
        } else {
          await Promise.all(
            completions.flatMap(({ bookmark, entry }) => [
              repository.updateBookmark(bookmark),
              removeQueueEntryIfNotSuperseded(repository, entry),
            ]),
          );
        }

        for (const { id } of followUpUpdates) {
          enqueueMutation(id, 'update');
        }
        for (const id of pendingAiIds) {
          markPendingAiTrigger(id);
        }
      };
      const bulkSyncedLocalIds = new Set<string>();
      const bulkCreateEntries = syncable.filter(
        (entry) =>
          entry.operation === 'create' &&
          !deletedIds.current.has(entry.local_id) &&
          hasBulkCreateResultKey(entry) &&
          isSyncable(entry),
      );
      if (bulkCreateEntries.length > 1) {
        for (let index = 0; index < bulkCreateEntries.length; index += BULK_CREATE_SYNC_CHUNK_SIZE) {
          // Re-checked every chunk: pausing mid-import must stop the
          // remaining chunks from uploading, not just block the next
          // syncNow call.
          if (syncPausedRef.current) {
            break;
          }
          const chunk = bulkCreateEntries.slice(index, index + BULK_CREATE_SYNC_CHUNK_SIZE);
          const chunkIds = new Set(chunk.map((entry) => entry.local_id));
          try {
            setQueue((current) =>
              current.map((queued) =>
                chunkIds.has(queued.local_id) ? { ...queued, sync_status: 'syncing' } : queued,
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
            recordLog(
              'warn',
              `bulk create sync failed; falling back to single-entry sync (${
                error instanceof Error ? error.message : String(error)
              })`,
            );
            setQueue((current) =>
              current.map((queued) => {
                const original = chunk.find((entry) => entry.local_id === queued.local_id);
                return original ? { ...queued, sync_status: original.sync_status } : queued;
              }),
            );
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
        if (entry.operation !== 'delete' && deletedIds.current.has(entry.local_id)) {
          continue;
        }

        // A storage/repository failure on one entry must not abort the whole
        // run and strand this (and every later) entry at 'syncing' forever.
        // Mark just this entry failed so the next pass retries it.
        try {
          setQueue((current) =>
            current.map((queued) =>
              queued.local_id === entry.local_id ? { ...queued, sync_status: 'syncing' } : queued,
            ),
          );

          const result = await syncQueueEntry(api, repository, entry, getLatestBookmark);
          await applySyncEntryResult(entry, result);
        } catch (error) {
          logStorageError('sync entry', error);
          const failed: LocalPendingBookmark = {
            ...entry,
            sync_status: 'failed',
            retry_count: entry.retry_count + 1,
            last_error: error instanceof Error ? error.message : 'Sync failed.',
            updated_at: new Date().toISOString(),
          };
          setQueue((current) =>
            current.map((queued) => (queued.local_id === entry.local_id ? failed : queued)),
          );
          ensureRepositoryReady()
            .then(() => repository.updateQueueEntry(failed))
            .catch((persistError) => logStorageError('sync entry fail-persist', persistError));
        }
      }

      const currentUser = {
        id: session.user.id,
        isAnonymous: session.user.is_anonymous !== false,
      };

      // Before pulling: reconcile the local cache with the signed-in user so
      // the pull can never treat another account's rows as remote deletions.
      await reconcileAccountTransition(currentUser);

      // Upload any queued local-first tag ops before pulling, so the pull's
      // server snapshot already reflects them.
      const tagsSynced = await syncTagOps();
      if (tagsSynced) {
        mutationsPushed = true;
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
                (queued) => queued.local_id === bookmarkId && queued.sync_status !== 'synced',
              ),
            currentUser,
          );
          if (result.upserts.length > 0 || result.deletions.length > 0) {
            const upsertIds = new Set(result.upserts.map((bookmark) => bookmark.id));
            const removed = new Set(result.deletions);
            setBookmarks((current) => [
              ...(current ?? []).filter(
                (bookmark) => !upsertIds.has(bookmark.id) && !removed.has(bookmark.id),
              ),
              ...result.upserts,
            ]);
          }
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
              enrichmentsRef.current.map((enrichment) => [enrichment.id, enrichment] as const),
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
              const isNewOrNewer = !known || enrichment.updated_at > known.updated_at;
              if (isNewOrNewer) {
                noteUnseenSuggestions(enrichment);
                if (!aiEnriching.current.has(enrichment.bookmark_id)) {
                  workerDrivenCount += 1;
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
              if (isNewOrNewer && enrichment.bookmark_id in aiRetryState.current) {
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
              if (isNewOrNewer && aiServerQueued.current.has(enrichment.bookmark_id)) {
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
              setAiEnrichmentBurstToast({ count: workerDrivenCount, token: aiBurstTokenSeq.current });
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
        } catch (error) {
          logStorageError('pull', error);
        }
      }
    } catch (error) {
      logStorageError('sync run', error);
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
  }, [
    auth,
    queue,
    enqueueMutation,
    requestAiEnrichment,
    syncTagOps,
    noteUnseenSuggestions,
    reconcileAccountTransition,
  ]);

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
          recordLog('info', `title-backfill: repaired ${count} URL-derived title(s)`);
        }
      } catch (error) {
        logStorageError('title backfill', error);
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
      if (bookmark.metadata_status === 'pending') {
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
      aiSuggestionsModeRef.current === 'off'
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
      if (bookmark.metadata_status === 'pending') {
        continue; // metadata fetch still in flight — fire once it settles
      }
      // Already has suggestions (enriched in a prior session or via the manual
      // action): clear the durable marker without re-requesting.
      if (enrichmentsRef.current.some((enrichment) => enrichment.bookmark_id === id)) {
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
      aiDispatchQueueRef.current = enqueueAiEnrichmentDispatch(aiDispatchQueueRef.current, id);
    }
  }, [bookmarks, auth.session, aiSuggestionsMode, requestAiEnrichment, clearPendingAiTrigger]);

  // Backoff-scheduled AI-suggestion retries: re-attempt any bookmark with an
  // armed retry marker (a prior auto OR manual requestAiEnrichment failure)
  // once enough wall-clock time has passed since its last attempt (see
  // AI_RETRY_BACKOFF_MS). Reads aiRetryState directly (the ref, not the
  // reactive mirror) so it always sees the latest bookkeeping. STASH #573:
  // no-ops entirely when the mode is 'off'.
  const checkAiRetries = useCallback(() => {
    if (!auth.session || aiSuggestionsModeRef.current === 'off') {
      return;
    }
    if (
      queueRef.current.some(
        (entry) => entry.sync_status === 'pending' || entry.sync_status === 'syncing',
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
      aiDispatchQueueRef.current = enqueueAiEnrichmentDispatch(aiDispatchQueueRef.current, id);
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
      if (aiSuggestionsModeRef.current === 'off') {
        // Mode flipped off mid-burst: drop whatever's left rather than keep
        // firing requests for a feature the user just turned off.
        aiDispatchQueueRef.current = EMPTY_AI_ENRICHMENT_BURST_QUEUE;
        return;
      }
      if (aiDispatchInFlight.current) {
        return; // still waiting on the previous dispatch to settle
      }
      if (
        queueRef.current.some(
          (entry) => entry.sync_status === 'pending' || entry.sync_status === 'syncing',
        )
      ) {
        return; // let bookmark sync settle before starting AI work for freshly-created rows
      }
      const { queue, id } = dequeueAiEnrichmentDispatch(aiDispatchQueueRef.current);
      aiDispatchQueueRef.current = queue;
      if (!id) {
        return;
      }
      aiDispatchInFlight.current = true;
      void requestAiEnrichment(id, 'auto')
        .then((error) => {
          if (!error) {
            void clearPendingAiTrigger(id);
          }
        })
        .finally(() => {
          aiDispatchInFlight.current = false;
          aiDispatchQueueRef.current = recordAiEnrichmentDispatchSettled(aiDispatchQueueRef.current);
          if (isBurstComplete(aiDispatchQueueRef.current)) {
            const completed = aiDispatchQueueRef.current.completedInBurst;
            aiDispatchQueueRef.current = clearBurstCompletion(aiDispatchQueueRef.current);
            if (completed >= AI_ENRICHMENT_BURST_TOAST_MIN) {
              aiBurstTokenSeq.current += 1;
              setAiEnrichmentBurstToast({ count: completed, token: aiBurstTokenSeq.current });
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

  // Background sync: upload as soon as auth and local data are ready, and
  // whenever a new pending entry appears. Failed entries are retried on the
  // next save or via the manual Sync now action, not in a hot loop.
  //
  // `signed_out` is deliberately EXCLUDED here: with no session, syncNow can't
  // run, and re-triggering it on every render would hot-loop. The lazy-mint
  // effect below bridges the gap — once it mints an anonymous session, auth
  // flips to `anonymous` and this effect takes over with the queued work.
  useEffect(() => {
    if (
      !isSyncing &&
      bookmarks !== null &&
      (auth.status === 'anonymous' || auth.status === 'authenticated') &&
      // 'syncing' is included so an entry an interrupted run stranded in-flight
      // is re-driven automatically; failed entries wait for a save / Sync now.
      queue.some(
        (entry) => entry.sync_status === 'pending' || entry.sync_status === 'syncing',
      )
    ) {
      void syncNow();
    }
  }, [bookmarks, auth.status, queue, isSyncing, syncNow]);

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
    if (auth.status !== 'signed_out') {
      lazyMintInFlight.current = false;
      return;
    }
    if (
      lazyMintInFlight.current ||
      bookmarks === null ||
      !queue.some((entry) => entry.sync_status === 'pending' || entry.sync_status === 'syncing')
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
        logStorageError('lazy anonymous mint', error);
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
      (auth.status === 'anonymous' || auth.status === 'authenticated') &&
      lastSyncedUserId.current !== auth.userId
    ) {
      // Only claim this user as synced once we can actually start — otherwise a
      // sign-in landing mid-flight (the startup anonymous sync still running)
      // would set the ref and then syncNow() would early-return on its in-flight
      // guard, and with the ref already matching, the effect would never retry.
      // Gating on isSyncing makes the effect re-run when the in-flight sync
      // settles, so the new user's pull still fires.
      lastSyncedUserId.current = auth.userId;
      void syncNow();
    }
  }, [bookmarks, auth.userId, auth.status, isSyncing, syncNow]);

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
    if (auth.status !== 'signed_out') {
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
              applyTagOps(dropPendingTagOpsForBookmarks(pendingTagOpsRef.current, ids));
              const dropped = new Set(ids);
              const links = tagDataRef.current.bookmarkTags.filter(
                (link) => !dropped.has(link.bookmark_id),
              );
              applyTagData({ ...tagDataRef.current, bookmarkTags: links });
              // Purge the logged-out account's AI-suggestion bookkeeping too,
              // so it can't keep firing requestAiEnrichment against its
              // bookmark ids under the next (different) session.
              dropAiRetryBookkeeping(ids);
            },
          },
        );
        // Reset the synced-user meta + watermark so the next session does a full
        // refresh (planAccountTransition + pullRemoteChanges read these). Empty
        // strings read back as falsy/null in both call sites.
        await repository.setMeta(SYNCED_USER_ID_KEY, '');
        await repository.setMeta(SYNCED_USER_ANON_KEY, '');
        await repository.setMeta(LAST_PULLED_AT_KEY, '');
        setLastPulledAt(null);
      } catch (error) {
        logStorageError('logout cache clear', error);
      }
    })();
  }, [auth.status, bookmarks, applyTagOps, applyTagData]);

  const value = useMemo<BookmarksContextValue>(
    () => ({
      isLoading: bookmarks === null,
      loadError,
      inbox: loadedBookmarks
        .filter((bookmark) => isActiveBookmark(bookmark))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      trash: loadedBookmarks
        .filter((bookmark) => bookmark.deleted_at != null)
        .sort((a, b) => (b.deleted_at ?? '').localeCompare(a.deleted_at ?? '')),
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
      updateBookmarkFields,
      markBookmarkAccessed,
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
      updateBookmarkFields,
      markBookmarkAccessed,
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

  return <BookmarksContext.Provider value={value}>{children}</BookmarksContext.Provider>;
}

export function useBookmarks() {
  const context = useContext(BookmarksContext);
  if (!context) {
    throw new Error('useBookmarks must be used within a BookmarksProvider');
  }
  return context;
}
