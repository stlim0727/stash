import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_VIEW_MODE,
  describeViewMode,
  nextViewMode,
  parseViewMode,
  serializeViewMode,
  type ViewMode,
} from './view-mode.ts';

test('default layout is cards', () => {
  assert.equal(DEFAULT_VIEW_MODE, 'card');
});

test('nextViewMode toggles between the two modes', () => {
  assert.equal(nextViewMode('card'), 'list');
  assert.equal(nextViewMode('list'), 'card');
});

test('describeViewMode labels each mode', () => {
  assert.equal(describeViewMode('card'), 'Cards');
  assert.equal(describeViewMode('list'), 'List');
});

test('serialize/parse round-trips and falls back to the default', () => {
  const modes: ViewMode[] = ['card', 'list'];
  for (const mode of modes) {
    assert.equal(parseViewMode(serializeViewMode(mode)), mode);
  }
  assert.equal(parseViewMode(null), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(''), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode('garbage'), DEFAULT_VIEW_MODE);
});
