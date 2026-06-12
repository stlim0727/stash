import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractFirstUrl, normalizeUrl } from './urls.ts';

test('normalizeUrl accepts scheme-less domains', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  raindrop.io  '), 'https://raindrop.io/');
});

test('normalizeUrl preserves http(s) URLs and paths', () => {
  assert.equal(
    normalizeUrl('https://docs.expo.dev/router/introduction/'),
    'https://docs.expo.dev/router/introduction/',
  );
  assert.equal(normalizeUrl('http://example.com/a?b=c'), 'http://example.com/a?b=c');
});

test('normalizeUrl rejects invalid input', () => {
  assert.equal(normalizeUrl(''), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(normalizeUrl('ftp://example.com'), null);
  assert.equal(normalizeUrl('localhost'), null);
  assert.equal(normalizeUrl('https://example.com/a b'), null);
});

test('extractFirstUrl finds a link inside shared text', () => {
  assert.equal(
    extractFirstUrl('Great read https://example.com/article check it out'),
    'https://example.com/article',
  );
  assert.equal(extractFirstUrl('example.com'), 'https://example.com/');
});

test('extractFirstUrl returns null when no link exists', () => {
  assert.equal(extractFirstUrl('just some words'), null);
  assert.equal(extractFirstUrl(''), null);
  assert.equal(extractFirstUrl(null), null);
  assert.equal(extractFirstUrl(undefined), null);
});
