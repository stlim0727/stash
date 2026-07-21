import { hostFromUrl } from '@/domain/item-icon';
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

/**
 * Whether the label {@link displayTitle} renders is a fallback rather than a
 * real title: either `title_is_derived` was recorded locally (enrichment ran
 * and only found a generated title), or there is no usable title at all and
 * `displayTitle` is rendering the raw URL. Remote-mapped and pre-migration
 * rows never carry `title_is_derived`, so the URL-fallback check catches
 * those too. Callers use this to de-emphasize fallback titles in the UI.
 */
export function isTitleDerived(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'title_is_derived'>,
): boolean {
  if (bookmark.title_is_derived) {
    return true;
  }
  return !bookmark.title?.trim() && Boolean(bookmark.url);
}

/**
 * A screen-reader-friendly label for a bookmark. Unlike {@link displayTitle},
 * which falls back to the raw URL (so VoiceOver spells out the entire link) or
 * the full note body, this prefers a bare hostname for URL bookmarks and a
 * sensibly truncated form otherwise. Returns null when there is nothing to
 * announce so callers can supply a localized "Untitled".
 *
 * Pure and dependency-free (aside from the host parser) so it is unit-testable.
 */
export function accessibilityTitle(
  bookmark: Pick<Bookmark, 'title' | 'url' | 'description'>,
): string | null {
  const title = bookmark.title?.trim();
  if (title) {
    return truncateForSpeech(title);
  }
  const host = hostFromUrl(bookmark.url);
  if (host) {
    return host;
  }
  if (bookmark.url) {
    return truncateForSpeech(bookmark.url);
  }
  const description = bookmark.description?.trim();
  return description ? truncateForSpeech(description) : null;
}

function truncateForSpeech(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `${trimmed.slice(0, 79).trimEnd()}…`;
}
