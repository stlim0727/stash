import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  base64ToBase64Url,
  buildAuthorizeQuery,
  buildAuthorizeUrl,
  bytesToBase64,
  bytesToBase64Url,
  parseAuthRedirect,
} from './oauth.ts';

test('bytesToBase64 matches known RFC 4648 vectors', () => {
  const foobar = new Uint8Array([102, 111, 111, 98, 97, 114]); // "foobar"
  assert.equal(bytesToBase64(foobar), 'Zm9vYmFy');
  assert.equal(bytesToBase64(new Uint8Array([102])), 'Zg==');
  assert.equal(bytesToBase64(new Uint8Array([102, 111])), 'Zm8=');
});

test('base64url encoding is URL-safe and unpadded', () => {
  assert.equal(base64ToBase64Url('a+/b=='), 'a-_b');
  // 0xff 0xff -> "//8=" -> "__8"
  assert.equal(bytesToBase64Url(new Uint8Array([255, 255])), '__8');
});

test('buildAuthorizeQuery includes the PKCE params and encodes the redirect', () => {
  const query = buildAuthorizeQuery({
    provider: 'google',
    redirectTo: 'stash://auth/callback',
    codeChallenge: 'abc-123',
  });
  assert.match(query, /(^|&)provider=google(&|$)/);
  assert.match(query, /redirect_to=stash%3A%2F%2Fauth%2Fcallback/);
  assert.match(query, /code_challenge=abc-123/);
  assert.match(query, /code_challenge_method=s256/);
  assert.doesNotMatch(query, /skip_http_redirect/);
});

test('buildAuthorizeUrl trims a trailing slash and adds skip_http_redirect when asked', () => {
  const url = buildAuthorizeUrl('https://x.supabase.co/', {
    provider: 'apple',
    redirectTo: 'stash://auth/callback',
    codeChallenge: 'chal',
    skipHttpRedirect: true,
  });
  assert.ok(url.startsWith('https://x.supabase.co/auth/v1/authorize?'));
  assert.match(url, /provider=apple/);
  assert.match(url, /skip_http_redirect=true/);
});

test('parseAuthRedirect extracts the code from the query', () => {
  const result = parseAuthRedirect('stash://auth/callback?code=abc123&foo=bar');
  assert.equal(result.code, 'abc123');
  assert.equal(result.error, null);
});

test('parseAuthRedirect surfaces provider errors', () => {
  const result = parseAuthRedirect(
    'stash://auth/callback?error=access_denied&error_description=User%20cancelled',
  );
  assert.equal(result.code, null);
  assert.equal(result.error, 'access_denied');
  assert.equal(result.errorDescription, 'User cancelled');
});

test('parseAuthRedirect also reads a fragment response', () => {
  const result = parseAuthRedirect('stash://auth/callback#code=xyz');
  assert.equal(result.code, 'xyz');
});
