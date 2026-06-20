# Data Model

## Entities

### users

User records are managed by Supabase Auth. Application tables reference the auth user ID.

### bookmarks

Stores saved URLs and shared content.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | Primary key. |
| user_id | uuid | Supabase auth user ID. |
| url | text | Original saved URL. Nullable if shared content is text-only. |
| canonical_url | text | Normalized canonical URL when known. |
| url_hash | text | Hash of canonical URL or normalized URL for dedupe. |
| title | text | User-visible title. |
| description | text | Page description or user-provided description. |
| notes | text | User-authored private notes. |
| source_app | text | Source app or share provider when available. |
| content_type | text | `url`, `article`, `image`, `video`, `text`, or `unknown`. |
| preview_image_url | text | Optional rich preview image. |
| favicon_url | text | Optional favicon URL. |
| site_name | text | Optional publisher/site name. |
| collection_id | uuid | Optional collection reference. |
| is_archived | boolean | Archive state. |
| created_at | timestamptz | Creation timestamp. |
| updated_at | timestamptz | Update timestamp. |
| last_saved_at | timestamptz | Last time user attempted to save this content. |
| metadata_status | text | `pending`, `complete`, `failed`, or `skipped`. |
| sync_status | text | Local-only field if stored on device: `pending`, `syncing`, `synced`, or `failed`. |

### tags

Stores user-created and AI-suggested tags.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | Primary key. |
| user_id | uuid | Owner. |
| name | text | Display name. |
| slug | text | Normalized unique tag key per user. |
| source | text | `user`, `ai`, or `system`. |
| created_at | timestamptz | Creation timestamp. |

### bookmark_tags

Join table for bookmarks and tags.

| Column | Type | Notes |
| --- | --- | --- |
| bookmark_id | uuid | Bookmark reference. |
| tag_id | uuid | Tag reference. |
| source | text | `user`, `ai`, or `system`. |
| confidence | numeric | Optional AI confidence score. |
| created_at | timestamptz | Creation timestamp. |

### collections

Simple one-level collections for optional organization.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | Primary key. |
| user_id | uuid | Owner. |
| name | text | Display name. |
| description | text | Optional description. |
| created_at | timestamptz | Creation timestamp. |
| updated_at | timestamptz | Update timestamp. |

### ai_enrichments

Stores AI-generated metadata separately from user-authored bookmark fields.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | Primary key. |
| bookmark_id | uuid | Bookmark reference. |
| user_id | uuid | Owner. |
| summary | text | AI-generated summary. |
| topics | jsonb | Topic labels or structured taxonomy. |
| suggested_tags | jsonb | Suggested tag names and confidence. |
| suggested_collection_id | uuid | Optional suggested collection. |
| model | text | AI model or process identifier. |
| status | text | `pending`, `complete`, `failed`, or `stale`. |
| confidence | numeric | Optional overall confidence. |
| degraded | boolean | True when produced by the heuristic fallback instead of the configured model (rate-limit/outage, or no model key). Surfaced in-app so degraded mode is never silent. |
| degraded_reason | text | Coarse cause when `degraded`: `not_configured`, `rate_limited`, `timeout`, or `provider_error`. |
| created_at | timestamptz | Creation timestamp. |
| updated_at | timestamptz | Update timestamp. |

## Local Queue

The mobile app should maintain a local queue for share intake and offline operation.

### local_pending_bookmarks

| Field | Notes |
| --- | --- |
| local_id | Generated on device. |
| remote_id | Supabase bookmark ID after sync. |
| operation | `create`, `update`, or `delete` — the remote work this entry represents. |
| payload | Normalized shared payload. |
| sync_status | `pending`, `syncing`, `synced`, or `failed`. |
| retry_count | Number of failed sync attempts. |
| last_error | Last sync error, if any. |
| created_at | Local creation timestamp. |
| updated_at | Local update timestamp. |

## Indexes and Constraints

Recommended database constraints:

- Unique active bookmark per `user_id` and `url_hash` when `url_hash` is not null.
- Unique tag per `user_id` and `slug`.
- Index bookmarks by `user_id`, `created_at`, `updated_at`, `is_archived`, and `collection_id`.
- Index bookmark full-text search fields later when search expands beyond simple client-side filtering.
