/**
 * Follows an id-alias chain to its end. The store re-keys a bookmark to a new
 * id when an anonymous account's rows are carried over to a real account
 * (see `account-transition.ts`), recording `old → new` in an alias map. A
 * background task (e.g. metadata enrichment) started under the old id must
 * still find the row after the rehome, so it resolves the CURRENT id here
 * before writing — otherwise its result is applied to a dead id and dropped,
 * stranding the row.
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
