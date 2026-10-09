import type {
  AIEnrichment,
  Bookmark,
  Collection,
  EnrichmentStatus,
  MetadataStatus,
  SuggestedTag,
  Tag,
  TagSource,
  TextFormat
} from '@/domain/types';

// `local_image_uri` is a device-only field (a captured image's on-disk URI),
// `local_image_mime_type` is the device-only MIME type recorded alongside it,
// `last_accessed_at` is a device-only "last opened" timestamp,
// `title_is_derived` is device-only title provenance, and `video_unavailable`
// is a device-only, self-healing YouTube-availability check result (STASH-61),
// so none is ever part of a remote row, alongside the local-only `sync_status`.
export type RemoteBookmark = Omit<
  Bookmark,
  | 'sync_status'
  | 'local_image_uri'
  | 'local_image_mime_type'
  | 'last_accessed_at'
  | 'title_is_derived'
  | 'video_unavailable'
>;

export interface CreateBookmarkOutput {
  bookmark_id: string;
  status: 'created' | 'duplicate' | 'queued';
  metadata_status: MetadataStatus;
  collection_id?: string | null;
}

export interface BulkCreateBookmarkOutput extends CreateBookmarkOutput {
  client_id?: string | null;
  url_hash?: string | null;
}

export interface ListBookmarksParams {
  query?: string;
  collection_id?: string | null;
  tag_ids?: string[];
  is_archived?: boolean;
  limit?: number;
  cursor?: string;
  sort?: 'created_at_desc' | 'created_at_asc' | 'updated_at_desc' | 'updated_at_asc';
}

export interface BookmarkDetail {
  bookmark: Bookmark;
  tags: Tag[];
  collection: Collection | null;
  enrichment: AIEnrichment | null;
}

export interface UpdateBookmarkInput {
  title?: string | null;
  description?: string | null;
  notes?: string | null;
  description_format?: TextFormat | null;
  notes_format?: TextFormat | null;
  collection_id?: string | null;
  is_archived?: boolean;
  deleted_at?: string | null;
  // Generated metadata, pushed by sync once on-device enrichment completes so
  // other devices see the enriched title/site/favicon rather than the bare
  // create-time payload.
  site_name?: string | null;
  favicon_url?: string | null;
  preview_image_url?: string | null;
  metadata_status?: MetadataStatus;
  dismissed_suggested_tags?: string[] | null;
  dismissed_suggested_folders?: string[] | null;
  reviewed_summary_tokens?: string[] | null;
}

export interface AddTagsInput {
  bookmark_id: string;
  tags: string[];
  source: TagSource;
}

export interface RemoveTagsInput {
  bookmark_id: string;
  tags: string[];
}

/**
 * One bookmark's worth of work for `bulkAttachTagsAndCollections` (issue
 * #713): the bookmark must already exist server-side (bulk-created
 * separately). `tags` names are raw/unnormalized — the method normalizes and
 * dedupes them via `uniqueNormalizedTags` before sending. `collection_name`
 * mirrors `syncPendingImportCollections`'s single-collection-per-bookmark
 * import model; pass `null` to attach tags only.
 */
export interface BulkAttachItem {
  bookmark_id: string;
  tags: Array<{ name: string; source: TagSource }>;
  collection_name: string | null;
}

/**
 * Per-bookmark result of `bulkAttachTagsAndCollections`. `collection` is the
 * resolved-or-created collection row whenever `collection_name` was sent, even
 * if `collection_attached` is false (the bookmark already had a different
 * collection — see the RPC's `collection_id is null` guard) — callers still
 * need it to keep their local collections cache complete. `bookmark_updated_at`
 * is set only when the collection was actually attached (the RPC bumps it then,
 * matching what a normal collection-assigning PATCH does).
 */
export interface BulkAttachResult {
  bookmark_id: string;
  tags: Tag[];
  collection: Collection | null;
  collection_attached: boolean;
  bookmark_updated_at: string | null;
}

export interface UpdateAIEnrichmentInput {
  bookmark_id: string;
  summary?: string | null;
  topics?: string[];
  suggested_tags?: SuggestedTag[];
  suggested_collection_id?: string | null;
  status: EnrichmentStatus;
  model?: string | null;
  confidence?: number | null;
}

export interface ApplyAISuggestionsInput {
  bookmark_id: string;
  tag_names?: string[];
  collection_id?: string | null;
}

/**
 * The device's freshest content fields, passed to `requestEnrichment` so the
 * `ai-enrich` function can reason about real metadata even when the cloud row
 * still lags behind on-device OpenGraph enrichment. All optional: only non-empty
 * values are sent, and the server falls back to the stored row for the rest.
 */
export interface EnrichmentMetadataHint {
  title?: string | null;
  description?: string | null;
  notes?: string | null;
  site_name?: string | null;
  content_type?: string | null;
  collection_id?: string | null;
}

export type PostgrestSort = 'created_at.desc' | 'created_at.asc' | 'updated_at.desc' | 'updated_at.asc';

export type RemoteAIEnrichment = Omit<AIEnrichment, 'topics' | 'suggested_tags'> & {
  topics: unknown;
  suggested_tags: unknown;
};
