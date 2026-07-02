import type { Bookmark } from '@/domain/types';

/**
 * Applies a local→remote id swap to the in-memory bookmark list, collapsing any
 * row already present under the destination id.
 *
 * The store renames a bookmark from its device-local id (`local-…`) to the
 * Supabase UUID once its `create` syncs, and again when a synced-leftover is
 * reconciled on a later launch (planLeftoverReconciliation). The naive
 * `list.map(b => (b.id === fromId ? next : b))` those sites used leaves TWO
 * array entries sharing one id whenever the remote twin had ALREADY been pulled
 * into memory separately: the pull inserts the UUID row, then the swap renames
 * the lingering `local-…` row onto that same UUID. The result is a visible
 * duplicate in the Inbox — two cards with identical content and tags, because
 * both entries resolve to the same bookmark id.
 *
 * Storage only ever holds a single row for it (the swap persists via
 * `repository.replaceBookmark`, which upserts the destination id), so the
 * duplicate is purely an in-memory artifact and disappears on the next cold
 * start when state is rebuilt from storage — exactly the reported symptom.
 *
 * Collapsing onto the destination id makes the swap idempotent against an
 * already-present twin: the renamed row replaces it instead of joining it.
 * Preserves the old `.map` semantics when `fromId` is absent (returns the list
 * unchanged) so a swap that already happened is a no-op rather than resurrecting
 * a stale row.
 */
export function swapBookmarkId(
  list: Bookmark[],
  fromId: string,
  replacement: Bookmark,
): Bookmark[] {
  const toId = replacement.id;
  let swapped = false;
  const result: Bookmark[] = [];
  for (const bookmark of list) {
    if (bookmark.id === fromId) {
      // Place the replacement once, in the original row's position.
      if (!swapped) {
        result.push(replacement);
        swapped = true;
      }
      continue;
    }
    // Drop a pre-existing row already under the destination id (the remote twin
    // a pull inserted) so the swap can't produce two entries with the same id.
    if (toId !== fromId && bookmark.id === toId) {
      continue;
    }
    result.push(bookmark);
  }
  // `fromId` was not found: the swap already happened (or the row is gone).
  // Leave the list untouched — re-adding `replacement` would resurrect a row,
  // and we only collapse a destination twin as part of an actual swap.
  return swapped ? result : list;
}

/**
 * Follows an id-alias chain to its end. The store re-keys a bookmark from its
 * device-local id (`local-…`) to the Supabase UUID when its `create` syncs,
 * recording `local → remote` in an alias map. A background task (e.g. metadata
 * enrichment) started under the old id must still find the row after the swap,
 * so it resolves the CURRENT id here before writing — otherwise its result is
 * applied to a dead id and dropped, stranding the row.
 *
 * Reads the alias map (never the bookmarks list), which the store updates
 * synchronously at the swap, so it can't return a stale id even while the list
 * ref lags a render behind. Cycle-safe: a chain that loops back stops at the
 * first repeat and returns the last unique id.
 */
export function resolveAliasedId(startId: string, aliases: Map<string, string>): string {
  let currentId = startId;
  const seen = new Set<string>([currentId]);
  let next = aliases.get(currentId);
  while (next && !seen.has(next)) {
    currentId = next;
    seen.add(next);
    next = aliases.get(next);
  }
  return currentId;
}
