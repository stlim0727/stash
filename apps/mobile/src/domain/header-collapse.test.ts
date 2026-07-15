import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INITIAL_HEADER_COLLAPSE_STATE,
  nextHeaderCollapseState,
  type HeaderCollapseState,
} from '@/domain/header-collapse';

test('never collapses when the collapsible height is unknown or zero', () => {
  assert.deepEqual(
    nextHeaderCollapseState({ collapsed: false, anchorScrollY: 0 }, 500, 0),
    { collapsed: false, anchorScrollY: 0 },
  );
  assert.deepEqual(
    nextHeaderCollapseState({ collapsed: true, anchorScrollY: 100 }, 500, 0),
    { collapsed: false, anchorScrollY: 500 },
  );
});

test('collapses once scrolled past the collapsible height from the current anchor', () => {
  const start = INITIAL_HEADER_COLLAPSE_STATE;
  assert.deepEqual(nextHeaderCollapseState(start, 50, 80), start);
  assert.deepEqual(nextHeaderCollapseState(start, 81, 80), { collapsed: true, anchorScrollY: 81 });
});

test('re-anchors on every state change, so a continued gesture in the same direction holds steady', () => {
  // A multi-tick downward scroll: collapses on the first tick past the
  // threshold, then STAYS collapsed on every subsequent tick — this is
  // exactly the case a naive single-tick-delta check got wrong (PR review
  // catch): re-anchoring means the next call measures from where it just
  // collapsed, not from a fixed absolute threshold.
  let state = INITIAL_HEADER_COLLAPSE_STATE;
  state = nextHeaderCollapseState(state, 90, 80); // collapses, anchor -> 90
  assert.equal(state.collapsed, true);
  state = nextHeaderCollapseState(state, 200, 80); // still scrolling down
  assert.equal(state.collapsed, true);
  state = nextHeaderCollapseState(state, 5000, 80); // deep in a long list
  assert.equal(state.collapsed, true);
  // The anchor must have followed the descent to 5000, not stayed pinned at
  // 90 — a fixed collapse-time anchor is exactly what left the next test's
  // reveal unreachable (PR review catch).
  assert.equal(state.anchorScrollY, 5000);
});

test('a stale collapse-time anchor cannot survive a long continued downward scroll — reveals from wherever collapsed actually bottomed out', () => {
  // The exact repro PR review gave: 0 -> 90 -> 5000 -> 4970 through the real
  // public transition (not a hand-set starting state). A version that only
  // re-anchors on the collapse/expand flip itself (and never again while
  // already collapsed) parks anchorScrollY at 90 forever, so this upward
  // flick from deep in the list computes `90 - 4970` (deeply negative) and
  // never reveals.
  let state = INITIAL_HEADER_COLLAPSE_STATE;
  state = nextHeaderCollapseState(state, 90, 80); // collapses, anchor -> 90
  state = nextHeaderCollapseState(state, 5000, 80); // keeps scrolling down
  assert.equal(state.collapsed, true);
  state = nextHeaderCollapseState(state, 4970, 80); // 30px up from the real bottom
  assert.equal(state.collapsed, false, 'must reveal from the deepest point actually reached, not the original collapse point');
});

test('reveals on a sustained upward flick and STAYS revealed as it continues, wherever the user is', () => {
  // The exact scenario PR review flagged: deep in a list (scrollY=5000),
  // scrolling up in several ticks must not re-collapse itself after one tick.
  // This starting state is itself reachable through the real transition (see
  // the previous test) — not just a hand-set fixture.
  let state: HeaderCollapseState = { collapsed: true, anchorScrollY: 5000 };
  state = nextHeaderCollapseState(state, 4970, 80); // 30px up -> reveals, anchor -> 4970
  assert.equal(state.collapsed, false);
  state = nextHeaderCollapseState(state, 4940, 80); // continues up
  assert.equal(state.collapsed, false, 'must not re-collapse mid-gesture');
  state = nextHeaderCollapseState(state, 4900, 80); // continues up again
  assert.equal(state.collapsed, false, 'must not re-collapse mid-gesture');
});

test('a small upward jitter under the reveal delta does not expand', () => {
  const state: HeaderCollapseState = { collapsed: true, anchorScrollY: 5000 };
  assert.deepEqual(nextHeaderCollapseState(state, 4990, 80), state);
});

test('re-collapses if the user resumes scrolling down past the height from where it last expanded', () => {
  let state: HeaderCollapseState = { collapsed: false, anchorScrollY: 4970 };
  assert.deepEqual(nextHeaderCollapseState(state, 5000, 80), state); // only 30px down, not yet
  state = nextHeaderCollapseState(state, 5060, 80); // 90px down from the anchor
  assert.equal(state.collapsed, true);
});

test('never lets a stale value linger: a remount resetting scrollY to 0 while collapsed corrects immediately', () => {
  // The caller resets `collapsed`/`anchorScrollY` explicitly on a FlatList
  // remount (see app/index.tsx) — this just confirms the fresh state behaves
  // correctly from that point, with no separate reset logic needed here.
  const freshState = INITIAL_HEADER_COLLAPSE_STATE;
  assert.deepEqual(nextHeaderCollapseState(freshState, 0, 80), freshState);
});
