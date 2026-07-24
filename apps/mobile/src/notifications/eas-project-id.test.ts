import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEasProjectId } from '@/notifications/eas-project-id';

test('resolves a configured projectId', () => {
  assert.equal(resolveEasProjectId({ eas: { projectId: 'abc-123' } }), 'abc-123');
});

test('trims whitespace around a configured projectId', () => {
  assert.equal(resolveEasProjectId({ eas: { projectId: '  abc-123  ' } }), 'abc-123');
});

test('returns null when extra is missing', () => {
  assert.equal(resolveEasProjectId(undefined), null);
  assert.equal(resolveEasProjectId(null), null);
});

test('returns null when extra.eas is missing', () => {
  assert.equal(resolveEasProjectId({}), null);
});

test('returns null when extra.eas.projectId is missing or blank', () => {
  assert.equal(resolveEasProjectId({ eas: {} }), null);
  assert.equal(resolveEasProjectId({ eas: { projectId: '' } }), null);
  assert.equal(resolveEasProjectId({ eas: { projectId: '   ' } }), null);
});

test('returns null for malformed shapes instead of throwing', () => {
  assert.equal(resolveEasProjectId('not-an-object'), null);
  assert.equal(resolveEasProjectId({ eas: 'not-an-object' }), null);
  assert.equal(resolveEasProjectId({ eas: { projectId: 42 } }), null);
});
