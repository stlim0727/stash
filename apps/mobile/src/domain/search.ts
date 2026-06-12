import type { Bookmark } from '@/domain/types';

/**
 * Case-insensitive client-side search over the fields a user remembers a
 * bookmark by. Whitespace-separated terms must all match (AND), each against
 * any field.
 */
export function filterBookmarks(bookmarks: Bookmark[], query: string): Bookmark[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return bookmarks;
  }

  return bookmarks.filter((bookmark) => {
    const haystack = [bookmark.title, bookmark.description, bookmark.notes, bookmark.url]
      .filter(Boolean)
      .join('\n')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
