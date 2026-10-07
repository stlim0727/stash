import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuotaVerdict } from './quota.ts';

test('only a boolean quota verdict is usable; malformed responses cannot authorize spending', () => {
  for (const value of [null, undefined, [], {}, { allowed: null }, { allowed: 1 }, { allowed: 'true' }]) {
    assert.equal(parseQuotaVerdict(value), null);
  }
  assert.equal(parseQuotaVerdict({ allowed: true })?.allowed, true);
  assert.equal(parseQuotaVerdict({ allowed: false })?.allowed, false);
  assert.equal(parseQuotaVerdict({ allowed: false, retry_after: Infinity })?.retry_after, undefined);
  assert.equal(parseQuotaVerdict({ allowed: false, retry_after: -2 })?.retry_after, 1);
});
