import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountInitials } from './account.ts';

test('uses two name tokens when present', () => {
  assert.equal(accountInitials('sam.taylor@example.com'), 'ST');
  assert.equal(accountInitials('jane-doe@x.io'), 'JD');
});

test('uses the first two letters of a single token', () => {
  assert.equal(accountInitials('mereu@example.com'), 'ME');
  assert.equal(accountInitials('x@example.com'), 'X');
});

test('falls back to a dot when there is no usable email', () => {
  assert.equal(accountInitials(null), '•');
  assert.equal(accountInitials(''), '•');
  assert.equal(accountInitials(undefined), '•');
});
