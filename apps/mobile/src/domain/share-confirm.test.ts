import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addPendingShareSave,
  parsePendingShareConfirm,
  serializePendingShareConfirm,
} from '@/domain/share-confirm';

test('parse returns null for missing or empty input', () => {
  assert.equal(parsePendingShareConfirm(null), null);
  assert.equal(parsePendingShareConfirm(undefined), null);
  assert.equal(parsePendingShareConfirm(''), null);
});

test('parse returns null for malformed JSON or wrong shape', () => {
  assert.equal(parsePendingShareConfirm('not json'), null);
  assert.equal(parsePendingShareConfirm('{"savedCount":"two"}'), null);
  assert.equal(parsePendingShareConfirm('{"other":3}'), null);
});

test('parse treats a zero or negative count as nothing to confirm', () => {
  assert.equal(parsePendingShareConfirm('{"savedCount":0}'), null);
  assert.equal(parsePendingShareConfirm('{"savedCount":-4}'), null);
});

test('parse reads a valid count and floors fractional values', () => {
  assert.deepEqual(parsePendingShareConfirm('{"savedCount":3}'), { savedCount: 3 });
  assert.deepEqual(parsePendingShareConfirm('{"savedCount":2.9}'), { savedCount: 2 });
});

test('serialize round-trips through parse', () => {
  const value = { savedCount: 5 };
  assert.deepEqual(parsePendingShareConfirm(serializePendingShareConfirm(value)), value);
});

test('add accumulates onto an existing record', () => {
  assert.deepEqual(addPendingShareSave(null), { savedCount: 1 });
  assert.deepEqual(addPendingShareSave({ savedCount: 2 }), { savedCount: 3 });
  assert.deepEqual(addPendingShareSave({ savedCount: 2 }, 3), { savedCount: 5 });
});

test('add never decrements on a stray negative', () => {
  assert.deepEqual(addPendingShareSave({ savedCount: 2 }, -5), { savedCount: 2 });
});
