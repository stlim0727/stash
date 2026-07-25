/**
 * Deterministic color assignment for Folder View's collection tiles.
 * `Collection` (see `types.ts`) intentionally carries no color field — adding
 * one would mean a schema change and a place for a "generated" value to leak
 * into a user-owned row. Instead, a collection's `id` is hashed to pick one of
 * a small fixed set of *palette token keys* — never a raw hex value — so the
 * UI layer resolves the key against the real `usePalette()` tokens (see
 * `@/theme`) and light/dark mode just work with no extra logic here.
 *
 * `mutedSurface` is reserved exclusively for the uncollected/"받은함" tile and
 * is never produced by this hash.
 */

export type CollectionColorKey = 'accentSoft' | 'successSoft' | 'highlightSoft';

const COLLECTION_COLOR_KEYS: readonly CollectionColorKey[] = [
  'accentSoft',
  'successSoft',
  'highlightSoft',
];

/** Small, stable string hash (djb2 variant) — same input, same output, always. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

/** The same collection id always maps to the same color key. */
export function collectionColorKey(collectionId: string): CollectionColorKey {
  const index = hashString(collectionId) % COLLECTION_COLOR_KEYS.length;
  return COLLECTION_COLOR_KEYS[index];
}
