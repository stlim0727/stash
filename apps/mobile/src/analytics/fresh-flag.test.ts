import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FreshLaunchBooleanFlag } from './fresh-flag.ts';

test('starts every launch off and enables only after a fresh exact-true response', async () => {
  const flag = new FreshLaunchBooleanFlag();
  flag.startLaunch();
  assert.equal(flag.value(), false);
  assert.equal(await flag.refresh(async () => true), true);
  assert.equal(flag.value(), true);

  flag.startLaunch();
  assert.equal(flag.value(), false);
  assert.equal(await flag.refresh(async () => 'true'), false);
  assert.equal(await flag.refresh(async () => Promise.reject(new Error('offline'))), false);
});

test('ignores a successful response from an earlier launch', async () => {
  let resolve!: (value: unknown) => void;
  const flag = new FreshLaunchBooleanFlag();
  flag.startLaunch();
  const stale = flag.refresh(() => new Promise((done) => (resolve = done)));
  flag.startLaunch();
  resolve(true);
  await stale;
  assert.equal(flag.value(), false);
});
