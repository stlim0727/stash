/**
 * Tag cloud layout — turns the tags present in the Inbox into a frequency-ranked
 * list whose entries each carry a normalized `weight` (0..1) the UI maps to a
 * font size. Pure and platform-free so the sizing is unit-tested without React.
 */

/** A tag plus how many bookmarks carry it. */
export interface TagCount {
  id: string;
  name: string;
  count: number;
}

/** A cloud entry: the tag, its count, and a 0..1 weight for sizing. */
export interface TagCloudEntry {
  id: string;
  name: string;
  count: number;
  /** 0 = least-used tag in the set, 1 = most-used. Ties/singletons get 1. */
  weight: number;
}

/** Smallest tag pill font (the least-used tag). */
export const TAG_CLOUD_MIN_FONT = 14;
/** Largest tag pill font (the most-used tag). */
export const TAG_CLOUD_MAX_FONT = 34;

/**
 * Build the cloud: drop blank-named tags, sort by frequency (desc) then name
 * (asc) so the heaviest tags lead and ties stay alphabetical, and normalize
 * each count to a 0..1 weight against the busiest tag. When every tag has the
 * same count there's nothing to rank, so they all weigh 1 (largest).
 */
export function buildTagCloud(tags: TagCount[]): TagCloudEntry[] {
  const named = tags
    .map((tag) => ({ ...tag, name: tag.name.trim() }))
    .filter((tag) => tag.name.length > 0 && tag.count > 0);
  if (named.length === 0) {
    return [];
  }
  const counts = named.map((tag) => tag.count);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const span = max - min;
  return named
    .map((tag) => ({
      id: tag.id,
      name: tag.name,
      count: tag.count,
      weight: span === 0 ? 1 : (tag.count - min) / span,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Map a 0..1 cloud weight to a pixel font size between the min/max bounds. */
export function tagCloudFontSize(weight: number): number {
  const clamped = Math.min(1, Math.max(0, weight));
  return Math.round(TAG_CLOUD_MIN_FONT + (TAG_CLOUD_MAX_FONT - TAG_CLOUD_MIN_FONT) * clamped);
}
