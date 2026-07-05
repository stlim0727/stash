/**
 * Pure helpers behind the Library tab's "browse by collection" rows.
 *
 * `collectionFingerprints` mirrors the Inbox's `collectionCounts` grouping (see
 * `(tabs)/index.tsx`) but keeps a little more per-collection signal — when the
 * last item was added and the site most of its items share — so a row can carry
 * a *content fingerprint* built from REAL data only (never an inferred
 * content-type). `relativeTime` turns an ISO timestamp into a locale-agnostic
 * `{ unit, value }` bucket the screen maps to a translated "… ago" string.
 *
 * No i18n, no clock, no React — so both run in the Node test lane.
 */
import type { Bookmark } from '@/domain/types';

export interface CollectionFingerprint {
  /** How many active bookmarks the collection holds. */
  count: number;
  /** ISO `created_at` of the most recently added bookmark, or null if none. */
  lastAddedAt: string | null;
  /**
   * The `site_name` shared by the most bookmarks — surfaced only when at least
   * two share it, so it reads as a real pattern rather than one arbitrary site.
   */
  topSite: string | null;
}

/**
 * Group active bookmarks by `collection_id` into per-collection fingerprints.
 * Loose (uncollected) bookmarks are ignored — they belong to no collection row.
 * Callers pass the same active set the Inbox derives from (non-trashed,
 * non-archived), so the counts agree across tabs.
 */
export function collectionFingerprints(
  bookmarks: readonly Bookmark[],
): Map<string, CollectionFingerprint> {
  const acc = new Map<
    string,
    { count: number; lastAddedAt: string | null; sites: Map<string, number> }
  >();
  for (const bookmark of bookmarks) {
    const id = bookmark.collection_id;
    if (id === null) {
      continue;
    }
    let entry = acc.get(id);
    if (!entry) {
      entry = { count: 0, lastAddedAt: null, sites: new Map() };
      acc.set(id, entry);
    }
    entry.count += 1;
    // ISO 8601 UTC strings sort lexicographically in chronological order, so a
    // plain string compare finds the most recent save without parsing dates.
    if (entry.lastAddedAt === null || bookmark.created_at > entry.lastAddedAt) {
      entry.lastAddedAt = bookmark.created_at;
    }
    const site = bookmark.site_name?.trim();
    if (site) {
      entry.sites.set(site, (entry.sites.get(site) ?? 0) + 1);
    }
  }

  const result = new Map<string, CollectionFingerprint>();
  for (const [id, entry] of acc) {
    // Require ≥2 so `topSite` marks a genuine repeat, not a lone item's site.
    let topSite: string | null = null;
    let topCount = 1;
    for (const [site, n] of entry.sites) {
      if (n > topCount) {
        topCount = n;
        topSite = site;
      }
    }
    result.set(id, { count: entry.count, lastAddedAt: entry.lastAddedAt, topSite });
  }
  return result;
}

export type RelativeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

export interface RelativeTime {
  unit: RelativeUnit;
  /** How many of `unit` ago (0 for `now`). */
  value: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Coarse calendar buckets: a "month" is 30 days and a "year" 365 for labelling
// purposes only — the Library subtitle wants a human sense of age, not an exact
// calendar diff.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Bucket the gap between `iso` and `nowMs` into the coarsest sensible unit.
 * A future or sub-minute timestamp reads as `now`; everything else floors to
 * whole minutes/hours/days/weeks/months/years.
 */
export function relativeTime(iso: string, nowMs: number): RelativeTime {
  const diff = Math.max(0, nowMs - new Date(iso).getTime());
  if (diff < MINUTE) {
    return { unit: 'now', value: 0 };
  }
  if (diff < HOUR) {
    return { unit: 'minutes', value: Math.floor(diff / MINUTE) };
  }
  if (diff < DAY) {
    return { unit: 'hours', value: Math.floor(diff / HOUR) };
  }
  if (diff < WEEK) {
    return { unit: 'days', value: Math.floor(diff / DAY) };
  }
  if (diff < MONTH) {
    return { unit: 'weeks', value: Math.floor(diff / WEEK) };
  }
  if (diff < YEAR) {
    return { unit: 'months', value: Math.floor(diff / MONTH) };
  }
  return { unit: 'years', value: Math.floor(diff / YEAR) };
}
