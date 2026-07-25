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

test('VIEW_MODES lists the three layouts in control order (richest → densest, folder last)', () => {
  assert.deepEqual(VIEW_MODES, ['card', 'list', 'folder']);
  assert.equal(VIEW_MODES.length, 3);
});

test('nextViewMode cycles card → list → folder → card', () => {
  assert.equal(nextViewMode('card'), 'list');
  assert.equal(nextViewMode('list'), 'folder');
  assert.equal(nextViewMode('folder'), 'card');
});

test('describeViewMode labels each mode', () => {
  assert.equal(describeViewMode('card'), 'Cards');
  assert.equal(describeViewMode('list'), 'List');
  assert.equal(describeViewMode('folder'), 'Folders');
});

test('serialize/parse round-trips and falls back to the default', () => {
  const modes: ViewMode[] = ['card', 'list', 'folder'];
  for (const mode of modes) {
    assert.equal(parseViewMode(serializeViewMode(mode)), mode);
  }
  assert.equal(parseViewMode(null), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(''), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode('garbage'), DEFAULT_VIEW_MODE);
});

test('legacy compact mode parses as list', () => {
  assert.equal(parseViewMode('compact'), 'list');
});

test('a stored cloud preference degrades to cards (cloud is no longer a layout)', () => {
  assert.equal(parseViewMode('cloud'), 'card');
});
