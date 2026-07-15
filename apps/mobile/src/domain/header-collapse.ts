/**
 * Web-only collapsing-header state (see `app/index.tsx`). Replaces an
 * accumulated `Animated.diffClamp` value — which requires an explicit reset on
 * every discontinuity (a FlatList remount, a missed frame) and has twice left
 * the header stuck at a stale collapsed value (Sentry STASH-2B, STASH-2G) —
 * with state derived fresh from the current scroll offset on every tick.
 *
 * `anchorScrollY` is not "the offset where the current state began" — an
 * earlier version tried that and it goes stale the moment the user keeps
 * scrolling in the same direction without the state flipping: collapsing at
 * 90 and continuing on down to 5000 left the anchor pinned at 90, so an
 * upward flick back from 5000 measured against 90 (`90 - 4970`, deeply
 * negative) and never revealed (caught in PR review with a concrete `0 -> 90
 * -> 5000 -> 4970` repro). Instead the anchor tracks the *extreme* point
 * reached in the current state — the highest scrollY seen while collapsed,
 * the lowest while expanded — updated on every tick, even ones that don't
 * flip `collapsed`. That extreme is what "how far back has the user come"
 * needs to be measured against, and it can't go stale the way a fixed
 * flip-time snapshot can: it is recomputed from the live scroll offset on
 * every single call, in the same state-flip branch, with no separate reset
 * path to forget.
 *
 * Pure — no React, no Animated — so the Node test lane can exercise it
 * directly.
 */

/** How far (px) the user must scroll up from the deepest collapsed point to
 *  reveal the header again. */
const REVEAL_DELTA = 24;

export interface HeaderCollapseState {
  collapsed: boolean;
  anchorScrollY: number;
}

export const INITIAL_HEADER_COLLAPSE_STATE: HeaderCollapseState = {
  collapsed: false,
  anchorScrollY: 0,
};

/**
 * Given the current state and the list's live scroll offset, decide the next
 * state. `collapsibleHeight` is the height of the content that collapses away
 * (never the hero, which stays pinned and isn't part of this calculation).
 */
export function nextHeaderCollapseState(
  state: HeaderCollapseState,
  scrollY: number,
  collapsibleHeight: number,
): HeaderCollapseState {
  if (collapsibleHeight <= 0) {
    return state.collapsed ? { collapsed: false, anchorScrollY: scrollY } : state;
  }
  if (state.collapsed) {
    if (state.anchorScrollY - scrollY > REVEAL_DELTA) {
      return { collapsed: false, anchorScrollY: scrollY };
    }
    // Still collapsed: keep the anchor at the deepest point reached so far,
    // so a later reveal is measured from there, not from wherever it first
    // collapsed.
    return scrollY > state.anchorScrollY ? { collapsed: true, anchorScrollY: scrollY } : state;
  }
  if (scrollY - state.anchorScrollY > collapsibleHeight) {
    return { collapsed: true, anchorScrollY: scrollY };
  }
  // Still expanded: symmetrically track the highest point (lowest scrollY)
  // reached so far, so a later collapse is measured from there.
  return scrollY < state.anchorScrollY ? { collapsed: false, anchorScrollY: scrollY } : state;
}
