import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTransientNetworkError } from './network-errors.ts';

test('recognizes the Android offline/DNS failure (STASH-4)', () => {
  const error = new Error(
    'fetch failed: java.net.UnknownHostException: Unable to resolve host "example.supabase.co": No address associated with hostname',
  );
  assert.equal(isTransientNetworkError(error), true);
});

test('recognizes React Native and web transport failures', () => {
  assert.equal(isTransientNetworkError(new Error('Network request failed')), true);
  assert.equal(isTransientNetworkError(new Error('TypeError: Failed to fetch')), true);
  assert.equal(isTransientNetworkError(new Error('The request timed out.')), true);
});

test('does not flag a genuine server/application error', () => {
  assert.equal(isTransientNetworkError(new Error('HTTP 500: internal server error')), false);
  assert.equal(isTransientNetworkError(new Error('Cannot read property "x" of undefined')), false);
});

test('is null/undefined safe', () => {
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError(undefined), false);
  assert.equal(isTransientNetworkError(''), false);
});
