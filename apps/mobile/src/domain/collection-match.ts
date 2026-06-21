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
