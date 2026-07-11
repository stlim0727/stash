import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemver } from './version.ts';

test('compareSemver orders normal versions', () => {
  assert.equal(compareSemver('1.2.0', '1.1.9') > 0, true);
  assert.equal(compareSemver('v1.2.0', '1.2.0'), 0);
  assert.equal(compareSemver('1.2', '1.2.0'), 0);
});

test('compareSemver treats prereleases as lower than final releases', () => {
  assert.equal(compareSemver('1.2.0-rc1', '1.2.0') < 0, true);
  assert.equal(compareSemver('1.2.0', '1.2.0-rc1') > 0, true);
});

test('compareSemver compares prerelease numbers naturally', () => {
  assert.equal(compareSemver('1.2.0-rc2', '1.2.0-rc10') < 0, true);
  assert.equal(compareSemver('1.2.0-beta.2', '1.2.0-beta.10') < 0, true);
});
