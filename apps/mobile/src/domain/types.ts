/**
 * Domain types for Stash.
 *
 * Field names intentionally mirror the snake_case columns documented in
 * docs/architecture/data-model.md so the eventual Supabase rows map 1:1.
 */

export type ContentType = 'url' | 'article' | 'image' | 'video' | 'text' | 'unknown';

export type MetadataStatus = 'pending' | 'complete' | 'failed' | 'skipped';

/**
 * Server-dispatch intent, decoupled from `MetadataStatus` (#671):
 * `dispatch_ai_enrichment()` used to infer "should this bookmark get
 * automatic AI?" from metadata_status alone (any settled status dispatched),
 * so a restore/import with already-complete metadata had no way to opt out.
 * `'skip'` suppresses the server trigger; manual "Suggest with AI" is
 * unaffected either way. Mirrors `bookmarks.enrichment_policy`'s check
 * constraint (`supabase/migrations/20260803215821_bookmarks_enrichment_policy.sql`).
 */
export type EnrichmentPolicy = 'auto' | 'skip';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export type TagSource = 'user' | 'ai' | 'system';

export type EnrichmentStatus = 'pending' | 'complete' | 'failed' | 'stale';

/**
 * Why an AI enrichment fell back to the deterministic heuristics instead of the
 * configured model. `not_configured` = no model key set; the rest classify a
 * live-call failure so the UI can tell a transient outage/limit (worth retrying)
 * apart from a permanent config gap. Mirrors the edge function's reasons.
 */
export type EnrichmentDegradedReason =
  | 'not_configured'
  | 'rate_limited'
  | 'timeout'
  | 'provider_error';

export interface Bookmark {
  id: string;
  user_id: string;
  /** Original saved URL. Null if shared content is text-only. */
  url: string | null;
  canonical_url: string | null;
  /** Hash of the canonical or normalized URL, used for dedupe. */
  url_hash: string | null;
  /**
   * Device-generated stable capture id. Resent unchanged on every sync retry so
   * the server can make `create` idempotent for rows that have no `url_hash`
   * (text notes), where retrying an interrupted upload would otherwise insert a
   * duplicate. Optional/null for rows captured before this field existed.
   */
  client_id?: string | null;
  title: string | null;
  /**
   * Local-only provenance for `title`: true when the current title was generated
   * by us from the URL as a fallback (a real page title could not be fetched),
   * false when it is a fetched page title or user-authored. Lets the backfill and
   * UI treat a generated placeholder differently from a real/authored title
   * without inferring from the string — so a real title that merely resembles a
   * fallback is never mistaken for one. Absent on rows enriched before this field
   * existed and on remote-mapped rows; never sent to the cloud.
   */
  title_is_derived?: boolean;
  description: string | null;
  /** User-authored private notes. */
  notes: string | null;
  source_app: string | null;
  content_type: ContentType;
  preview_image_url: string | null;
  favicon_url: string | null;
  site_name: string | null;
  collection_id: string | null;
  is_archived: boolean;
  /** ISO timestamp when this bookmark was moved to the trash. Null = active. */
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  /** Last time the user attempted to save this content. */
  last_saved_at: string;
  /**
   * Local-only ISO timestamp of the last time the user opened this bookmark —
   * either viewing its Detail screen or opening its link. Drives the "Recently
   * opened" Inbox sort. Null/absent until first opened (and for rows captured
   * before this field existed); never sent to the cloud. Optional so existing
   * rows and remote-mapped rows need no migration.
   */
  last_accessed_at?: string | null;
  metadata_status: MetadataStatus;
  /** Local-only field while the bookmark lives on device. */
  sync_status: SyncStatus;
  /**
   * Local-only, permanent record that this row has been confirmed synced to
   * the cloud at least once — set the first time `sync_status` becomes
   * `'synced'` (a create upload succeeding, or a pulled remote row) and never
   * cleared. Needed because `sync_status` alone can't tell "never synced yet"
   * apart from "was synced, now pending again because of a later edit" — both
   * read `'pending'`. Several self-heal/account-transition checks need that
   * distinction (e.g. deciding whether an orphaned queue entry should be
   * rebuilt as a `create` or an `update`) and would otherwise wrongly treat a
   * previously-synced row as brand new, or vice versa. Absent on rows synced
   * before this field existed; those are still correctly read as synced by
   * `sync_status` alone while they stay in that state. Never sent to the cloud.
   */
  ever_synced?: boolean;
  /**
   * Local-only durable on-device URI of a captured image (content_type
   * 'image'). Set when an image is shared into the app; never sent to the
   * cloud. Cloud upload of the binary (and the synced `image_path` it will map
   * to) is deferred to 0.3.x — see docs/architecture/sync-account-switching.md.
   * Optional so existing rows and remote-mapped rows need no migration.
   */
  local_image_uri?: string | null;
  dismissed_suggested_tags?: string[];
  dismissed_suggested_folders?: string[];
  reviewed_summary_tokens?: string[];
}

