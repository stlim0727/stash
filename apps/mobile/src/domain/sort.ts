import type { Bookmark } from '@/domain/types';

/**
 * Inbox sort order. The list is sorted client-side over the local snapshot, so
 * this is pure and composes with search + facet filtering.
 */
export type SortField = 'date' | 'accessed' | 'name';
export type SortDir = 'asc' | 'desc';

export interface SortOption {
  field: SortField;
  dir: SortDir;
}

/** Newest-first — preserves the historical default Inbox order. */
export const DEFAULT_SORT: SortOption = { field: 'date', dir: 'desc' };

/**
 * The orders the user can pick from, in menu order. Each is phrased as a whole
 * "what you get" choice (Newest / Recently opened / Name A–Z …) rather than a
 * field + an abstract asc/desc toggle, which testers found confusing.
 */
export const SORT_PRESETS: SortOption[] = [
  { field: 'date', dir: 'desc' }, // Newest (added)
  { field: 'date', dir: 'asc' }, // Oldest (added)
  { field: 'accessed', dir: 'desc' }, // Recently opened
  { field: 'accessed', dir: 'asc' }, // Least recently opened
  { field: 'name', dir: 'asc' }, // Name A–Z
  { field: 'name', dir: 'desc' }, // Name Z–A
];

/** Persistence key for the user's chosen order (repository meta store). */
export const INBOX_SORT_PREF_KEY = 'pref.inbox.sort';

export function sameSort(a: SortOption, b: SortOption): boolean {
  return a.field === b.field && a.dir === b.dir;
}

function sortName(bookmark: Bookmark): string {
  return (bookmark.title ?? bookmark.url ?? '').trim().toLocaleLowerCase();
}

/**
 * The key for "last opened" ordering. A bookmark that has never been opened has
 * no access time, so fall back to when it was saved — its only "activity" so
 * far — instead of sinking every untouched item into one undifferentiated block.
 */
function accessedKey(bookmark: Bookmark): string {
  return bookmark.last_accessed_at ?? bookmark.created_at;
}

/**
 * Return a new array sorted by the given option. Ties break by newest-first
 * then id, so the order is stable and deterministic regardless of input order.
 */
export function sortBookmarks(bookmarks: Bookmark[], option: SortOption): Bookmark[] {
  const sign = option.dir === 'asc' ? 1 : -1;
  return [...bookmarks].sort((a, b) => {
    const primary =
      option.field === 'name'
        ? sortName(a).localeCompare(sortName(b), undefined, { numeric: true, sensitivity: 'base' })
        : option.field === 'accessed'
          ? accessedKey(a).localeCompare(accessedKey(b))
          : a.created_at.localeCompare(b.created_at);
    if (primary !== 0) {
      return sign * primary;
    }
    const byDate = b.created_at.localeCompare(a.created_at);
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });
}

/** Short human label for the active order (used in the sort control + a11y). */
export function describeSort(option: SortOption): string {
  if (option.field === 'date') {
    return option.dir === 'desc' ? 'Newest' : 'Oldest';
  }
  if (option.field === 'accessed') {
    return option.dir === 'desc' ? 'Recently opened' : 'Least recently opened';
  }
  return option.dir === 'asc' ? 'Name A–Z' : 'Name Z–A';
}

/** Compact, forward-compatible serialization for persistence. */
export function serializeSort(option: SortOption): string {
  return `${option.field}:${option.dir}`;
}

export function parseSort(raw: string | null | undefined): SortOption {
  if (!raw) {
    return DEFAULT_SORT;
  }
  const [field, dir] = raw.split(':');
  if (
    (field === 'date' || field === 'accessed' || field === 'name') &&
    (dir === 'asc' || dir === 'desc')
  ) {
    return { field, dir };
  }
  return DEFAULT_SORT;
}
