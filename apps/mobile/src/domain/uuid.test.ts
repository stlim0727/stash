import assert from 'node:assert/strict';
import test from 'node:test';
import { makeUuid } from './uuid.ts';

test('makeUuid generates valid UUID v4 format', () => {
  const id1 = makeUuid();
  const id2 = makeUuid();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(id1, uuidPattern);
  assert.match(id2, uuidPattern);
  assert.notEqual(id1, id2);
});
