/**
 * Domain types for Stash.
 *
 * Field names intentionally mirror the snake_case columns documented in
 * docs/architecture/data-model.md so the eventual Supabase rows map 1:1.
 */

export type ContentType = 'url' | 'article' | 'image' | 'video' | 'text' | 'unknown';

export type MetadataStatus = 'pending' | 'complete' | 'failed' | 'skipped';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export type TagSource = 'user' | 'ai' | 'system';

export type EnrichmentStatus = 'pending' | 'complete' | 'failed' | 'stale';

export interface Bookmark {
  id: string;
  user_id: string;
  /** Original saved URL. Null if shared content is text-only. */
  url: string | null;
  canonical_url: string | null;
  /** Hash of the canonical or normalized URL, used for dedupe. */
  url_hash: string | null;
  title: string | null;
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
  created_at: string;
  updated_at: string;
  /** Last time the user attempted to save this content. */
  last_saved_at: string;
  metadata_status: MetadataStatus;
  /** Local-only field while the bookmark lives on device. */
  sync_status: SyncStatus;
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
  /** AI model or process identifier. */
  model: string | null;
  status: EnrichmentStatus;
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

/** Input shape for createBookmark per docs/api/bookmarks.md. */
export interface CreateBookmarkInput {
  url?: string;
  title?: string;
  description?: string;
  notes?: string;
  source_app?: string;
  shared_text?: string;
}

export interface LocalPendingBookmark {
  /** Generated on device. */
  local_id: string;
  /** Supabase bookmark ID after sync. */
  remote_id: string | null;
  /** Normalized shared payload. */
  payload: CreateBookmarkInput;
  sync_status: SyncStatus;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
