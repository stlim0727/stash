import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextHeaderCollapseState } from '@/domain/header-collapse';

test('never collapses when the collapsible height is unknown or zero', () => {
  assert.equal(nextHeaderCollapseState(false, 500, 0), false);
  assert.equal(nextHeaderCollapseState(true, 500, 0), false);
  assert.equal(nextHeaderCollapseState(false, 500, -10), false);
});

test('collapses once scrolled past the collapsible height', () => {
  assert.equal(nextHeaderCollapseState(false, 50, 80), false);
  assert.equal(nextHeaderCollapseState(false, 81, 80), true);
});

test('expands once scrolled back below the hysteresis band', () => {
  assert.equal(nextHeaderCollapseState(true, 60, 80), true); // still within the 24px band
  assert.equal(nextHeaderCollapseState(true, 55, 80), false); // 80 - 24 = 56, below it
});

test('holds steady inside the hysteresis band (no flicker at the boundary)', () => {
  // Between expandAt (56) and collapseAt (80): whichever state it was already
  // in, it stays there — this is the whole point of the band.
  assert.equal(nextHeaderCollapseState(false, 70, 80), false);
  assert.equal(nextHeaderCollapseState(true, 70, 80), true);
});

test('never lets a stale accumulated value linger: recomputes fresh from the current offset every call', () => {
  // Simulates a remount resetting the list to scrollY=0 while collapsed was
  // last `true` — the very next tick (or an explicit call with the fresh
  // offset) must reflect reality immediately, no separate reset step needed.
  assert.equal(nextHeaderCollapseState(true, 0, 80), false);
});
