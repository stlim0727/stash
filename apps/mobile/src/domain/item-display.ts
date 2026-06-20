import type { Bookmark } from '@/domain/types';

/**
 * The best human label for a bookmark in lists and headers: the user-authored
 * title, then the URL, then — for a URL-less text note (e.g. a KakaoTalk message
 * with no link) — the saved text itself. Returns null when there is genuinely
 * nothing to show so callers can supply a localized "Untitled".
 *
 * Pure and dependency-free so it is unit-testable; the i18n fallback stays in
 * the calling screen.
 */
export function displayTitle(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'description'>,
): string | null {
  const title = bookmark.title?.trim();
  if (title) {
    return title;
  }
  if (bookmark.url) {
    return bookmark.url;
  }
  const description = bookmark.description?.trim();
  return description || null;
}
