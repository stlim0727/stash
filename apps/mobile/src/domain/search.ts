import { collectionMatchKey } from '@/domain/collection-match';
import type { Bookmark } from '@/domain/types';

/**
 * Optional resolvers that pull fields not stored on the `Bookmark` row itself —
 * tag names and the parent collection name — from the store. Kept as callbacks
 * so `filterBookmarks` stays a pure domain function (no store import). Both are
 * optional, so callers without tag/collection context still compile.
 */
export interface SearchResolvers {
  tagNames?: (bookmark: Bookmark) => string[];
  collectionName?: (bookmark: Bookmark) => string | null | undefined;
}

/**
 * Normalize a single token to the same key `collectionMatchKey` uses: NFKC +
 * lowercase + strip everything that isn't a letter or digit. This absorbs case,
 * punctuation, spacing, width, and accent differences so a "대충" query still
 * matches (e.g. "watch later" -> ["watch","later"] both substring "watchlater").
 *
 * We normalize PER TOKEN and re-join the haystack with spaces (rather than
 * stripping non-alphanumerics from the whole string at once) on purpose:
 * collapsing the entire haystack would fuse adjacent words ("local manager" ->
 * "localmanager"), creating cross-word false-positive substring matches. Keeping
 * a separator between tokens preserves the existing word-boundary semantics so
 * "local manager" still returns 0 results, while punctuation inside a single
 * token ("watch-later") is still folded away.
 */
function normalizeToken(token: string): string {
  return collectionMatchKey(token);
}

function normalizeHaystack(value: string): string {
  return value
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ');
}

/**
 * Case-insensitive, punctuation-tolerant client-side search over the fields a
 * user remembers a bookmark by — title/description/notes/url/site_name plus
 * (when resolvers are supplied) tag names and the parent collection name.
 * Whitespace-separated query terms must all match (AND), each against any field.
 */
export function filterBookmarks(
  bookmarks: Bookmark[],
  query: string,
  resolvers?: SearchResolvers,
): Bookmark[] {
  const terms = query
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  if (terms.length === 0) {
    return bookmarks;
  }

  // A single-token (no-whitespace) query may additionally match a value whose
  // words have had their separators removed, so a user who types what they SEE
  // on screen WITHOUT spaces ("watchlater") still finds a stored "Watch Later".
  // This makes the punctuation tolerance bidirectional, but it is deliberately
  // limited two ways:
  //   - Single-token queries only. Collapsing for a MULTI-token query would fuse
  //     adjacent words and reintroduce cross-word false positives ("local
  //     manager" must stay 0).
  //   - LABEL fields only (title, site_name, tag names, collection name) — NOT
  //     prose (notes, description). Users type compact, no-space text for the
  //     short LABELS they see on screen; they don't do that for memo bodies, so
  //     collapsing prose would create unnatural cross-word hits (a "syncdesign"
  //     query matching a "sync design" note). Prose is matched with the normal
  //     space-separated haystack only.
  // Normalization (NFKC + lowercase + per-token punctuation strip, space kept as
  // the token separator) is identical for both groups; only the collapse
  // fallback differs.
  const collapsedQuery = terms.length === 1 ? terms[0] : null;

  return bookmarks.filter((bookmark) => {
    const labelFields: Array<string | null | undefined> = [
      bookmark.title,
      bookmark.site_name,
      ...(resolvers?.tagNames?.(bookmark) ?? []),
      resolvers?.collectionName?.(bookmark),
    ];
    const proseFields: Array<string | null | undefined> = [
      bookmark.description,
      bookmark.notes,
      bookmark.url,
    ];

    const normalizedLabels = labelFields
      .filter((value): value is string => Boolean(value))
      .map(normalizeHaystack)
      .filter(Boolean);
    const normalizedProse = proseFields
      .filter((value): value is string => Boolean(value))
      .map(normalizeHaystack)
      .filter(Boolean);

    const haystack = [...normalizedLabels, ...normalizedProse].join(' ');
    if (terms.every((term) => haystack.includes(term))) {
      return true;
    }
    if (collapsedQuery !== null) {
      // Collapse separators within a single LABEL field (not across fields, not
      // prose) and retry the single term.
      return normalizedLabels.some((field) =>
        field.replace(/ /g, '').includes(collapsedQuery),
      );
    }
    return false;
  });
}
