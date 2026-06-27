/**
 * Tag aggregation — count how many bookmarks in a set carry each tag, the input
 * the browse-by-tag cloud/list ranks with. Pure and platform-free: it takes the
 * bookmark ids and a tag accessor, never the Bookmark/Tag row shapes or the
 * store, so the counting is unit-tested without React and stays decoupled from
 * the cloud-vs-mock fallback that lives in the store's tag index.
 *
 * Aggregation ONLY — no trimming, blank-dropping, or ranking. Those are
 * `buildTagCloud`'s job (`tag-cloud.ts`); duplicating them here would create two
 * places that can disagree. The result feeds straight into `buildTagCloud`.
 */
import type { TagCount } from './tag-cloud.ts';

/** The minimal tag shape the counter needs — id to key by, name to carry. */
export interface CountableTag {
  id: string;
  name: string;
}

/**
 * Count tag occurrences across `bookmarkIds`. Each bookmark contributes at most
 * one to a tag's count even if its own tag list repeats an id (a partial sync
 * could), so the count is "how many bookmarks carry this tag", not "how many
 * links exist". The name is taken from the first occurrence; bookmarks with no
 * tags (accessor returns `[]`) contribute nothing. `getTags` is expected to be
 * an O(1) in-memory lookup (the store precomputes a bookmarkId→tags map), so
 * the whole pass is O(bookmarks + tag-links).
 */
export function countTagsForBookmarks(
  bookmarkIds: readonly string[],
  getTags: (bookmarkId: string) => readonly CountableTag[],
): TagCount[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const bookmarkId of bookmarkIds) {
    const tags = getTags(bookmarkId);
    if (tags.length === 0) {
      continue;
    }
    // Per-bookmark de-dupe: a repeated tag id on one bookmark counts once.
    const seen = new Set<string>();
    for (const tag of tags) {
      if (seen.has(tag.id)) {
        continue;
      }
      seen.add(tag.id);
      const existing = counts.get(tag.id);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(tag.id, { name: tag.name, count: 1 });
      }
    }
  }
  return [...counts.entries()].map(([id, { name, count }]) => ({ id, name, count }));
}
