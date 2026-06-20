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

test('VIEW_MODES lists the layouts in control order', () => {
  assert.deepEqual(VIEW_MODES, ['card', 'list', 'cloud']);
});

test('nextViewMode cycles card → list → cloud → card', () => {
  assert.equal(nextViewMode('card'), 'list');
  assert.equal(nextViewMode('list'), 'cloud');
  assert.equal(nextViewMode('cloud'), 'card');
});

test('describeViewMode labels each mode', () => {
  assert.equal(describeViewMode('card'), 'Cards');
  assert.equal(describeViewMode('list'), 'List');
  assert.equal(describeViewMode('cloud'), 'Tag cloud');
});

test('serialize/parse round-trips and falls back to the default', () => {
  const modes: ViewMode[] = ['card', 'list', 'cloud'];
  for (const mode of modes) {
    assert.equal(parseViewMode(serializeViewMode(mode)), mode);
  }
  assert.equal(parseViewMode(null), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(''), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode('garbage'), DEFAULT_VIEW_MODE);
});
