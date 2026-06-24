/**
 * Local-first tagging engine (pure). Tag add/remove is applied to local state
 * immediately and recorded as a pending operation that the sync service uploads
 * later — so tagging a synced bookmark works instantly and offline, and a failed
 * upload is just a retry, never lost work.
 *
 * A pending "add" creates an optimistic local tag (`local-tag-<slug>` id) and a
 * link; when it syncs, `reconcileSyncedAdd` swaps the local id for the server's.
 * Pull replaces the server snapshot wholesale, so `applyPendingTagOps` re-layers
 * the not-yet-synced ops on top of it.
 *
 * Dependency-light so it is unit-tested under the Node runner.
 */

import type { BookmarkTag, Tag, TagSource } from '@/domain/types';
import type { TagData } from '@/storage/types';
import { normalizeTag, tagSlug } from '@/domain/tag-input';

export interface PendingTagOp {
  /** Local op id (for dedupe/cancellation bookkeeping). */
  id: string;
  bookmark_id: string;
  tag_name: string;
  op: 'add' | 'remove';
  source: TagSource;
  confidence: number | null;
  created_at: string;
}

function localTagId(name: string): string {
  return `local-tag-${tagSlug(name)}`;
}

/** Find a tag matching `name` by slug or case-insensitive name. */
function findTag(tags: Tag[], name: string): Tag | undefined {
  const slug = tagSlug(name);
  const key = normalizeTag(name);
  return tags.find((tag) => tag.slug === slug || normalizeTag(tag.name) === key);
}

/** Apply a single op to a snapshot, returning a new snapshot. */
export function applyTagOp(data: TagData, op: PendingTagOp, userId: string): TagData {
  if (op.op === 'add') {
    let tags = data.tags;
    let tag = findTag(tags, op.tag_name);
    if (!tag) {
      tag = {
        id: localTagId(op.tag_name),
        user_id: userId,
        name: op.tag_name.trim(),
        slug: tagSlug(op.tag_name),
        source: op.source,
        created_at: op.created_at,
      };
      tags = [...tags, tag];
    }
    const linked = data.bookmarkTags.some(
      (link) => link.bookmark_id === op.bookmark_id && link.tag_id === tag!.id,
    );
    const bookmarkTags = linked
      ? data.bookmarkTags
      : [
          ...data.bookmarkTags,
          {
            bookmark_id: op.bookmark_id,
            tag_id: tag.id,
            source: op.source,
            confidence: op.confidence,
            created_at: op.created_at,
          } satisfies BookmarkTag,
        ];
    return { ...data, tags, bookmarkTags };
  }

  // remove: drop links from this bookmark to any tag matching the name.
  const slug = tagSlug(op.tag_name);
  const key = normalizeTag(op.tag_name);
  const removableTagIds = new Set(
    data.tags.filter((tag) => tag.slug === slug || normalizeTag(tag.name) === key).map((tag) => tag.id),
  );
  const bookmarkTags = data.bookmarkTags.filter(
    (link) => !(link.bookmark_id === op.bookmark_id && removableTagIds.has(link.tag_id)),
  );
  return { ...data, bookmarkTags };
}

/** Re-layer all pending ops on top of a (server) snapshot, in order. */
export function applyPendingTagOps(
  data: TagData,
  ops: PendingTagOp[],
  userId: string,
): TagData {
  return ops.reduce((acc, op) => applyTagOp(acc, op, userId), data);
}

/**
 * Add an op to the queue. Opposite ops for the same (bookmark, tag) cancel out;
 * a repeat of the same op de-dupes. Keeps the queue minimal and correct.
 */
export function enqueueTagOp(ops: PendingTagOp[], next: PendingTagOp): PendingTagOp[] {
  const slug = tagSlug(next.tag_name);
  const sameTarget = (op: PendingTagOp) =>
    op.bookmark_id === next.bookmark_id && tagSlug(op.tag_name) === slug;
  const existing = ops.find(sameTarget);
  const rest = ops.filter((op) => !sameTarget(op));
  if (existing && existing.op !== next.op) {
    // add↔remove cancel: the earlier op never synced, so we're back to baseline.
    return rest;
  }
  return [...rest, next];
}

/** Drop the op(s) for a (bookmark, tag) target — used after a successful sync. */
export function dequeueTagOp(
  ops: PendingTagOp[],
  bookmarkId: string,
  tagName: string,
): PendingTagOp[] {
  const slug = tagSlug(tagName);
  return ops.filter(
    (op) => !(op.bookmark_id === bookmarkId && tagSlug(op.tag_name) === slug),
  );
}

/**
 * Re-key pending tag ops from old bookmark ids to new ones. Used on account
 * carry-over (anonymous → real): re-homing a bookmark swaps it to a fresh
 * `local-*` id, so any tag ops still keyed by the OLD id would fire `addTags`
 * against an id that no longer exists in the new account and be orphaned.
 * Ops whose `bookmark_id` isn't in `idMap` pass through unchanged.
 */
export function rekeyPendingTagOps(
  ops: PendingTagOp[],
  idMap: Map<string, string>,
): PendingTagOp[] {
  if (idMap.size === 0) {
    return ops;
  }
  return ops.map((op) => {
    const newId = idMap.get(op.bookmark_id);
    return newId ? { ...op, bookmark_id: newId } : op;
  });
}

/**
 * Drop every pending tag op targeting one of `bookmarkIds`. Used on a real
 * A→real B account switch: account A's queued tag ops must not survive into
 * account B's session, where `syncTagOps` would upload them under B's auth.
 */
export function dropPendingTagOpsForBookmarks(
  ops: PendingTagOp[],
  bookmarkIds: string[],
): PendingTagOp[] {
  if (bookmarkIds.length === 0) {
    return ops;
  }
  const drop = new Set(bookmarkIds);
  return ops.filter((op) => !drop.has(op.bookmark_id));
}

/**
 * After the server confirms an added tag, swap the optimistic local tag id for
 * the server tag (and its id on every link), and ensure the server tag is
 * present. Idempotent.
 */
export function reconcileSyncedAdd(data: TagData, tagName: string, serverTag: Tag): TagData {
  const local = findTag(data.tags, tagName);
  let tags = data.tags;
  let bookmarkTags = data.bookmarkTags;

  if (local && local.id !== serverTag.id) {
    tags = data.tags.map((tag) => (tag.id === local.id ? serverTag : tag));
    bookmarkTags = data.bookmarkTags.map((link) =>
      link.tag_id === local.id ? { ...link, tag_id: serverTag.id } : link,
    );
  }
  if (!tags.some((tag) => tag.id === serverTag.id)) {
    tags = [...tags, serverTag];
  }
  // De-dupe tags by id (the swap can collide with an already-present server tag).
  const seen = new Set<string>();
  tags = tags.filter((tag) => (seen.has(tag.id) ? false : (seen.add(tag.id), true)));
  // De-dupe links too.
  const linkSeen = new Set<string>();
  bookmarkTags = bookmarkTags.filter((link) => {
    const linkKey = `${link.bookmark_id}:${link.tag_id}`;
    return linkSeen.has(linkKey) ? false : (linkSeen.add(linkKey), true);
  });

  return { ...data, tags, bookmarkTags };
}
