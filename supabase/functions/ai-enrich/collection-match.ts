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

/**
 * Find the existing collection an AI-suggested name refers to, tolerant of
 * case/spacing/punctuation. Returns the matched collection, or null when the
 * name is blank or nothing fits (the signal to propose creating it).
 */
export function matchSuggestedCollection(
  collections: readonly NamedCollection[],
  suggestedName: string | null | undefined,
): NamedCollection | null {
  const key = suggestedName ? collectionMatchKey(suggestedName) : '';
  if (!key) {
    return null;
  }
  return collections.find((collection) => collectionMatchKey(collection.name) === key) ?? null;
}
