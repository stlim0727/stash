import type { Bookmark } from '@/domain/types';

/**
 * Inbox sort order. The list is sorted client-side over the local snapshot, so
 * this is pure and composes with search + facet filtering.
 */
export type SortField = 'date' | 'name';
export type SortDir = 'asc' | 'desc';

export interface SortOption {
  field: SortField;
  dir: SortDir;
}

/** Newest-first — preserves the historical default Inbox order. */
export const DEFAULT_SORT: SortOption = { field: 'date', dir: 'desc' };

/** Persistence key for the user's chosen order (repository meta store). */
export const INBOX_SORT_PREF_KEY = 'pref.inbox.sort';

function sortName(bookmark: Bookmark): string {
  return (bookmark.title ?? bookmark.url ?? '').trim().toLocaleLowerCase();
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
  if ((field === 'date' || field === 'name') && (dir === 'asc' || dir === 'desc')) {
    return { field, dir };
  }
  return DEFAULT_SORT;
}
