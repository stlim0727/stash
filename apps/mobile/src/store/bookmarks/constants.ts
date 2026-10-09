import type {
  Tag
} from "@/domain/types";
import type {
  TagData
} from "@/storage/types";

export const EMPTY_TAG_DATA: TagData = { tags: [], bookmarkTags: [], collections: [] };

// Shared empty result so getTagsForBookmark returns a stable reference for
// bookmarks with no tags (avoids reallocating + breaking memo equality).
export const EMPTY_TAGS: Tag[] = [];

/** Durable key for the local-first tag operation queue (JSON in meta). */
export const PENDING_TAG_OPS_KEY = "pending_tag_ops";

/** Durable key (JSON id array in meta) for bookmarks awaiting their first auto
 *  AI enrichment. Persisted so a kill during the metadata-fetch window doesn't
 *  drop the auto-trigger — the marker is re-hydrated and fired on next launch. */
export const PENDING_AI_TRIGGER_KEY = "pending_ai_trigger";

/** Durable ids whose Preview Refresh discarded a locally cached enrichment.
 * A later successful refresh must replace the still-present cloud enrichment;
 * the server dispatch trigger intentionally skips rows that already have one. */
export const PENDING_AI_PREVIEW_REFRESH_KEY = "pending_ai_preview_refresh";

/** Durable key (JSON `{ [bookmarkId]: AiRetryState }` in meta) for bookmarks
 *  with a failed AI-enrichment attempt (auto OR manual) that wrote no
 *  `ai_enrichments` row, awaiting a backoff-scheduled retry. Populated by any
 *  `requestAiEnrichment` failure and cleared once a later attempt succeeds or
 *  the attempt cap (`AI_RETRY_MAX_ATTEMPTS`) is exhausted. Purely local
 *  bookkeeping, parallel to `PENDING_AI_TRIGGER_KEY`: it never touches the
 *  bookmark row, `updated_at`, or the sync queue. */
export const AI_RETRY_STATE_KEY = "ai_suggestion_retry";

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
export const AI_SERVER_QUEUED_KEY = "ai_server_queued";

// How many ids reconcileAiServerQueued's status check batches per request
// (Codex review, PR #660) — bounds the `bookmark_id=in.(...)` query target's
// length so a large confirmed-queued backlog can't produce a URI-too-long
// rejection. Matches BULK_CREATE_SYNC_CHUNK_SIZE's batch size for the same
// class of reason (sync/sync-bookmarks.ts).
export const AI_SERVER_QUEUED_STATUS_CHUNK_SIZE = 50;

/** Wall-clock backoff required since a bookmark's last failed attempt before
 *  an AUTOMATIC retry check may fire the next one, indexed by the current
 *  `attemptCount` (how many attempts have failed so far; `0` is a durable
 *  wait-for-sync deferral, not a failed attempt). A manual "Suggest
 *  with AI"/refresh tap ignores this table and always fires immediately. There
 *  is no entry for `AI_RETRY_MAX_ATTEMPTS` (6): that attempt failing exhausts
 *  the cap and clears all bookkeeping instead of scheduling a 7th. */
export const AI_RETRY_BACKOFF_MS: Record<number, number> = {
  0: 0,
  1: 2 * 60_000,
  2: 10 * 60_000,
  3: 60 * 60_000,
  4: 6 * 60 * 60_000,
  5: 24 * 60 * 60_000,
};

/** Total attempts (first + 5 retries) before giving up entirely and clearing
 *  the bookmark's retry marker — it then looks exactly like a bookmark that
 *  was never enriched, with no distinct "gave up" state. */
export const AI_RETRY_MAX_ATTEMPTS = 6;

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
export const AI_QUOTA_DAILY_COOLDOWN_MS = 30 * 60_000;

export const AI_QUOTA_HOURLY_COOLDOWN_MS = 10 * 60_000;

/** Defensive clamp on a server-reported hourly `retry_after` (seconds) before
 *  trusting it for the cooldown — the hourly window is at most 3600s, so
 *  anything outside [1, 3600] is treated as untrustworthy and falls back to
 *  AI_QUOTA_HOURLY_COOLDOWN_MS instead. */
export const AI_QUOTA_HOURLY_RETRY_AFTER_BOUNDS_S = { min: 1, max: 3600 } as const;

