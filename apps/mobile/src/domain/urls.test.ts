import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalizeUrl, extractFirstUrl, normalizeUrl } from './urls.ts';

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
  assert.equal(
    extractFirstUrl('Check this out: https://example.com/article.'),
    'https://example.com/article',
  );
  assert.equal(
    extractFirstUrl('Go to (https://example.com/page)'),
    'https://example.com/page',
  );
  assert.equal(
    extractFirstUrl('Link: https://example.com/page, check it.'),
    'https://example.com/page',
  );
  assert.equal(
    extractFirstUrl('Go to https://en.wikipedia.org/wiki/Bird_(disambiguation) for info.'),
    'https://en.wikipedia.org/wiki/Bird_(disambiguation)',
  );
  assert.equal(
    extractFirstUrl('Go to (https://en.wikipedia.org/wiki/Bird_(disambiguation)) for info.'),
    'https://en.wikipedia.org/wiki/Bird_(disambiguation)',
  );
  assert.equal(
    extractFirstUrl('See https://example.com/page_[1] for more.'),
    'https://example.com/page_[1]',
  );
  assert.equal(
    extractFirstUrl('Check (https://example.com/page_[1]) now.'),
    'https://example.com/page_[1]',
  );
});

test('extractFirstUrl returns null when no link exists', () => {
  assert.equal(extractFirstUrl('just some words'), null);
  assert.equal(extractFirstUrl(''), null);
  assert.equal(extractFirstUrl(null), null);
  assert.equal(extractFirstUrl(undefined), null);
});

test('canonicalizeUrl strips utm_* and known tracking params', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/a?utm_source=fb&utm_medium=cpc&id=2'),
    'https://example.com/a?id=2',
  );
  assert.equal(canonicalizeUrl('https://example.com/p?fbclid=abc'), 'https://example.com/p');
  assert.equal(canonicalizeUrl('https://example.com/p?gclid=x&q=hi'), 'https://example.com/p?q=hi');
});

test('canonicalizeUrl drops the fragment and sorts the query', () => {
  assert.equal(canonicalizeUrl('https://example.com/a#section'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('https://example.com/a?b=2&a=1'), 'https://example.com/a?a=1&b=2');
});

test('canonicalizeUrl trims a trailing slash on non-root paths only', () => {
  assert.equal(canonicalizeUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/');
});

test('canonicalizeUrl keeps content-bearing params and is idempotent', () => {
  const once = canonicalizeUrl('https://example.com/watch?v=123&utm_source=t');
  assert.equal(once, 'https://example.com/watch?v=123');
  assert.equal(canonicalizeUrl(once), once);
});

test('canonicalizeUrl maps tracking variants of one page to the same key', () => {
  const clean = canonicalizeUrl('https://example.com/post');
  assert.equal(canonicalizeUrl('https://example.com/post?utm_campaign=spring'), clean);
  assert.equal(canonicalizeUrl('https://example.com/post#top'), clean);
});

test('canonicalizeUrl strips the YouTube share `si` token so re-shares dedupe', () => {
  const clean = 'https://youtube.com/shorts/gkx8ZfytWeE';
  assert.equal(canonicalizeUrl('https://youtube.com/shorts/gkx8ZfytWeE?si=Kgq04hU28tQmyOaV'), clean);
  assert.equal(canonicalizeUrl('https://youtube.com/shorts/gkx8ZfytWeE?si=g2oSW1QiR4zjMhzS'), clean);
  // youtu.be, www/m subdomains, and share.google links are covered too.
  assert.equal(canonicalizeUrl('https://youtu.be/MfwJ4X7lx4k?si=abc'), 'https://youtu.be/MfwJ4X7lx4k');
  assert.equal(
    canonicalizeUrl('https://m.youtube.com/watch?v=CGMooBw-5XM&si=ZJpWatBo15jHGz8q'),
    'https://m.youtube.com/watch?v=CGMooBw-5XM',
  );
  assert.equal(canonicalizeUrl('https://share.google/m97weCW3E6wKEfgTK?si=x'), 'https://share.google/m97weCW3E6wKEfgTK');
});

test('canonicalizeUrl keeps `si` on other hosts (not safe to strip globally)', () => {
  assert.equal(canonicalizeUrl('https://example.com/p?si=keep'), 'https://example.com/p?si=keep');
});

test('canonicalizeUrl returns unparsable input unchanged', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
});
