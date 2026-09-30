/**
 * Match an AI-suggested collection NAME to one the user already has, tolerant of
 * case, spacing, and punctuation. This mirrors the edge function's matcher
 * (`supabase/functions/ai-enrich/collection-match.ts`) so the client reaches the
 * same verdict the server did — and so a collection the user created *after* an
 * enrichment ran (e.g. "watch-later") still resolves an earlier suggestion
 * ("Watch Later") to "file into" instead of offering a duplicate "create".
 *
 * The two copies are kept deliberately identical (the runtimes — Deno vs. React
 * Native — can't share a module); `collection-match.test.ts` pins the behavior
 * on both sides.
 */

/**
 * Fold a collection name to a comparison key that ignores case, surrounding
 * whitespace, and punctuation/spacing differences — so "Watch Later",
 * "watch-later", and "watchlater" all share a key. NFKC first so width/
 * compatibility variants compare equal. Returns '' for a name with no letters
 * or digits (which never matches a real collection).
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
