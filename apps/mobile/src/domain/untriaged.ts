import type { Bookmark } from './types';

/**
 * The Inbox's "un-triaged" count: active bookmarks not yet filed into a
 * collection. This is the exact rule the Inbox's "No collection" browse facet
 * counts with (see the `uncollected` tally in `(tabs)/index.tsx`) — active
 * bookmarks whose `collection_id` is null — factored out so the neutral Inbox
 * tab badge can reuse the same definition instead of inventing a new one.
 *
 * Callers pass the store's `inbox` (already the active, non-trashed/
 * non-archived set), so this is purely the "no collection yet" filter. The
 * count can reach zero once everything is filed — the badge hides at zero, per
 * the "no debt number" design bet.
 */
export function countUntriaged(bookmarks: Bookmark[]): number {
  return bookmarks.reduce((total, bookmark) => (bookmark.collection_id === null ? total + 1 : total), 0);
}
