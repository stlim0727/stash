import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameRecordSnapshot } from './record-snapshot.ts';

test('accepts an identical reference or separately allocated equal rows', () => {
  const current = [{ id: 'a', status: 'pending' }];
  assert.equal(sameRecordSnapshot(current, current), true);
  assert.equal(sameRecordSnapshot(current, [{ id: 'a', status: 'pending' }]), true);
});

test('rejects changed fields, order, and length', () => {
  const current = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'synced' },
  ];
  assert.equal(
    sameRecordSnapshot(current, [
      { id: 'a', status: 'synced' },
      { id: 'b', status: 'synced' },
    ]),
    false,
  );
  assert.equal(sameRecordSnapshot(current, [...current].reverse()), false);
  assert.equal(sameRecordSnapshot(current, current.slice(0, 1)), false);
});
