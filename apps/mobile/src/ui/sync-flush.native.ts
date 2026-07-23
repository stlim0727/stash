/**
 * Native override of `sync-flush.ts`. Native has no browser gesture-timing
 * constraint to preserve, so this just runs `fn` — React Native's own
 * scheduler handles the rest.
 */
export function syncFlush(fn: () => void): void {
  fn();
}
