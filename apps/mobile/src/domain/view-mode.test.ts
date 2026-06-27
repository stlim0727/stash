import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VIEW_MODE,
  VIEW_MODES,
  describeViewMode,
  nextViewMode,
  parseViewMode,
  serializeViewMode,
  type ViewMode,
} from './view-mode.ts';

test('default layout is cards', () => {
  assert.equal(DEFAULT_VIEW_MODE, 'card');
});

test('VIEW_MODES lists the three layouts in control order (richest → densest)', () => {
  assert.deepEqual(VIEW_MODES, ['card', 'compact', 'list']);
  assert.equal(VIEW_MODES.length, 3);
});

test('nextViewMode cycles card → compact → list → card', () => {
  assert.equal(nextViewMode('card'), 'compact');
  assert.equal(nextViewMode('compact'), 'list');
  assert.equal(nextViewMode('list'), 'card');
});

test('describeViewMode labels each mode', () => {
  assert.equal(describeViewMode('card'), 'Cards');
  assert.equal(describeViewMode('compact'), 'Compact');
  assert.equal(describeViewMode('list'), 'List');
});

test('serialize/parse round-trips and falls back to the default', () => {
  const modes: ViewMode[] = ['card', 'compact', 'list'];
  for (const mode of modes) {
    assert.equal(parseViewMode(serializeViewMode(mode)), mode);
  }
  assert.equal(parseViewMode(null), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(''), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode('garbage'), DEFAULT_VIEW_MODE);
});

test('a stored cloud preference degrades to cards (cloud is no longer a layout)', () => {
  // 'cloud' used to be a persisted view mode; now the tag cloud is a transient
  // toggle. A leftover stored value must land on Cards, never reopen the cloud.
  assert.equal(parseViewMode('cloud'), 'card');
});
