import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldShowWordmarkFallback } from './wordmark.ts';

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
