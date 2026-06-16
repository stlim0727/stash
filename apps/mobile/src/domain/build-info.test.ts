import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { describeBuild, getBuildInfo } from './build-info.ts';

const KEYS = ['EXPO_PUBLIC_GIT_SHA', 'EXPO_PUBLIC_GIT_REF', 'EXPO_PUBLIC_COMMIT_URL'] as const;

function clearEnv() {
  for (const key of KEYS) {
    delete process.env[key];
  }
}

afterEach(clearEnv);

test('getBuildInfo returns nulls when nothing is baked in', () => {
  clearEnv();
  const info = getBuildInfo();
  assert.deepEqual(info, { sha: null, shortSha: null, ref: null, commitUrl: null });
  assert.equal(describeBuild(info), 'local build (no commit baked in)');
});

test('getBuildInfo surfaces the sha, short sha, ref and commit URL', () => {
  process.env.EXPO_PUBLIC_GIT_SHA = '7b6e2a9b5aecd321edb2aaa8e4252afc0adda316';
  process.env.EXPO_PUBLIC_GIT_REF = 'main';
  process.env.EXPO_PUBLIC_COMMIT_URL =
    'https://github.com/stlim0727/stash/commit/7b6e2a9b5aecd321edb2aaa8e4252afc0adda316';

  const info = getBuildInfo();
  assert.equal(info.shortSha, '7b6e2a9');
  assert.equal(info.ref, 'main');
  assert.equal(info.commitUrl?.endsWith('7b6e2a9b5aecd321edb2aaa8e4252afc0adda316'), true);
  assert.equal(describeBuild(info), 'main @ 7b6e2a9');
});

test('describeBuild falls back to the short sha when no ref is set', () => {
  process.env.EXPO_PUBLIC_GIT_SHA = 'abcdef1234567890';
  assert.equal(describeBuild(getBuildInfo()), 'abcdef1');
});
