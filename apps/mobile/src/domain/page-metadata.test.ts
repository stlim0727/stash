import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectCharset,
  fetchPageMetadata,
  htmlHeadSummary,
  normalizeCharsetLabel,
  oembedEndpoint,
  parseOembed,
  parsePageMetadata,
  previewSourceUrl,
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
