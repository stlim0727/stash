// Resolve a provider's suggested collection NAME hint to one of the user's
// existing collections — or report that none fit so the caller can offer to
// create it. Kept pure and dependency-free (no Deno/Node APIs) so it is
// unit-testable under the Node `test:functions` lane and imported unchanged by
// the Deno edge function.

export interface NamedCollection {
  id: string;
  name: string;
}

/**
 * Fold a collection name to a comparison key that ignores case, surrounding
 * whitespace, and punctuation/spacing differences — so "Watch Later",
 * "watch-later", and "watchlater" all match. NFKC first so width/compatibility
 * variants of the same characters compare equal. Returns '' for a name with no
 * letters or digits (which never matches a real collection).
 */
export function collectionMatchKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export const GENERIC_COLLECTION_KEYS = new Set([
  'article',
  'articles',
  'blog',
  'bookmark',
  'bookmarks',
  'link',
  'links',
  'media',
  'readlater',
  'reading',
  'saved',
  'toread',
  'towatch',
  'video',
  'videos',
  'watchlist',
  'watchlater',
  '나중에보기',
  '동영상',
  '미디어',
  '북마크',
  '비디오',
  '아티클',
  '읽을거리',
  '저장',
  '콘텐츠',
]);

/**
 * Returns true if the collection name describes a generic holding bucket or media
 * format (such as "Watch Later", "Bookmarks", "나중에 보기", "Saved", "Articles")
 * rather than a specific topical theme.
 *
 * Triage moves out of generic holding buckets into substantive topical folders
 * are supported; moves out of already-established topical folders (e.g.
 * 'Food' -> '음식 및 요리' or '요리 레시피' -> '음식 및 요리') are unconvincing
 * lateral churn and suppressed (STASH-74, STASH-78).
 */
export function isGenericCollection(name: string | null | undefined): boolean {
  if (!name) return false;
  return GENERIC_COLLECTION_KEYS.has(collectionMatchKey(name));
}

/**
 * Find the existing collection an AI-suggested name refers to, tolerant of
 * case/spacing/punctuation. Returns the matched collection, or null when the
 * name is blank or nothing fits (the signal to propose creating it).
 *
 * When `incumbentCollectionId` is provided and that collection's name matches
 * the suggested name key, it is preferred over other duplicate-named collections
 * to avoid bogus same-name moves (e.g. Food -> Food).
 */
export function matchSuggestedCollection(
  collections: readonly NamedCollection[],
  suggestedName: string | null | undefined,
  incumbentCollectionId?: string | null,
): NamedCollection | null {
  const key = suggestedName ? collectionMatchKey(suggestedName) : '';
  if (!key) {
    return null;
  }
  if (incumbentCollectionId) {
    const incumbent = collections.find((col) => col.id === incumbentCollectionId);
    if (incumbent && collectionMatchKey(incumbent.name) === key) {
      return incumbent;
    }
  }
  return collections.find((collection) => collectionMatchKey(collection.name) === key) ?? null;
}
