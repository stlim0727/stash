/**
 * Local-first tagging engine (pure). Tag add/remove is applied to local state
 * immediately and recorded as a pending operation that the sync service uploads
 * later — so tagging any captured bookmark works instantly and offline, and a failed
 * upload is just a retry, never lost work.
 *
 * A pending "add" creates an optimistic local tag (`local-tag-<slug>` id) and a
 * link; when it syncs, `reconcileSyncedAdd` swaps the local id for the server's.
 * Pull replaces the server snapshot wholesale, so `applyPendingTagOps` re-layers
 * the not-yet-synced ops on top of it.
 *
 * Dependency-light so it is unit-tested under the Node runner.
 */

import type { BookmarkTag, Tag, TagSource, SyncErrorKind } from '@/domain/types';
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
  /** Durable retry bookkeeping; absent on older persisted queues. */
  retry_count?: number;
  last_attempt_at?: string;
  last_error?: string;
  last_error_kind?: SyncErrorKind;
  health_escalated_at?: string;
  /** Acknowledged removal remains a tombstone until a pull confirms absence. */
  confirmed?: boolean;
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
 * Add an op to the queue. The latest intent replaces the previous intent for the same target.
 * Never cancel opposite edits: the earlier request may already be in flight
 * or have reached the server before a lost response.
 */
export function enqueueTagOp(ops: PendingTagOp[], next: PendingTagOp): PendingTagOp[] {
  const slug = tagSlug(next.tag_name);
  const sameTarget = (op: PendingTagOp) =>
    op.bookmark_id === next.bookmark_id && tagSlug(op.tag_name) === slug;
  const rest = ops.filter((op) => !sameTarget(op));
  return [...rest, next];
}

/** Drop the op(s) for a (bookmark, tag) target — used after a successful sync. */
export function dequeueTagOp(
  ops: PendingTagOp[],
  bookmarkId: string,
  tagName: string,
  confirmedOpId?: string,
): PendingTagOp[] {
  const slug = tagSlug(tagName);
  return ops.filter(
    (op) => !(op.bookmark_id === bookmarkId && tagSlug(op.tag_name) === slug &&
      (confirmedOpId === undefined || op.id === confirmedOpId)),
  );
}

/**
 * Re-key pending tag ops from old bookmark ids to new ones. Used on account
 * carry-over (anonymous → real): re-homing a bookmark swaps it to a fresh
 * UUID, so any tag ops still keyed by the OLD id would fire `addTags`
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
  }).reduce<PendingTagOp[]>((next, op) => enqueueTagOp(next, op), []);
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

/** Re-upload every carried association, including tags whose old upload completed. */
export function carryOverTagOps(
  ops: PendingTagOp[], data: TagData, idMap: Map<string, string>,
  makeId: () => string, now: string,
): PendingTagOp[] {
  // Use original ids when deciding which associations belong to this migration.
  let next = rekeyPendingTagOps(ops.map((op) => idMap.has(op.bookmark_id)
    ? { ...op, confirmed: false, retry_count: 0, last_attempt_at: undefined,
        last_error: undefined, last_error_kind: undefined, health_escalated_at: undefined }
    : op), idMap);
  for (const link of data.bookmarkTags) {
    const newId = idMap.get(link.bookmark_id);
    const tag = data.tags.find((candidate) => candidate.id === link.tag_id);
    if (!newId || !tag || next.some((op) => op.bookmark_id === newId &&
      tagSlug(op.tag_name) === tagSlug(tag.name))) continue;
    next = enqueueTagOp(next, { id: makeId(), bookmark_id: newId,
      tag_name: tag.name, op: 'add', source: link.source,
      confidence: link.confidence, created_at: now });
  }
  return next;
}

/** Retire removal tombstones only after an actual remote snapshot confirms absence. */
export function retireConfirmedTagRemovals(
  ops: PendingTagOp[], remote: TagData, snapshotReplaced: boolean,
): PendingTagOp[] {
  if (!snapshotReplaced) return ops;
  return ops.filter((op) => {
    if (!op.confirmed || op.op !== 'remove') return true;
    const matchingIds = new Set(remote.tags.filter((tag) =>
      tagSlug(tag.name) === tagSlug(op.tag_name)).map((tag) => tag.id));
    return remote.bookmarkTags.some((link) =>
      link.bookmark_id === op.bookmark_id && matchingIds.has(link.tag_id));
  });
}
