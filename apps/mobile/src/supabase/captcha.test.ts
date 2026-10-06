import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCaptchaChallengeUrl, CAPTCHA_CALLBACK_URL, getCaptchaSiteKey, KEEPORY_TURNSTILE_SITE_KEY, isCaptchaToken, parseCaptchaCallback } from './captcha.ts';

const nonce = 'a'.repeat(64);
const siteKey = '1x00000000000000000000AA'; // Cloudflare's public test site key.
const callback = `${CAPTCHA_CALLBACK_URL}#state=${nonce}&token=one-use-token`;

test('native challenge stays on Keepory and keeps the nonce out of HTTP query logs', () => {
  const url = new URL(buildCaptchaChallengeUrl(siteKey, nonce));
  assert.equal(url.origin, 'https://keepory.app');
  assert.equal(url.pathname, '/captcha.html');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('state'), nonce);
  assert.throws(() => buildCaptchaChallengeUrl(siteKey, 'weak-state'));
});

test('callback requires the exact native destination and outstanding nonce', () => {
  assert.equal(parseCaptchaCallback(callback, nonce), 'one-use-token');
  for (const url of [callback.replace('stash:', 'https:'), callback.replace('captcha/callback', 'other/callback'), callback.replace('/callback', '/callback/'), callback.replace('stash://', 'stash://attacker@'), callback.replace('#', '?injected=true#'), callback.replace(nonce, 'b'.repeat(64)), callback + '&state=' + nonce, callback + '&token=duplicate']) {
    assert.throws(() => parseCaptchaCallback(url, nonce));
  }
});

test('empty, malformed and oversized callback tokens fail closed', () => {
  for (const value of ['', 'a b', '\n', 'a'.repeat(2049), null, 42]) assert.equal(isCaptchaToken(value), false);
  assert.equal(isCaptchaToken('a'.repeat(2048)), true);
  for (const token of ['', 'a%20b', 'a'.repeat(2049)]) assert.throws(() => parseCaptchaCallback(`${CAPTCHA_CALLBACK_URL}#state=${nonce}&token=${token}`, nonce));
});

test('existing widget is the default; explicit opt-out and invalid overrides are respected', () => {
  const enabled = process.env.EXPO_PUBLIC_TURNSTILE_ENABLED;
  const key = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
  try {
    delete process.env.EXPO_PUBLIC_TURNSTILE_ENABLED;
    delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;
    assert.equal(getCaptchaSiteKey(), KEEPORY_TURNSTILE_SITE_KEY);
    process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = 'false';
    assert.equal(getCaptchaSiteKey(), undefined);
    process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = 'true';
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = '';
    assert.throws(getCaptchaSiteKey);
    process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = siteKey;
    assert.equal(getCaptchaSiteKey(), siteKey);
  } finally {
    if (enabled === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_ENABLED; else process.env.EXPO_PUBLIC_TURNSTILE_ENABLED = enabled;
    if (key === undefined) delete process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY; else process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY = key;
  }
});
