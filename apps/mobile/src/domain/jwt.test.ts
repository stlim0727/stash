import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jwtSubject } from './jwt.ts';

// header: {"alg":"HS256","typ":"JWT"}
// payload: {"sub":"d9ba30db-090b-49ab-b544-93fff8e23106","role":"authenticated","is_anonymous":false}
const REAL_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkOWJhMzBkYi0wOTBiLTQ5YWItYjU0NC05M2ZmZjhlMjMxMDYiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlzX2Fub255bW91cyI6ZmFsc2V9.fakesignature';

test('jwtSubject decodes the sub claim from a well-formed JWT', () => {
  assert.equal(jwtSubject(REAL_JWT), 'd9ba30db-090b-49ab-b544-93fff8e23106');
});

test('jwtSubject returns null for a token with the wrong number of segments', () => {
  assert.equal(jwtSubject('not-a-jwt'), null);
  assert.equal(jwtSubject('only.two'), null);
  assert.equal(jwtSubject('a.b.c.d'), null);
});

test('jwtSubject returns null for a payload segment that is not valid base64url', () => {
  assert.equal(jwtSubject('header.!!!not-base64!!!.sig'), null);
});

test('jwtSubject returns null for a payload that decodes but is not valid JSON', () => {
  // base64url of the literal text "not json"
  assert.equal(jwtSubject('header.bm90IGpzb24.sig'), null);
});

test('jwtSubject returns null when the payload has no sub claim', () => {
  // base64url of {"role":"authenticated"}
  assert.equal(jwtSubject('header.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.sig'), null);
});

test('jwtSubject returns null when sub is present but not a string', () => {
  // base64url of {"sub":123}
  assert.equal(jwtSubject('header.eyJzdWIiOjEyM30.sig'), null);
});
