import type { Bookmark, CreateBookmarkInput } from '@/domain/types';

/**
 * Rebuilds the create payload for a bookmark whose original queue entry has to
 * be regenerated from the stored row — account re-home (anonymous → real) and
 * startup self-heal both do this. A URL bookmark re-sends its URL plus the
 * user-authored fields; a URL-less text note keeps its body in `description`,
 * so it must be re-sent as `shared_text`. Otherwise the rebuilt create would
 * carry neither `url` nor `shared_text`, the server would reject it, and the
 * note would never upload.
 */
export function createPayloadFromBookmark(bookmark: Bookmark): CreateBookmarkInput {
  // Carry the row's stable capture id so a rebuilt create stays idempotent: if
  // the original upload actually reached the cloud, resending the same client_id
  // dedupes against it instead of inserting a duplicate (the failure mode text
  // notes are most exposed to, having no url_hash key).
  const clientId = bookmark.client_id ?? undefined;
  if (bookmark.url) {
    return {
      url: bookmark.url,
      title: bookmark.title ?? undefined,
      notes: bookmark.notes ?? undefined,
      client_id: clientId,
    };
  }
  return {
    title: bookmark.title ?? undefined,
    notes: bookmark.notes ?? undefined,
    shared_text: bookmark.description ?? undefined,
    client_id: clientId,
  };
}

/**
 * Whether a rebuilt create payload has something the server will accept. A row
 * with neither a URL nor any text body can't be uploaded as a create, so the
 * self-heal/re-home paths skip it instead of enqueuing a doomed entry.
 */
export function isUploadableCreate(payload: CreateBookmarkInput): boolean {
  return Boolean(payload.url || payload.shared_text?.trim());
}
