import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkYoutubeAvailability,
  detectCharset,
  discoverOembedEndpoint,
  fetchPageMetadata,
  htmlHeadSummary,
  isYoutubeAvailabilityCandidate,
  normalizeCharsetLabel,
  oembedEndpoint,
  parseOembed,
  parsePageMetadata,
  previewSourceUrl,
  youtubePlaylistId,
  youtubeVideoId,
} from './page-metadata.ts';
import { clearLogEntries, getLogEntries } from '../observability/log-buffer.ts';

function bytes(str: string): Uint8Array {
  return new Uint8Array([...str].map((ch) => ch.charCodeAt(0)));
}

/** A minimal fetch Response stub for the metadata fetcher. */
function htmlResponse(
  html: string,
  opts: { url?: string; contentType?: string } = {},
): Response {
  const body = new TextEncoder().encode(html);
  return {
    ok: true,
    url: opts.url ?? '',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? opts.contentType ?? 'text/html; charset=utf-8' : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
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

test('parsePageMetadata keeps GeekNews social preview metadata', () => {
  const html = `
    <head>
      <title>Claude와 몇 달간 씨름한 뒤 Codex는 바이브 코더의 꿈처럼 느껴짐 | GeekNews</title>
      <meta property="og:title" content="Claude와 몇 달간 씨름한 뒤 Codex는 바이브 코더의 꿈처럼 느껴짐 | GeekNews">
      <meta property="og:site_name" content="GeekNews">
      <meta property="og:image" content="https://social.news.hada.io/topic/29576">
      <link rel="shortcut icon" href="/favicon.ico">
    </head>`;

  const meta = parsePageMetadata(html, 'https://news.hada.io/topic?id=29576');

  assert.equal(meta.title, 'Claude와 몇 달간 씨름한 뒤 Codex는 바이브 코더의 꿈처럼 느껴짐 | GeekNews');
  assert.equal(meta.site_name, 'GeekNews');
  assert.equal(meta.preview_image_url, 'https://social.news.hada.io/topic/29576');
  assert.equal(meta.favicon_url, 'https://news.hada.io/favicon.ico');
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

test('parsePageMetadata handles unquoted attributes, uppercase tags, and quoted angle brackets', () => {
  const html = `<HEAD>
    <META PROPERTY=og:title CONTENT="A > B &copy; &mdash; &#x1F986;">
    <META PROPERTY=og:site_name CONTENT=Example>
    <META PROPERTY=og:image CONTENT="/preview?a=1&amp;b=2">
    <LINK REL=icon HREF="/icon?a=1&amp;b=2">
  </HEAD>`;
  assert.deepEqual(parsePageMetadata(html, 'https://example.com/article'), {
    title: 'A > B © — 🦆',
    site_name: 'Example',
    preview_image_url: 'https://example.com/preview?a=1&b=2',
    favicon_url: 'https://example.com/icon?a=1&b=2',
  });
});

test('HTML parsing ignores metadata and discovery links inside comments and scripts', () => {
  const html = `<head>
    <!-- <meta property="og:title" content="Comment"><title>Fake</title>
         <link type="application/json+oembed" href="/fake"> -->
    <script>const template = '<meta property="og:image" content="/fake.png"><title>Fake</title><link type="application/json+oembed" href="/fake">';</script>
    <title>Real &copy; title</title>
    <meta data-property="og:title" content="Wrong attribute">
    <meta property="og:site_name" content="Real site">
  </head>`;
  const meta = parsePageMetadata(html, 'https://example.com/');
  assert.equal(meta.title, 'Real © title');
  assert.equal(meta.preview_image_url, undefined);
  assert.equal(discoverOembedEndpoint(html, 'https://example.com/'), null);
  assert.equal(htmlHeadSummary(html), 'metas=2 og/tw=[og:site_name] title=true');
});

test('parsePageMetadata decodes entities once and replaces invalid numeric references', () => {
  assert.equal(
    parsePageMetadata('<meta property="og:title" content="&amp;copy; &#x110000;">', 'https://example.com/').title,
    '&copy; �',
  );
  assert.equal(
    parsePageMetadata('<title>A &amp;copy; &copy; B</title>', 'https://example.com/').title,
    'A &copy; © B',
  );
});

test('parsePageMetadata preserves first nonempty metadata and first title precedence', () => {
  const html = `<meta property="og:title" content=" ">
    <meta property="og:title" content="First">
    <meta property="og:title" content="Second">
    <meta name="twitter:title" content="Twitter">
    <title>Document</title>`;
  assert.equal(parsePageMetadata(html, 'https://example.com/').title, 'First');
  assert.equal(parsePageMetadata('<title>First</title><title>Second</title>', 'https://example.com/').title, 'First');
});

test('HTML parsing keeps the bounded prefix for metadata, discovery, and diagnostics', () => {
  const html = ' '.repeat(512 * 1024) + '<title>Too late</title><meta property="og:title" content="Too late"><link type="application/json+oembed" href="/late">';
  assert.equal(parsePageMetadata(html, 'https://example.com/').title, undefined);
  assert.equal(discoverOembedEndpoint(html, 'https://example.com/'), null);
  assert.equal(htmlHeadSummary(html), 'metas=0 og/tw=[] title=false');
});

test('discoverOembedEndpoint handles unquoted types and decodes URL entities once', () => {
  assert.equal(
    discoverOembedEndpoint('<LINK TYPE=application/json+oembed HREF="/oembed?a=1&amp;b=2">', 'https://example.com/post'),
    'https://example.com/oembed?a=1&b=2',
  );
});

test('discoverOembedEndpoint resolves a provider-independent JSON discovery link', () => {
  assert.equal(
    discoverOembedEndpoint(
      `<head><link rel="alternate" type="application/json+oembed" href="/api/oembed?url=post%2F1"></head>`,
      'https://social.example/posts/1',
    ),
    'https://social.example/api/oembed?url=post%2F1',
  );
  assert.equal(
    discoverOembedEndpoint(
      `<head><link type="text/xml+oembed" href="https://social.example/oembed.xml"></head>`,
      'https://social.example/posts/1',
    ),
    null,
  );
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

test('youtubePlaylistId extracts the playlist id from YouTube and YouTube Music playlist URLs', () => {
  assert.equal(
    youtubePlaylistId('https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
  );
  assert.equal(
    youtubePlaylistId('https://music.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
  );
  assert.equal(
    youtubePlaylistId('https://m.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4&si=xyz'),
    'PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
  );
  assert.equal(
    youtubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    null,
  );
  assert.equal(youtubePlaylistId('https://example.com/playlist?list=PL123'), null);
  assert.equal(youtubePlaylistId('not a url'), null);
});

test('oembedEndpoint builds provider URLs for YouTube and Reddit posts', () => {
  assert.equal(
    oembedEndpoint('https://www.youtube.com/shorts/MufIgnqP1vk'),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DMufIgnqP1vk',
  );
  assert.equal(
    oembedEndpoint('https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fplaylist%3Flist%3DPLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
  );
  assert.equal(
    oembedEndpoint('https://music.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fplaylist%3Flist%3DPLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
  );
  assert.equal(
    oembedEndpoint('https://www.reddit.com/r/LocalLLaMA/comments/abc123/a_specific_post/'),
    'https://www.reddit.com/oembed?url=https%3A%2F%2Fwww.reddit.com%2Fr%2FLocalLLaMA%2Fcomments%2Fabc123%2Fa_specific_post%2F',
  );
  assert.equal(
    oembedEndpoint('https://redd.it/abc123'),
    'https://www.reddit.com/oembed?url=https%3A%2F%2Fredd.it%2Fabc123',
  );
  assert.equal(oembedEndpoint('https://www.reddit.com/r/LocalLLaMA/'), null);
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

// STASH-61: a saved YouTube video can be deleted/made private after capture.
// oEmbed 404 is the unambiguous "gone" signal; everything else must stay
// 'unknown' so a flaky network or an unrelated URL never mislabels a video.
test('checkYoutubeAvailability reports unavailable on oEmbed 404 (deleted)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 404 }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(
      await checkYoutubeAvailability('https://youtube.com/shorts/PG7OUsiB6Qg'),
      'unavailable',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A 401 only means this unauthenticated, app-owned request can't see a
// private video — the signed-in owner can still open the same link in their
// own YouTube app, so it must NOT be reported as unavailable (would show a
// false badge + search fallback on a still-playable bookmark).
test('checkYoutubeAvailability reports unknown, not unavailable, on oEmbed 401 (private)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 401 }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(
      await checkYoutubeAvailability('https://youtube.com/shorts/PG7OUsiB6Qg'),
      'unknown',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A share.google short link has no oEmbed endpoint directly, but is a known
// YouTube share-sheet shortener (see urls.ts's stripsShareSi) — it must be
// resolved via redirect before conceding to 'unknown', or every video shared
// this way would silently never get checked. Resolution must use HEAD (PR
// review): RN's fetch polyfill only resolves once the full body has
// downloaded, so a GET here would buffer the whole landed YouTube page just
// to read `response.url`.
test('checkYoutubeAvailability resolves a share.google redirect via HEAD before checking oEmbed', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (target: string, init?: RequestInit) => {
    calls.push({ url: target, method: init?.method });
    if (target.startsWith('https://share.google/')) {
      return { url: 'https://www.youtube.com/shorts/MufIgnqP1vk' } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  }) as typeof fetch;
  try {
    assert.equal(
      await checkYoutubeAvailability('https://share.google/bb3vpuiCbbyVhrpTp'),
      'unavailable',
    );
    const shortenerCall = calls.find((c) => c.url.startsWith('https://share.google/'));
    assert.equal(shortenerCall?.method, 'HEAD');
    assert.ok(calls.some((c) => c.url.includes('youtube.com%2Fwatch%3Fv%3DMufIgnqP1vk')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkYoutubeAvailability reports available when oEmbed answers with a title', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ title: 'Me at the zoo', provider_name: 'YouTube' }),
    }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(
      await checkYoutubeAvailability('https://youtu.be/jNQXAC9IVRw'),
      'available',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isYoutubeAvailabilityCandidate accepts direct YouTube URLs, playlists, and the share.google shortener, rejects everything else', () => {
  assert.equal(isYoutubeAvailabilityCandidate('https://youtu.be/dQw4w9WgXcQ'), true);
  assert.equal(
    isYoutubeAvailabilityCandidate('https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    true,
  );
  assert.equal(
    isYoutubeAvailabilityCandidate('https://music.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4'),
    true,
  );
  assert.equal(isYoutubeAvailabilityCandidate('https://share.google/bb3vpuiCbbyVhrpTp'), true);
  assert.equal(isYoutubeAvailabilityCandidate('https://example.com/article'), false);
  assert.equal(isYoutubeAvailabilityCandidate('not a url'), false);
});

test('checkYoutubeAvailability reports unknown on a non-YouTube URL, a 5xx, and a network error', async () => {
  assert.equal(await checkYoutubeAvailability('https://example.com/article'), 'unknown');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
  try {
    assert.equal(await checkYoutubeAvailability('https://youtu.be/jNQXAC9IVRw'), 'unknown');
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  try {
    assert.equal(await checkYoutubeAvailability('https://youtu.be/jNQXAC9IVRw'), 'unknown');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The oEmbed thumbnail is the soft 480×360 `hqdefault`; enrichment upgrades it
// to the 640×480 `sddefault` when the video has one (a HEAD 200), keeping the
// preview crisp on a 2× display.
test('fetchPageMetadata upgrades a YouTube thumbnail to sddefault when available', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (target: string, init?: RequestInit) => {
    calls.push({ url: target, method: init?.method });
    if (init?.method === 'HEAD') {
      return { ok: true } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        title: 'Never Gonna Give You Up',
        provider_name: 'YouTube',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(meta?.preview_image_url, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg');
    assert.ok(calls.some((c) => c.method === 'HEAD' && c.url.endsWith('/sddefault.jpg')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Older / SD-only uploads 404 the higher tiers, so the upgrade falls back to the
// oEmbed `hqdefault` rather than leaving a broken preview.
test('fetchPageMetadata keeps hqdefault when sddefault is missing (404)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_target: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') {
      return { ok: false } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        title: 'Me at the zoo',
        provider_name: 'YouTube',
        thumbnail_url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
      }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://youtu.be/jNQXAC9IVRw');
    assert.equal(meta?.preview_image_url, 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata prefers YouTube playlist oEmbed over generic HTML title', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (target: string) => {
    calls.push(target);
    if (target.startsWith('https://www.youtube.com/oembed')) {
      return {
        ok: true,
        json: async () => ({
          title: 'Lex Fridman Podcast',
          provider_name: 'YouTube',
          thumbnail_url: 'https://i.ytimg.com/vi/s7d2d8FhevU/hqdefault.jpg',
        }),
      } as unknown as Response;
    }
    return htmlResponse('<head><title>YouTube</title></head>');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata(
      'https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9nrraNbKKp4',
    );
    assert.equal(meta?.title, 'Lex Fridman Podcast');
    assert.equal(meta?.site_name, 'YouTube');
    assert.equal(meta?.preview_image_url, 'https://i.ytimg.com/vi/s7d2d8FhevU/hqdefault.jpg');
    assert.equal(calls.length, 1, 'successful oEmbed should avoid the generic HTML request');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata prefers Reddit oEmbed over its generic HTML title (STASH-6F)', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (target: string) => {
    calls.push(target);
    if (target.startsWith('https://www.reddit.com/oembed')) {
      return {
        ok: true,
        json: async () => ({
          title: 'A specific Reddit post title',
          provider_name: 'Reddit',
          thumbnail_url: 'https://preview.redd.it/example.jpg',
        }),
      } as unknown as Response;
    }
    return htmlResponse('<head><title>Reddit</title></head>');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata(
      'https://www.reddit.com/r/LocalLLaMA/comments/abc123/a_specific_post/',
    );
    assert.equal(meta?.title, 'A specific Reddit post title');
    assert.equal(meta?.site_name, 'Reddit');
    assert.equal(meta?.preview_image_url, 'https://preview.redd.it/example.jpg');
    assert.equal(calls.length, 1, 'successful oEmbed should avoid the generic HTML request');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata uses Reddit oEmbed after an app share-link redirect (STASH-6H)', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const finalUrl = 'https://www.reddit.com/r/korea/comments/abc123/a_specific_post/';
  globalThis.fetch = (async (target: string) => {
    calls.push(target);
    if (target.startsWith('https://www.reddit.com/oembed')) {
      return {
        ok: true,
        json: async () => ({
          title: 'A specific Reddit post title',
          provider_name: 'Reddit',
          thumbnail_url: 'https://preview.redd.it/example.jpg',
        }),
      } as unknown as Response;
    }
    return htmlResponse('<head><title>Reddit</title></head>', { url: finalUrl });
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://www.reddit.com/r/korea/s/shareToken');
    assert.equal(meta?.title, 'A specific Reddit post title');
    assert.equal(meta?.site_name, 'Reddit');
    assert.equal(meta?.preview_image_url, 'https://preview.redd.it/example.jpg');
    assert.deepEqual(calls, [
      'https://www.reddit.com/r/korea/s/shareToken',
      `https://www.reddit.com/oembed?url=${encodeURIComponent(finalUrl)}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata follows standard oEmbed discovery for an unknown provider', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (target: string) => {
    calls.push(target);
    if (target === 'https://social.example/api/oembed?post=42') {
      return {
        ok: true,
        json: async () => ({
          title: 'The specific post title',
          provider_name: 'Social Example',
          thumbnail_url: 'https://social.example/thumb.jpg',
        }),
      } as unknown as Response;
    }
    return htmlResponse(
      '<head><title>Social Example</title><link rel="alternate" type="application/json+oembed" href="/api/oembed?post=42"></head>',
      { url: 'https://social.example/posts/42' },
    );
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://social.example/posts/42');
    assert.equal(meta?.title, 'The specific post title');
    assert.equal(meta?.site_name, 'Social Example');
    assert.equal(meta?.preview_image_url, 'https://social.example/thumb.jpg');
    assert.deepEqual(calls, [
      'https://social.example/posts/42',
      'https://social.example/api/oembed?post=42',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkYoutubeAvailability does not query the Reddit oEmbed provider', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ title: 'post' }) } as unknown as Response;
  }) as typeof fetch;
  try {
    assert.equal(
      await checkYoutubeAvailability('https://www.reddit.com/r/test/comments/abc123/post/'),
      'unknown',
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata recovers YouTube oEmbed metadata after a share.google redirect', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];
  const finalUrl = 'https://www.youtube.com/shorts/MufIgnqP1vk';
  globalThis.fetch = (async (target: string, init?: RequestInit) => {
    calls.push({ url: target, method: init?.method });
    if (target.startsWith('https://www.youtube.com/oembed')) {
      return {
        ok: true,
        json: async () => ({
          title: 'A specific Shorts title',
          provider_name: 'YouTube',
          thumbnail_url: 'https://i.ytimg.com/vi/MufIgnqP1vk/hqdefault.jpg',
        }),
      } as unknown as Response;
    }
    if (init?.method === 'HEAD') {
      return { ok: false } as unknown as Response;
    }
    return htmlResponse('<html><head></head><body>shell</body></html>', { url: finalUrl });
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://share.google/bb3vpuiCbbyVhrpTp');
    assert.equal(meta?.title, 'A specific Shorts title');
    assert.equal(meta?.site_name, 'YouTube');
    assert.equal(meta?.preview_image_url, 'https://i.ytimg.com/vi/MufIgnqP1vk/hqdefault.jpg');
    assert.ok(calls.some((c) => c.url.includes('youtube.com%2Fwatch%3Fv%3DMufIgnqP1vk')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata sends the honest bot UA first and does not retry on success', async () => {
  const originalFetch = globalThis.fetch;
  const userAgents: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    userAgents.push((init?.headers as Record<string, string>)?.['User-Agent'] ?? '');
    return htmlResponse('<head><meta property="og:title" content="OK"></head>');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://example.com/article');
    assert.equal(meta?.title, 'OK');
    // Only one request, with the honest bot UA — no browser fallback.
    assert.equal(userAgents.length, 1);
    assert.match(userAgents[0], /StashBot/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata fetches the https twin of an http:// URL (cleartext is blocked on device)', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (target: string) => {
    requested.push(String(target));
    if (String(target).startsWith('http://')) {
      // Android API 28+ rejects cleartext HTTP before any redirect can run.
      throw new TypeError('Network request failed');
    }
    return htmlResponse('<head><meta property="og:title" content="플레이스 설계자"></head>', {
      url: String(target),
    });
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('http://welaaa.com/ebook/detail/211212');
    assert.equal(meta?.title, '플레이스 설계자');
    assert.ok(requested.length > 0);
    for (const u of requested) {
      assert.match(u, /^https:\/\//);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata retries as a browser when the bot UA is refused (403)', async () => {
  const originalFetch = globalThis.fetch;
  const userAgents: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string>)?.['User-Agent'] ?? '';
    userAgents.push(ua);
    if (/StashBot/.test(ua)) {
      return { ok: false, status: 403, url: '', headers: { get: () => null } } as unknown as Response;
    }
    return htmlResponse('<head><meta property="og:title" content="Naver post"></head>');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://naver.me/GmpU1du7');
    assert.equal(meta?.title, 'Naver post');
    assert.equal(userAgents.length, 2);
    assert.match(userAgents[0], /StashBot/);
    assert.match(userAgents[1], /Chrome/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata requests only the head via a Range header', async () => {
  const originalFetch = globalThis.fetch;
  const ranges: (string | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    ranges.push((init?.headers as Record<string, string>)?.Range);
    return htmlResponse('<head><meta property="og:title" content="OK"></head>');
  }) as typeof fetch;
  try {
    await fetchPageMetadata('https://example.com/article');
    // 512 KiB minus one: bytes 0..524287 inclusive == MAX_HTML_BYTES bytes, so a
    // range-honoring server never sends more than we parse.
    assert.deepEqual(ranges, ['bytes=0-524287']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata parses the head of an oversized body (never the whole thing)', async () => {
  const originalFetch = globalThis.fetch;
  // Real title in the head, then ~700 KB of filler with a DIFFERENT late title.
  // A server that ignores the Range header returns the full body; the fix caps
  // the decode/parse to the head, so we must read the head's title and never see
  // the tail — the multi-megabyte decode that froze the app (STASH-K/J).
  const head = '<head><meta property="og:title" content="Head Title"></head>';
  const filler = `<!-- ${'x'.repeat(700 * 1024)} -->`;
  const late = '<meta property="og:title" content="Late Title">';
  globalThis.fetch = (async () => htmlResponse(head + filler + late)) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://example.com/huge');
    assert.equal(meta?.title, 'Head Title');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('previewSourceUrl maps a Naver Map place entry to its server-rendered page', () => {
  assert.equal(
    previewSourceUrl('https://map.naver.com/p/entry/place/1887843614'),
    'https://m.place.naver.com/place/1887843614/home',
  );
  // Also the older direct place host, with extra path segments.
  assert.equal(
    previewSourceUrl('https://pcmap.place.naver.com/place/1887843614/home'),
    'https://m.place.naver.com/place/1887843614/home',
  );
});

test('previewSourceUrl returns null for non-place Naver URLs and other hosts', () => {
  assert.equal(previewSourceUrl('https://blog.naver.com/someblog/12345'), null);
  assert.equal(previewSourceUrl('https://example.com/place/123'), null);
  assert.equal(previewSourceUrl('not a url'), null);
});

test('fetchPageMetadata recovers a Naver Map place via the server-rendered sibling', async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (target: string) => {
    requested.push(target);
    // The short link / map wrapper resolves to a title-less SPA shell.
    if (target.includes('naver.me') || target.includes('map.naver.com')) {
      return htmlResponse('<head><meta charset="utf-8"></head>', {
        url: 'https://map.naver.com/p/entry/place/1887843614',
      });
    }
    // The m.place sibling serves the real place name + image.
    return htmlResponse(
      '<head><meta property="og:title" content="스타벅스 강남점"><meta property="og:image" content="/place.jpg"></head>',
      { url: 'https://m.place.naver.com/place/1887843614/home' },
    );
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://naver.me/F3EkvSh3');
    assert.equal(meta?.title, '스타벅스 강남점');
    assert.equal(meta?.preview_image_url, 'https://m.place.naver.com/place.jpg');
    assert.ok(
      requested.some((u) => u === 'https://m.place.naver.com/place/1887843614/home'),
      'expected a fetch to the server-rendered place page',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('htmlHeadSummary reports meta count, og/twitter keys, and title presence', () => {
  assert.equal(htmlHeadSummary('<head></head>'), 'metas=0 og/tw=[] title=false');
  assert.equal(
    htmlHeadSummary(
      '<head><title>x</title><meta property="og:image" content="/i.jpg"><meta name="twitter:card" content="summary"><meta name="viewport" content="x"></head>',
    ),
    'metas=3 og/tw=[og:image,twitter:card] title=true',
  );
});

test('the no_title diagnostic includes a structural head summary', async () => {
  clearLogEntries();
  const originalFetch = globalThis.fetch;
  // A shell that DID carry og:image but no title — the summary must reveal it
  // so we can tell "parser/title gap" from "genuinely empty shell".
  globalThis.fetch = (async () =>
    htmlResponse('<head><meta property="og:image" content="/i.jpg"></head>', {
      url: 'https://example.com/spa',
    })) as typeof fetch;
  try {
    await fetchPageMetadata('https://example.com/spa');
    const warns = getLogEntries().filter((e) => e.level === 'warn');
    assert.ok(
      warns.some((e) => /og\/tw=\[og:image\]/.test(e.message) && /title=false/.test(e.message)),
      'expected the failure log to carry the head summary',
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearLogEntries();
  }
});

test('fetchPageMetadata records a warn diagnostic with outcomes when no preview is found', async () => {
  clearLogEntries();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string>)?.['User-Agent'] ?? '';
    // Bot gets 403; browser also fails (network error) — total failure.
    if (/StashBot/.test(ua)) {
      return { ok: false, status: 403, url: '', headers: { get: () => null } } as unknown as Response;
    }
    throw new Error('boom');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://naver.me/GmpU1du7');
    assert.equal(meta, null);
    const warns = getLogEntries().filter((e) => e.level === 'warn');
    assert.ok(
      warns.some((e) => /preview: no title/.test(e.message) && /bot=http_403/.test(e.message)),
      'expected a warn log annotated with the per-UA outcomes',
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearLogEntries();
  }
});

test('fetchPageMetadata retries as a browser when the bot gets a title-less shell', async () => {
  const originalFetch = globalThis.fetch;
  const userAgents: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const ua = (init?.headers as Record<string, string>)?.['User-Agent'] ?? '';
    userAgents.push(ua);
    return /StashBot/.test(ua)
      ? htmlResponse('<head><meta charset="utf-8"></head>') // content-free shell, no title
      : htmlResponse('<head><meta property="og:title" content="Real title"></head>');
  }) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://naver.me/GmpU1du7');
    assert.equal(meta?.title, 'Real title');
    assert.equal(userAgents.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata resolves relative URLs against the final redirected URL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    // naver.me short links 302 to the real article; resolve against that.
    htmlResponse('<head><meta property="og:image" content="/img/cover.jpg"></head>', {
      url: 'https://m.blog.naver.com/someblog/12345',
    })) as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://naver.me/GmpU1du7');
    assert.equal(meta?.preview_image_url, 'https://m.blog.naver.com/img/cover.jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

// --- Response body size cap (Sentry STASH-3C) --------------------------------
// `arrayBuffer()` materializes the WHOLE body before any JS-side slice, so a
// server that ignores our Range header could allocate its full size inside the
// native fetch pump — during a 500+ bookmark import that ran the Android heap
// out (`OutOfMemoryError` in `okio.Buffer.readByteArray`). These pin the fix:
// the reader must stop pulling once it has the head it parses, and a body it
// cannot stream must be refused rather than buffered.

/** A streaming Response stub that would emit `chunks` bytes forever. */
function streamingResponse(head: string, opts: { chunkSize?: number } = {}) {
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  const headBytes = new TextEncoder().encode(head);
  const state = { reads: 0, cancelled: false };
  const response = {
    ok: true,
    url: 'https://example.com/huge',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null,
    },
    arrayBuffer: async () => {
      throw new Error('arrayBuffer must not be used when the body streams');
    },
    body: {
      getReader: () => ({
        read: async () => {
          state.reads += 1;
          if (state.reads === 1) return { done: false, value: headBytes };
          // An effectively endless body: the cap is the only thing that stops it.
          return { done: false, value: new Uint8Array(chunkSize) };
        },
        cancel: async () => {
          state.cancelled = true;
        },
      }),
    },
  } as unknown as Response;
  return { response, state };
}

test('fetchPageMetadata stops reading a huge streamed body at the head cap and cancels', async () => {
  const originalFetch = globalThis.fetch;
  const { response, state } = streamingResponse(
    '<html><head><title>Huge page</title></head><body>',
  );
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://example.com/huge');
    assert.equal(meta?.title, 'Huge page');
    // 512 KB cap / 64 KB chunks = 8 chunks, plus the head chunk. The point is
    // that it terminates at all — an unbounded read never returns.
    assert.ok(state.reads <= 10, `pulled ${state.reads} chunks, expected the cap to stop it`);
    assert.equal(state.cancelled, true, 'the reader must be cancelled so the native pump stops');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata refuses an oversized body it cannot stream instead of buffering it', async () => {
  const originalFetch = globalThis.fetch;
  let bufferedBytes = false;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      url: 'https://example.com/big',
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === 'content-type') return 'text/html; charset=utf-8';
          if (key === 'content-length') return String(8 * 1024 * 1024);
          return null;
        },
      },
      arrayBuffer: async () => {
        bufferedBytes = true;
        return new ArrayBuffer(8 * 1024 * 1024);
      },
    }) as unknown as Response) as unknown as typeof fetch;
  clearLogEntries();
  try {
    const meta = await fetchPageMetadata('https://example.com/big');
    assert.equal(meta, null);
    assert.equal(bufferedBytes, false, 'the oversized body must never be materialized');
    const logged = getLogEntries().map((entry) => entry.message).join('\n');
    assert.match(logged, /too_large:8388608/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchPageMetadata still buffers a normal non-streaming body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => htmlResponse(sampleHtml)) as unknown as typeof fetch;
  try {
    const meta = await fetchPageMetadata('https://example.com/small');
    assert.equal(meta?.title, 'Local-first software');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
