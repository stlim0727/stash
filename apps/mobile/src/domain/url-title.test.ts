import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeKnownUrl, looksOpaqueId } from './url-title.ts';

test('describeKnownUrl labels a YouTube link with a derived thumbnail', () => {
  const shorts = describeKnownUrl('https://youtube.com/shorts/0JE4ngPfYo4');
  assert.deepEqual(shorts, {
    title: 'YouTube video',
    preview_image_url: 'https://i.ytimg.com/vi/0JE4ngPfYo4/hqdefault.jpg',
  });
});

test('describeKnownUrl leads social posts with the author handle', () => {
  assert.equal(
    describeKnownUrl('https://www.threads.com/@ephemeris.ai/post/Dabls52E90n')?.title,
    'Threads post by @ephemeris.ai',
  );
  assert.equal(
    describeKnownUrl('https://x.com/jack/status/20')?.title,
    'Post by @jack on X',
  );
  assert.equal(
    describeKnownUrl('https://www.tiktok.com/@scout/video/12345')?.title,
    'TikTok by @scout',
  );
});

test('describeKnownUrl distinguishes Instagram reels from posts', () => {
  assert.equal(describeKnownUrl('https://instagram.com/reel/abc')?.title, 'Instagram reel');
  assert.equal(describeKnownUrl('https://instagram.com/p/abc')?.title, 'Instagram post');
});

test('describeKnownUrl names GitHub from the path', () => {
  assert.equal(
    describeKnownUrl('https://github.com/stlim0727/stash/pull/9')?.title,
    'stlim0727/stash on GitHub',
  );
});

test('describeKnownUrl prefers a readable Reddit title slug over the subreddit label', () => {
  // A comment URL with a title slug: defer to generic derivation (which
  // Title-Cases the slug) rather than the generic "Reddit post in r/…".
  assert.equal(
    describeKnownUrl('https://www.reddit.com/r/cooking/comments/xyz/how_to_make_pancakes'),
    null,
  );
  // A slugless post URL: fall back to the subreddit label.
  assert.equal(
    describeKnownUrl('https://www.reddit.com/r/cooking/comments/xyz')?.title,
    'Reddit post in r/cooking',
  );
});

test('describeKnownUrl returns null for unknown hosts and bare GitHub profiles', () => {
  assert.equal(describeKnownUrl('https://example.com/some-article'), null);
  assert.equal(describeKnownUrl('https://github.com/stlim0727'), null);
});

test('describeKnownUrl does not label profile/landing URLs as posts', () => {
  // A profile is not a post — fall through to generic derivation, so an
  // identifying slug title (e.g. "Natgeo") is never replaced by a wrong,
  // never-retried "Instagram post" label.
  assert.equal(describeKnownUrl('https://instagram.com/natgeo/'), null);
  assert.equal(describeKnownUrl('https://www.threads.com/@ephemeris.ai'), null);
  assert.equal(describeKnownUrl('https://x.com/jack'), null);
  assert.equal(describeKnownUrl('https://www.tiktok.com/@scout'), null);
  assert.equal(describeKnownUrl('https://www.reddit.com/r/swimming'), null);
});

test('looksOpaqueId flags id-shaped segments but not real words', () => {
  assert.equal(looksOpaqueId('Dabls52E90n'), true);
  assert.equal(looksOpaqueId('MEvcN4Nwa1g'), true);
  assert.equal(looksOpaqueId('012345678'), true);
  assert.equal(looksOpaqueId('deadbeefdeadbeef99'), true);
  // Real words / word-like slugs are not opaque — including long ones with no
  // separators (a bare length rule would wrongly discard these).
  assert.equal(looksOpaqueId('local-first'), false);
  assert.equal(looksOpaqueId('introduction'), false);
  assert.equal(looksOpaqueId('iphone15'), false);
  assert.equal(looksOpaqueId('html5'), false);
  assert.equal(looksOpaqueId('internationalization'), false);
  assert.equal(looksOpaqueId('한국어로된아주긴제목입니다정말로'), false);
});
