import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCallerAuth, timingSafeEqual } from './request-auth.ts';

test('timingSafeEqual: equal strings match, different ones do not', () => {
  assert.equal(timingSafeEqual('s3cret', 's3cret'), true);
  assert.equal(timingSafeEqual('s3cret', 's3creT'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

test('timingSafeEqual: differing lengths never match', () => {
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('abcd', 'abc'), false);
  assert.equal(timingSafeEqual('secret', ''), false);
});

test('resolveCallerAuth: valid shared secret → server path', () => {
  const auth = resolveCallerAuth({
    authorization: null,
    secretHeader: 'the-secret',
    triggerSecret: 'the-secret',
  });
  assert.deepEqual(auth, { kind: 'server' });
});

test('resolveCallerAuth: secret takes precedence over a forwarded token', () => {
  const auth = resolveCallerAuth({
    authorization: 'Bearer user-jwt',
    secretHeader: 'the-secret',
    triggerSecret: 'the-secret',
  });
  assert.deepEqual(auth, { kind: 'server' });
});

test('resolveCallerAuth: wrong secret is rejected, never downgraded to user', () => {
  const auth = resolveCallerAuth({
    authorization: 'Bearer user-jwt',
    secretHeader: 'wrong',
    triggerSecret: 'the-secret',
  });
  assert.deepEqual(auth, { kind: 'unauthorized' });
});

test('resolveCallerAuth: secret header but no secret configured → unauthorized', () => {
  const auth = resolveCallerAuth({
    authorization: null,
    secretHeader: 'anything',
    triggerSecret: null,
  });
  assert.deepEqual(auth, { kind: 'unauthorized' });
});

test('resolveCallerAuth: no secret header falls back to the forwarded user token', () => {
  const auth = resolveCallerAuth({
    authorization: 'Bearer user-jwt',
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.deepEqual(auth, { kind: 'user', authorization: 'Bearer user-jwt' });
});

test('resolveCallerAuth: neither secret nor token → unauthorized', () => {
  const auth = resolveCallerAuth({
    authorization: null,
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.deepEqual(auth, { kind: 'unauthorized' });
});
