import assert from 'node:assert/strict';
import test from 'node:test';

import { didWordmarkImageLoad, shouldShowWordmarkFallback } from './wordmark.ts';

test('web shows the text wordmark while the PNG is still loading', () => {
  assert.equal(
    shouldShowWordmarkFallback({
      platform: 'web',
      wordmarkFailed: false,
      wordmarkLoaded: false,
    }),
    true,
  );
});

test('web hides the text wordmark after the PNG loads', () => {
  assert.equal(
    shouldShowWordmarkFallback({
      platform: 'web',
      wordmarkFailed: false,
      wordmarkLoaded: true,
    }),
    false,
  );
});

test('native does not show the loading fallback unless the PNG fails', () => {
  assert.equal(
    shouldShowWordmarkFallback({
      platform: 'ios',
      wordmarkFailed: false,
      wordmarkLoaded: false,
    }),
    false,
  );
  assert.equal(
    shouldShowWordmarkFallback({
      platform: 'android',
      wordmarkFailed: true,
      wordmarkLoaded: false,
    }),
    true,
  );
});

test('didWordmarkImageLoad is true only for a decoded image with real pixels', () => {
  assert.equal(didWordmarkImageLoad({ width: 120, height: 28 }), true);
  assert.equal(didWordmarkImageLoad({ width: 0, height: 0 }), false);
  assert.equal(didWordmarkImageLoad({ width: 120, height: 0 }), false);
  assert.equal(didWordmarkImageLoad(undefined), false);
});