/** STASH-4J: how long to wait before a single retry of a `pending_ai_enrichment`
 *  enqueue that failed with an RLS violation (HTTP 403). Production logs show
 *  these landing in tight ~30-in-45-second bursts during a bulk import, each
 *  burst starting right alongside an unrelated Realtime logical-decoding slot
 *  restart on the DB — a platform-level hiccup, not a logic bug: the exact
 *  same insert, replayed moments later against the same row, succeeds cleanly
 *  (verified live in production for several of the affected bookmark ids).
 *  Long enough to clear that window, short enough not to noticeably delay the
 *  "queued" confirmation. */
export const ENQUEUE_RLS_RETRY_DELAY_MS = 5000;

/** How often a foreground periodic timer re-checks the backoff table while the
 *  app sits open (in addition to the cold-launch and foreground-transition
 *  checks). Deliberately coarse — the shortest backoff step is 2 minutes, so
 *  checking much more often than this buys nothing. */
export const AI_RETRY_CHECK_INTERVAL_MS = 5 * 60_000;

/** Max metadata-enrichment fetches in flight at once (Sentry STASH-3B): a bulk
 *  import (or the startup backfill after one) must trickle its fetches instead
 *  of launching hundreds concurrently, which exhausted native resources and
 *  aborted the ART runtime. Low enough to keep a 500-item burst harmless, high
 *  enough that interactive saves never queue behind each other in practice. */
export const ENRICHMENT_FETCH_CONCURRENCY = 4;

/** How long the auto-sync trigger waits after queued work becomes ready before
 *  running a pass. A burst of captures settles its metadata one row at a time,
 *  and each settle used to trigger its own sync; this collects them into a
 *  single bulk upload. Short enough that a lone save still syncs promptly. */
export const METADATA_SYNC_DEBOUNCE_MS = 250;

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for AI suggestion
 *  names the user has reviewed (accepted or dismissed). Drives the "✨" badge so
 *  it reflects *unreviewed* suggestions rather than merely *un-applied* ones. */
export const REVIEWED_SUGGESTIONS_KEY = "reviewed_ai_suggestions";

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the folder
 *  (collection) suggestions the user has dismissed on a bookmark's Detail, keyed
 *  by a stable token (see `suggestedFolderToken`). Persisted so a dismissed
 *  folder chip stays gone when the user re-enters Detail or relaunches — a later
 *  enrichment proposing a *different* folder yields a different token and still
 *  re-surfaces. */
export const DISMISSED_FOLDERS_KEY = "dismissed_folder_suggestions";

/** Durable key (JSON `{ [bookmarkId]: string[] }` in meta) for the AI summaries
 *  the user has reviewed (used as a note or dismissed) on a bookmark's Detail,
 *  keyed by a stable token (see `summaryToken`). Persisted so a summary the user
 *  acted on stays gone when they re-enter Detail or relaunch — a later
 *  enrichment producing a *different* summary yields a different token and still
 *  re-surfaces. */
export const REVIEWED_SUMMARIES_KEY = "reviewed_ai_summaries";

/** Durable key (JSON id array in meta) for bookmarks whose AI suggestions
 *  arrived while the user wasn't looking — a background auto-enrichment, a
 *  server-side trigger result, or another device's enrichment pulled in. Drives
 *  the Inbox "new AI suggestions" banner so freshly-suggested items aren't
 *  stranded behind a per-card badge the user has to scroll to find; an id is
 *  cleared once the user witnesses it (opens its Detail, or visits Review).
 *  Persisted so a suggestion that landed in a session the user never returned to
 *  still announces itself on the next launch. */
export const UNSEEN_SUGGESTIONS_KEY = "unseen_ai_suggestions";

/** Manual "pause sync" safety valve (Sentry STASH-3K follow-up): while on,
 *  syncNow no-ops entirely (no upload, no pull) so a bulk import can be
 *  reviewed — and unwanted rows deleted — before anything reaches the
 *  network. Persisted so it survives leaving the app mid-review. */
export const SYNC_PAUSED_KEY = "pref.sync.paused";

/** Opaque sentinel `requestAiEnrichment` returns when the AI endpoint rate-limits
 *  (HTTP 429). The store is i18n-free, so it can't localize the message itself;
 *  the Detail screen maps this to a translated string. Any non-UI caller (the
 *  deferred auto-trigger) only checks for a non-null error, so the value is
 *  inert there. */
export const AI_RATE_LIMITED = "ai-rate-limited";
