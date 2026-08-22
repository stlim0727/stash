import type { Bookmark, CreateBookmarkInput } from '@/domain/types';

/**
 * Rebuilds the create payload for a bookmark whose original queue entry has to
 * be regenerated from the stored row — account re-home (anonymous → real) and
 * startup self-heal both do this. A URL bookmark re-sends its URL plus the
 * user-authored fields; a URL-less text note keeps its body in `description`,
 * so it must be re-sent as `shared_text`; a URL-less image bookmark re-sends
 * `content_type: 'image'` (see below). Otherwise the rebuilt create would
 * carry neither `url`, `shared_text`, nor an image signal, the server would
 * reject it, and the row would never upload.
 */
export function createPayloadFromBookmark(bookmark: Bookmark): CreateBookmarkInput {
  // A rebuilt create is the same saved item under a repaired/re-homed identity,
  // not a newly saved item. Preserve its original date so the server response
  // cannot make an old card jump to the top of the Newest sort on the next pull.
  // Carry the row's stable capture id so a rebuilt create stays idempotent: if
  // the original upload actually reached the cloud, resending the same client_id
  // dedupes against it instead of inserting a duplicate (the failure mode text
  // notes are most exposed to, having no url_hash key).
  const clientId = bookmark.client_id ?? undefined;
  // The bookmark's own id is its permanent identity from the moment it was
  // created (see makeBookmarkId) — resending it here is what lets a rebuilt
  // create for an already-existing row stay keyed to the SAME row instead of
  // minting a second one server-side.
  if (bookmark.url) {
    return {
      id: bookmark.id,
      created_at: bookmark.created_at,
      url: bookmark.url,
      title: bookmark.title ?? undefined,
      notes: bookmark.notes ?? undefined,
      ...(bookmark.deleted_at ? { deleted_at: bookmark.deleted_at } : {}),
      client_id: clientId,
    };
  }
  if (bookmark.content_type === 'image') {
    // `content_type: 'image'` is the explicit signal requirePayload needs —
    // there's no url/shared_text to infer it from. `preview_image_url` is
    // carried through when already uploaded (e.g. a create whose queue entry
    // was lost AFTER a successful upload); when still null, the caller
    // (syncQueueEntry, driven by the live bookmark row's `local_image_uri`,
    // not this snapshot) uploads it before this payload is actually sent —
    // see isUploadableCreate below.
    return {
      id: bookmark.id,
      created_at: bookmark.created_at,
      content_type: 'image',
      title: bookmark.title ?? undefined,
      notes: bookmark.notes ?? undefined,
      preview_image_url: bookmark.preview_image_url ?? undefined,
      ...(bookmark.deleted_at ? { deleted_at: bookmark.deleted_at } : {}),
      client_id: clientId,
    };
  }
  return {
    id: bookmark.id,
    created_at: bookmark.created_at,
    content_type: 'text',
    title: bookmark.title ?? undefined,
    notes: bookmark.notes ?? undefined,
    shared_text: bookmark.description ?? undefined,
    ...(bookmark.deleted_at ? { deleted_at: bookmark.deleted_at } : {}),
    client_id: clientId,
  };
}

/**
 * Whether a rebuilt create payload has something the server will accept. An
 * explicit text payload can be bodyless after backup restore; its title,
 * notes, tags, or collection can still carry the user's content. An image
 * payload is always uploadable regardless of whether
 * `preview_image_url` is set yet — `syncQueueEntry` uploads the binary (from
 * the live bookmark's `local_image_uri`) before ever sending this payload, so
 * the payload snapshot alone can't tell "needs upload" apart from "already
 * uploaded," and doesn't need to.
 */
export function isUploadableCreate(payload: CreateBookmarkInput): boolean {
  return Boolean(
    payload.url ||
      payload.shared_text?.trim() ||
      payload.content_type === 'image' ||
      payload.content_type === 'text',
  );
}
