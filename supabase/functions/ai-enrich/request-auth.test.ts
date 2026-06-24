import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isAnonymousAuthorization,
  resolveCallerAuth,
  shouldFailClosedOnRateLimit,
  timingSafeEqual,
} from './request-auth.ts';

// Build a (signature-irrelevant) JWT with the given payload claims. The function
// never verifies the signature — PostgREST does — so a dummy header/signature is
// fine for exercising the claim-decoding path.
function makeJwt(claims: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

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

// ── is_anonymous decoding ─────────────────────────────────────────────────────

test('isAnonymousAuthorization: is_anonymous:true → anonymous', () => {
  const jwt = makeJwt({ sub: 'u1', is_anonymous: true });
  assert.equal(isAnonymousAuthorization(`Bearer ${jwt}`), true);
});

test('isAnonymousAuthorization: is_anonymous:false → signed-in', () => {
  const jwt = makeJwt({ sub: 'u1', is_anonymous: false, email: 'a@b.c' });
  assert.equal(isAnonymousAuthorization(`Bearer ${jwt}`), false);
  // The scheme prefix is optional / case-insensitive.
  assert.equal(isAnonymousAuthorization(jwt), false);
  assert.equal(isAnonymousAuthorization(`bearer ${jwt}`), false);
});

test('isAnonymousAuthorization: missing claim or malformed token → anonymous (safe default)', () => {
  // Claim absent entirely.
  assert.equal(isAnonymousAuthorization(`Bearer ${makeJwt({ sub: 'u1' })}`), true);
  // Non-boolean claim is not an explicit false.
  assert.equal(isAnonymousAuthorization(`Bearer ${makeJwt({ is_anonymous: 'no' })}`), true);
  // Garbage / wrong segment count / empty.
  assert.equal(isAnonymousAuthorization('Bearer not.a.jwt-ish'), true);
  assert.equal(isAnonymousAuthorization('Bearer onlyonesegment'), true);
  assert.equal(isAnonymousAuthorization(''), true);
  assert.equal(isAnonymousAuthorization(null), true);
});

// ── fail-closed decision (issue #3) ───────────────────────────────────────────

test('shouldFailClosedOnRateLimit: anonymous user → fail CLOSED', () => {
  const anonJwt = makeJwt({ sub: 'anon', is_anonymous: true });
  const caller = resolveCallerAuth({
    authorization: `Bearer ${anonJwt}`,
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'user');
  assert.equal(shouldFailClosedOnRateLimit(caller), true);
});

test('shouldFailClosedOnRateLimit: signed-in user → fail OPEN', () => {
  const realJwt = makeJwt({ sub: 'real', is_anonymous: false });
  const caller = resolveCallerAuth({
    authorization: `Bearer ${realJwt}`,
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'user');
  assert.equal(shouldFailClosedOnRateLimit(caller), false);
});

test('shouldFailClosedOnRateLimit: server/trigger path → fail OPEN', () => {
  const caller = resolveCallerAuth({
    authorization: null,
    secretHeader: 'the-secret',
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'server');
  assert.equal(shouldFailClosedOnRateLimit(caller), false);
});

test('shouldFailClosedOnRateLimit: user with garbled token → fail CLOSED (treated as anonymous)', () => {
  const caller = resolveCallerAuth({
    authorization: 'Bearer garbage',
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'user');
  assert.equal(shouldFailClosedOnRateLimit(caller), true);
});
