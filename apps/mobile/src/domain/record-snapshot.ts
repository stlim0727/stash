/**
 * Return true when two ordered snapshots contain the same JSON-shaped rows.
 *
 * Repository reads necessarily allocate fresh objects. Feeding an unchanged
 * read straight back into React state still invalidates every consumer by
 * reference, which is particularly expensive for the Inbox's virtualized
 * library. This comparison is deliberately conservative: a serialization or
 * key-order difference returns false (an extra render), while true means every
 * persisted field and row position is identical.
 */
export function sameRecordSnapshot<T>(current: readonly T[], next: readonly T[]): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  return current.every((row, index) => JSON.stringify(row) === JSON.stringify(next[index]));
}
