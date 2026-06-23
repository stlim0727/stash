import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeUrl, normalizeUrl } from './urls.ts';

test('canonicalizeUrl strips utm_ and known tracking params', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=7'),
    'https://example.com/a?id=7',
  );
  assert.equal(canonicalizeUrl('https://example.com/a?fbclid=abc'), 'https://example.com/a');
});

test('canonicalizeUrl drops the fragment and sorts the query', () => {
  assert.equal(canonicalizeUrl('https://example.com/p?b=2&a=1#frag'), 'https://example.com/p?a=1&b=2');
});

test('canonicalizeUrl trims a trailing slash on non-root paths', () => {
  assert.equal(canonicalizeUrl('https://example.com/path/'), 'https://example.com/path');
  // Root slash is preserved.
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/');
});

test('canonicalizeUrl collapses utm-tagged and bare URLs to one key', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/x?utm_source=news'),
    canonicalizeUrl('https://example.com/x'),
  );
});

test('canonicalizeUrl strips youtube si=', () => {
  assert.equal(canonicalizeUrl('https://youtu.be/abc?si=track'), 'https://youtu.be/abc');
  // si= is preserved on non-share hosts.
  assert.equal(canonicalizeUrl('https://example.com/a?si=keep'), 'https://example.com/a?si=keep');
});

test('normalizeUrl adds https and rejects junk', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  https://x.com/p '), 'https://x.com/p');
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl('ftp://example.com'), null);
  assert.equal(normalizeUrl('localhost'), null);
});
