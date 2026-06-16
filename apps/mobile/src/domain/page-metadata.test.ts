import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectCharset,
  normalizeCharsetLabel,
  oembedEndpoint,
  parseOembed,
  parsePageMetadata,
  youtubeVideoId,
} from './page-metadata.ts';

function bytes(str: string): Uint8Array {
  return new Uint8Array([...str].map((ch) => ch.charCodeAt(0)));
}

const sampleHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Fallback &amp; Title</title>
  <meta property="og:title" content="Local-first software" />
  <meta property="og:site_name" content="Ink &amp; Switch" />
  <meta property="og:image" content="/images/preview.png" />
  <meta name="twitter:title" content="Twitter title" />
  <link rel="shortcut icon" href="/static/favicon.ico" />
</head>
<body><p>hello</p></body>
</html>`;

test('parsePageMetadata prefers OpenGraph fields and decodes entities', () => {
  const meta = parsePageMetadata(sampleHtml, 'https://www.inkandswitch.com/local-first/');
  assert.equal(meta.title, 'Local-first software');
  assert.equal(meta.site_name, 'Ink & Switch');
});

test('parsePageMetadata resolves relative image and favicon URLs', () => {
  const meta = parsePageMetadata(sampleHtml, 'https://www.inkandswitch.com/local-first/');
  assert.equal(meta.preview_image_url, 'https://www.inkandswitch.com/images/preview.png');
  assert.equal(meta.favicon_url, 'https://www.inkandswitch.com/static/favicon.ico');
});

test('parsePageMetadata falls back to twitter then <title>', () => {
  const twitterOnly = '<head><meta name="twitter:title" content="T"/><title>Doc</title></head>';
  assert.equal(parsePageMetadata(twitterOnly, 'https://x.com/').title, 'T');

  const titleOnly = '<head><title>  Plain &#39;Doc&#x27;  </title></head>';
  assert.equal(parsePageMetadata(titleOnly, 'https://x.com/').title, "Plain 'Doc'");
});

test('parsePageMetadata handles attribute order and single quotes', () => {
  const html = `<head><meta content='Reversed' property='og:title'></head>`;
  assert.equal(parsePageMetadata(html, 'https://x.com/').title, 'Reversed');
});

test('parsePageMetadata returns undefined fields for empty documents', () => {
  const meta = parsePageMetadata('<html><body>no head</body></html>', 'https://x.com/');
  assert.equal(meta.title, undefined);
  assert.equal(meta.site_name, undefined);
  assert.equal(meta.favicon_url, undefined);
  assert.equal(meta.preview_image_url, undefined);
});

test('youtubeVideoId extracts the id from every YouTube URL shape', () => {
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/MufIgnqP1vk'), 'MufIgnqP1vk');
  assert.equal(youtubeVideoId('https://m.youtube.com/watch?v=abc123'), 'abc123');
  assert.equal(youtubeVideoId('https://www.youtube.com/embed/xyz789'), 'xyz789');
  assert.equal(youtubeVideoId('https://example.com/watch?v=nope'), null);
  assert.equal(youtubeVideoId('not a url'), null);
});

test('oembedEndpoint builds a canonical YouTube oEmbed URL (shorts → watch)', () => {
  assert.equal(
    oembedEndpoint('https://www.youtube.com/shorts/MufIgnqP1vk'),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DMufIgnqP1vk',
  );
  assert.equal(oembedEndpoint('https://example.com/article'), null);
});

test('parseOembed maps title, provider, and thumbnail', () => {
  const meta = parseOembed({
    title: 'Never Gonna Give You Up',
    provider_name: 'YouTube',
    thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  });
  assert.equal(meta.title, 'Never Gonna Give You Up');
  assert.equal(meta.site_name, 'YouTube');
  assert.equal(meta.preview_image_url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(meta.favicon_url, undefined);
});

test('parseOembed ignores blank/non-string fields', () => {
  const meta = parseOembed({ title: '  ', provider_name: 123, thumbnail_url: undefined });
  assert.equal(meta.title, undefined);
  assert.equal(meta.site_name, undefined);
  assert.equal(meta.preview_image_url, undefined);
});

test('detectCharset prefers the Content-Type header', () => {
  assert.equal(detectCharset('text/html; charset=EUC-KR', bytes('')), 'euc-kr');
  assert.equal(detectCharset('text/html; charset=utf-8', bytes('<meta charset=euc-kr>')), 'utf-8');
});

test('detectCharset sniffs a <meta charset> when the header omits it', () => {
  assert.equal(detectCharset('text/html', bytes('<meta charset="euc-kr">')), 'euc-kr');
  assert.equal(
    detectCharset(
      'text/html',
      bytes('<meta http-equiv="Content-Type" content="text/html; charset=cp949">'),
    ),
    'euc-kr',
  );
});

test('detectCharset defaults to utf-8', () => {
  assert.equal(detectCharset('text/html', bytes('<html><head></head>')), 'utf-8');
  assert.equal(detectCharset(null, bytes('')), 'utf-8');
});

test('normalizeCharsetLabel maps common aliases to WHATWG labels', () => {
  assert.equal(normalizeCharsetLabel('CP949'), 'euc-kr');
  assert.equal(normalizeCharsetLabel('ks_c_5601-1987'), 'euc-kr');
  assert.equal(normalizeCharsetLabel('Shift-JIS'), 'shift_jis');
  assert.equal(normalizeCharsetLabel('gb2312'), 'gbk');
  assert.equal(normalizeCharsetLabel('UTF-8'), 'utf-8');
  assert.equal(normalizeCharsetLabel('windows-1252'), 'windows-1252');
});
