/**
 * Web-only collapsing-header state (see `app/index.tsx`). Replaces an
 * accumulated `Animated.diffClamp` value — which requires an explicit reset on
 * every discontinuity (a FlatList remount, a missed frame) and has twice left
 * the header stuck at a stale collapsed value (Sentry STASH-2B, STASH-2G) —
 * with a plain boolean derived fresh from the current scroll offset on every
 * tick. There is no running state to go stale: even if an update is missed,
 * the next scroll event (or the very next render) recomputes correctly from
 * wherever the list actually is.
 *
 * Two thresholds (not one) give a hysteresis band so the boundary doesn't
 * flicker between collapsed/expanded on small scroll jitter right at the
 * threshold.
 *
 * Pure — no React, no Animated — so the Node test lane can exercise it
 * directly.
 */

const HYSTERESIS_BAND = 24;

/**
 * Given the current collapsed state and the list's live scroll offset,
 * decide the next collapsed state. `collapsibleHeight` is the height of the
 * content that collapses away (never the hero, which stays pinned and isn't
 * part of this calculation at all).
 */
export function nextHeaderCollapseState(
  collapsed: boolean,
  scrollY: number,
  collapsibleHeight: number,
): boolean {
  if (collapsibleHeight <= 0) {
    return false;
  }
  const collapseAt = collapsibleHeight;
  const expandAt = Math.max(0, collapsibleHeight - HYSTERESIS_BAND);
  if (!collapsed && scrollY > collapseAt) {
    return true;
  }
  if (collapsed && scrollY < expandAt) {
    return false;
  }
  return collapsed;
}
