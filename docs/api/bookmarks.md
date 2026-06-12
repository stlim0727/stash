# Bookmark API Contract

This contract describes the read/write/modify surface that the mobile app and future AI tools should use. The first implementation can map these operations to Supabase queries or Edge Functions.

## Principles

- All operations are scoped to the authenticated user.
- AI tools should use explicit operations rather than unrestricted database access.
- User-authored fields and AI-generated fields should remain distinguishable.
- Save operations should be idempotent where possible.

## Operations

### createBookmark

Creates or reuses a bookmark for a shared URL or text payload.

Input:

```json
{
  "url": "https://example.com/article",
  "title": "Optional title",
  "description": "Optional description",
  "notes": "Optional user notes",
  "source_app": "Safari",
  "shared_text": "Optional selected text"
}
```

Output:

```json
{
  "bookmark_id": "uuid",
  "status": "created | duplicate | queued",
  "metadata_status": "pending"
}
```

### listBookmarks

Lists bookmarks for the authenticated user.

Parameters:

- `query`
- `collection_id`
- `tag_ids`
- `is_archived`
- `limit`
- `cursor`
- `sort`

### getBookmark

Returns a bookmark, its tags, collection, and latest AI enrichment.

### updateBookmark

Updates user-editable bookmark fields.

Editable fields:

- `title`
- `description`
- `notes`
- `collection_id`
- `is_archived`

### deleteBookmark

Deletes or tombstones a bookmark. The default product behavior should prefer archive over permanent deletion unless the user explicitly deletes.

### addTags

Adds tags to a bookmark. Tags may be created if they do not exist.

Input:

```json
{
  "bookmark_id": "uuid",
  "tags": ["design", "article"],
  "source": "user | ai | system"
}
```

### removeTags

Removes tags from a bookmark.

### updateAIEnrichment

Writes AI-generated summary, topics, suggestions, and processing status.

Input:

```json
{
  "bookmark_id": "uuid",
  "summary": "Short generated summary",
  "topics": ["productivity", "knowledge management"],
  "suggested_tags": [
    { "name": "read-later", "confidence": 0.91 }
  ],
  "status": "complete",
  "model": "future-ai-pipeline"
}
```

### applyAISuggestions

Promotes selected AI suggestions to user-visible organization fields.

Input:

```json
{
  "bookmark_id": "uuid",
  "tag_names": ["productivity"],
  "collection_id": "uuid"
}
```

## Share Intake API Expectations

The share extension should not wait for the remote API before giving user feedback. It should write to local durable storage and call `createBookmark` asynchronously.

Expected sequence:

1. Receive platform share payload.
2. Normalize and validate payload.
3. Persist locally with `sync_status = pending`.
4. Show non-blocking toast.
5. Attempt `createBookmark` in background.
6. Update local sync state.

## Error Handling

- Network failures should leave the local item in a retryable pending state.
- Duplicate saves should return the existing bookmark ID.
- Invalid payloads should fail fast with a non-blocking toast.
- Authorization failures should pause sync and prompt account recovery in the main app.

## Current implementation status

The first client-side implementation lives in `apps/mobile/src/api/bookmarks.ts`. It maps this contract to Supabase REST calls using the anonymous session created by the Milestone 5 bootstrap. The implementation is intentionally not yet wired into the local offline queue; Milestone 7 should call this API from the sync service and update local queue state after remote success/failure.
