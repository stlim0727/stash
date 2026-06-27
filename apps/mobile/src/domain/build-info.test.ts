import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeBuild, getBuildInfo } from './build-info.ts';

test('getBuildInfo returns nulls when nothing is baked in', () => {
  const info = getBuildInfo();
  assert.deepEqual(info, { sha: null, shortSha: null, ref: null, commitUrl: null });
  assert.equal(describeBuild(info), 'local build (no commit baked in)');
});

test('getBuildInfo treats a nullish source as a local build', () => {
  // Constants.expoConfig?.extra is undefined when no config is embedded.
  assert.deepEqual(getBuildInfo(undefined), { sha: null, shortSha: null, ref: null, commitUrl: null });
  assert.deepEqual(getBuildInfo(null), { sha: null, shortSha: null, ref: null, commitUrl: null });
});

test('getBuildInfo surfaces the sha, short sha, ref and commit URL', () => {
  const info = getBuildInfo({
    gitSha: '7b6e2a9b5aecd321edb2aaa8e4252afc0adda316',
    gitRef: 'main',
    commitUrl: 'https://github.com/stlim0727/stash/commit/7b6e2a9b5aecd321edb2aaa8e4252afc0adda316',
  });
  assert.equal(info.shortSha, '7b6e2a9');
  assert.equal(info.ref, 'main');
  assert.equal(info.commitUrl?.endsWith('7b6e2a9b5aecd321edb2aaa8e4252afc0adda316'), true);
  assert.equal(describeBuild(info), 'main @ 7b6e2a9');
});

test('getBuildInfo ignores blank / whitespace-only values', () => {
  const info = getBuildInfo({ gitSha: '   ', gitRef: '', commitUrl: null });
  assert.deepEqual(info, { sha: null, shortSha: null, ref: null, commitUrl: null });
});

test('describeBuild falls back to the short sha when no ref is set', () => {
  assert.equal(describeBuild(getBuildInfo({ gitSha: 'abcdef1234567890' })), 'abcdef1');
});
