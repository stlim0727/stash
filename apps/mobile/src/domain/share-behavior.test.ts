import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SHARE_BEHAVIOR,
  describeShareBehavior,
  parseShareBehavior,
  serializeShareBehavior,
  type ShareBehavior,
} from './share-behavior.ts';

test('default behavior is a modeless toast', () => {
  assert.equal(DEFAULT_SHARE_BEHAVIOR, 'toast');
});

test('describeShareBehavior labels each behavior', () => {
  assert.equal(describeShareBehavior('toast'), 'Toast only');
  assert.equal(describeShareBehavior('inbox'), 'Open Inbox');
});

test('serialize/parse round-trips and falls back to the default', () => {
  const behaviors: ShareBehavior[] = ['toast', 'inbox'];
  for (const behavior of behaviors) {
    assert.equal(parseShareBehavior(serializeShareBehavior(behavior)), behavior);
  }
  assert.equal(parseShareBehavior(null), DEFAULT_SHARE_BEHAVIOR);
  assert.equal(parseShareBehavior(undefined), DEFAULT_SHARE_BEHAVIOR);
  assert.equal(parseShareBehavior(''), DEFAULT_SHARE_BEHAVIOR);
  assert.equal(parseShareBehavior('garbage'), DEFAULT_SHARE_BEHAVIOR);
});
