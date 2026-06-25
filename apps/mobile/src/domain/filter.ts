import type { Bookmark } from '@/domain/types';

/**
 * A browse facet applied to the Inbox: show everything, only uncollected
 * items, one collection, or one tag. Tag/collection IDs come from the local
 * snapshot refreshed by pull sync (see store/bookmarks).
 */
export type InboxFilter =
  | { kind: 'all' }
  | { kind: 'uncollected' }
  | { kind: 'collection'; id: string }
  | { kind: 'tag'; id: string };

export const ALL_FILTER: InboxFilter = { kind: 'all' };
export const UNCOLLECTED_FILTER: InboxFilter = { kind: 'uncollected' };

/** Whether two filters select the same facet (used for chip highlighting). */
export function sameFilter(a: InboxFilter, b: InboxFilter): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'collection' && b.kind === 'collection') {
    return a.id === b.id;
  }
  if (a.kind === 'tag' && b.kind === 'tag') {
    return a.id === b.id;
  }
  return true;
}

export function bookmarkMatchesFilter(
  bookmark: Bookmark,
  filter: InboxFilter,
  tagIdsForBookmark: (bookmarkId: string) => string[],
): boolean {
  switch (filter.kind) {
    case 'all':
      return true;
    case 'uncollected':
      return bookmark.collection_id === null;
    case 'collection':
      return bookmark.collection_id === filter.id;
    case 'tag':
      return tagIdsForBookmark(bookmark.id).includes(filter.id);
  }
}

/**
 * Narrow a list of bookmarks to those matching the active facet. Composes
 * with text search (apply either order — both are pure predicates).
 */
export function filterByFacet(
  bookmarks: Bookmark[],
  filter: InboxFilter,
  tagIdsForBookmark: (bookmarkId: string) => string[],
): Bookmark[] {
  if (filter.kind === 'all') {
    return bookmarks;
  }
  return bookmarks.filter((bookmark) =>
    bookmarkMatchesFilter(bookmark, filter, tagIdsForBookmark),
  );
}