export interface Tag {
  id: string;
  user_id: string;
  name: string;
  /** Normalized unique tag key per user. */
  slug: string;
  source: TagSource;
  created_at: string;
}

export interface BookmarkTag {
  bookmark_id: string;
  tag_id: string;
  source: TagSource;
  /** Optional AI confidence score. */
  confidence: number | null;
  created_at: string;
}

export interface Collection {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuggestedTag {
  name: string;
  confidence: number;
}

export interface AIEnrichment {
  id: string;
  bookmark_id: string;
  user_id: string;
  summary: string | null;
  topics: string[];
  suggested_tags: SuggestedTag[];
  suggested_collection_id: string | null;
  /** A proposed collection NAME to create when no existing collection fit the
   *  model's hint (the edge function leaves this null once it resolves the hint
   *  to an existing {@link suggested_collection_id}). Lets the app offer "create
   *  this collection & file in" instead of silently dropping the suggestion. */
  suggested_collection_name: string | null;
  /** AI model or process identifier. */
  model: string | null;
  status: EnrichmentStatus;
  confidence: number | null;
  /** True when this enrichment came from the heuristic fallback rather than the
   *  configured model (a rate-limit/outage, or no model key). Surfaced in-app as
   *  a non-error "basic suggestions" signal so degraded mode is never silent. */
  degraded: boolean;
  /** The coarse cause of {@link degraded}, or null when not degraded. */
  degraded_reason: EnrichmentDegradedReason | null;
  created_at: string;
  updated_at: string;
}

/** Input shape for createBookmark per docs/api/bookmarks.md. */
export interface CreateBookmarkInput {
  /**
   * The bookmark's own permanent id (see {@link Bookmark.id}), generated
   * client-side at capture time and sent as the row's primary key so the
   * server never has to hand back a different one for the client to adopt —
   * there is no local→remote id swap. Optional only because some callers of
   * this type (e.g. duplicate-lookup helpers) don't need it; every real
   * creation site sets it.
   */
  id?: string;
  url?: string;
  title?: string;
  description?: string;
  notes?: string;
  source_app?: string;
  shared_text?: string;
  site_name?: string | null;
  favicon_url?: string | null;
  preview_image_url?: string | null;
  metadata_status?: MetadataStatus;
  /**
   * Automatic-AI dispatch intent (#671). Omitted (defaults to `'auto'`
   * server-side) for a fresh save/share; imports/restores send `'skip'` so
   * the server trigger never auto-spends AI quota on them.
   */
  enrichment_policy?: EnrichmentPolicy;
  /**
   * Stable device-generated capture id (see {@link Bookmark.client_id}). Carried
   * in the queue payload so an interrupted upload's retry reuses the same id and
   * the server dedupes instead of inserting a second row — the only idempotency
   * key text notes have, since they carry no `url`.
   */
  client_id?: string;
}

/** What a queue entry asks the sync service to do remotely. */
export type QueueOperation = 'create' | 'update' | 'delete';

export interface LocalPendingBookmark {
  /** Generated on device. */
  local_id: string;
  /** Supabase bookmark ID after sync. */
  remote_id: string | null;
  /** Remote operation to perform. */
  operation: QueueOperation;
  /** Normalized shared payload. */
  payload: CreateBookmarkInput;
  sync_status: SyncStatus;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /**
   * ISO timestamp of the most recent failed upload attempt. The upload
   * queue's retry backoff (see `isSyncable`/`uploadRetryBackoffMs` in
   * `sync/sync-bookmarks.ts`) runs from here — a `failed` entry isn't
   * eligible for another automatic retry until enough time has passed since
   * this attempt. Optional and nullable so an entry persisted before this
   * field existed (already on a device's local queue) loads with it
   * `undefined`, which is deliberately treated as "no wait yet" rather than
   * requiring a storage migration.
   */
  last_attempt_at?: string | null;
}
