/**
 * Web-only collapsing-header state (see `app/index.tsx`). Replaces an
 * accumulated `Animated.diffClamp` value — which requires an explicit reset on
 * every discontinuity (a FlatList remount, a missed frame) and has twice left
 * the header stuck at a stale collapsed value (Sentry STASH-2B, STASH-2G) —
 * with state derived fresh from the current scroll offset on every tick.
 *
 * Collapse/expand decisions are relative to `anchorScrollY` — the scroll
 * offset at which the *current* state began, not an ever-growing total. Every
 * time the state actually flips, the anchor re-stamps to the current offset.
 * This is what lets a continued upward (or downward) scroll gesture keep the
 * header revealed (or collapsed) for as long as the gesture continues, rather
 * than reverting on the very next tick because the absolute position is still
 * far from any fixed threshold (caught in PR review: an earlier version only
 * compared the two most recent readings, so a multi-tick upward flick
 * re-collapsed itself after a single tick of being revealed). It still can't
 * reintroduce the original staleness bug: even if an update is missed, the
 * next call simply compares the current offset against whatever anchor was
 * last recorded — there is no long-lived total that requires a separate,
 * easy-to-forget reset step, only this one small piece of state, which the
 * caller already resets alongside `collapsed` on every FlatList remount.
 *
 * Pure — no React, no Animated — so the Node test lane can exercise it
 * directly.
 */

/** How far (px) the user must scroll up from the collapse anchor to reveal
 *  the header again. */
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
  if (!state.collapsed && scrollY - state.anchorScrollY > collapsibleHeight) {
    return { collapsed: true, anchorScrollY: scrollY };
  }
  if (state.collapsed && state.anchorScrollY - scrollY > REVEAL_DELTA) {
    return { collapsed: false, anchorScrollY: scrollY };
  }
  return state;
}
