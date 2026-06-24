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

test('shouldFailClosedOnRateLimit: user with garbled token → fail CLOSED (treated as anonymous)', () => {
  const caller = resolveCallerAuth({
    authorization: 'Bearer garbage',
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'user');
  assert.equal(shouldFailClosedOnRateLimit(caller), true);
});

// ── server-path: follow the TARGET BOOKMARK'S OWNER (Codex P1) ────────────────
// The server-trigger path fires for user-created rows, so an anonymous user can
// still drive server-path enrichment. During a limiter outage the decision must
// track the *owner*, not just "trusted server".

function serverCaller() {
  const caller = resolveCallerAuth({
    authorization: null,
    secretHeader: 'the-secret',
    triggerSecret: 'the-secret',
  });
  assert.equal(caller.kind, 'server');
  return caller;
}

test('shouldFailClosedOnRateLimit: server path, real owner → fail OPEN', () => {
  // Don't break a real user's background enrichment on a DB hiccup.
  assert.equal(shouldFailClosedOnRateLimit(serverCaller(), false), false);
});

test('shouldFailClosedOnRateLimit: server path, anonymous owner → fail CLOSED', () => {
  // An anonymous user must not get unthrottled server-path enrichment.
  assert.equal(shouldFailClosedOnRateLimit(serverCaller(), true), true);
});

test('shouldFailClosedOnRateLimit: server path, owner anonymity unknown → fail CLOSED (safe default)', () => {
  // undefined ⇒ the owner lookup failed; default to the strict side.
  assert.equal(shouldFailClosedOnRateLimit(serverCaller(), undefined), true);
  assert.equal(shouldFailClosedOnRateLimit(serverCaller()), true);
});

// ── verify_jwt assumption pin (issue #4) ──────────────────────────────────────
// The fail-OPEN-for-signed-in branch is only SAFE because the gateway forwards
// the user's token to PostgREST, which re-verifies its signature (the function
// itself does NOT verify it — isAnonymousAuthorization just *reads* the claim).
// A caller who forges `is_anonymous: false` to dodge the fail-closed path is
// caught downstream: PostgREST rejects the bad signature, so the request can't
// reach the billable model anyway.
//
// IF supabase/config.toml ever flips ai-enrich back to verify_jwt = true at the
// gateway, that's fine (the gateway pre-verifies). But if the token ever stops
// being signature-checked on the data path, this control silently evaporates —
// this test documents that load-bearing assumption so a future posture change
// trips a visible, named test rather than a quiet regression.
test('shouldFailClosedOnRateLimit: a forged is_anonymous:false reads as signed-in here — SAFE ONLY because PostgREST re-verifies the forwarded token (verify_jwt)', () => {
  const forged = makeJwt({ sub: 'attacker', is_anonymous: false });
  const caller = resolveCallerAuth({
    authorization: `Bearer ${forged}`,
    secretHeader: null,
    triggerSecret: 'the-secret',
  });
  // This function trusts the claim (no signature check) → reads as "fail open".
  assert.equal(shouldFailClosedOnRateLimit(caller), false);
  // The compensating control lives outside this module: the forwarded token's
  // signature is re-verified by PostgREST on every read/write. If that ever
  // changes, revisit the fail-open branch — do not weaken this assertion to
  // "paper over" a posture change.
});
