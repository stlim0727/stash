/**
 * Fetch + parse real page metadata (OpenGraph/Twitter cards, <title>,
 * favicon). The parser is pure and regex-based — React Native has no DOM —
 * and the fetcher resolves to null on any failure so enrichment can always
 * fall back to URL-derived metadata.
 */

const FETCH_TIMEOUT_MS = 8000;
/** Metadata lives in <head>; don't parse unbounded documents. */
const MAX_HTML_BYTES = 512 * 1024;

/**
 * An honest, identifiable User-Agent. A header-less fetch looks like an
 * anonymous bot, and some sites — notably Naver and other large CJK portals —
 * answer those with a 403 or a content-free JS shell, leaving their OpenGraph
 * tags unreachable (the preview then fell back to the bare URL slug, e.g. a
 * `naver.me/<code>` short link yielded the code as the title and no image).
 *
 * Rather than impersonate a browser, we identify ourselves the way reputable
 * link-unfurlers do (facebookexternalhit / Slackbot / Twitterbot): a
 * `Mozilla/5.0 (compatible; …)` token plus the app name and a URL, so any site
 * admin can recognize — and, if they wish, block — the fetcher. Sites that gate
 * previews strictly on a real browser UA may still refuse this; that is their
 * choice and enrichment degrades gracefully to URL-derived metadata.
 */
const REQUEST_USER_AGENT =
  'Mozilla/5.0 (compatible; StashBot/1.0; +https://github.com/stlim0727/stash) link-preview fetcher';

const HTML_HEADERS: Record<string, string> = {
  'User-Agent': REQUEST_USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en;q=0.9,*;q=0.5',
};

const OEMBED_HEADERS: Record<string, string> = {
  'User-Agent': REQUEST_USER_AGENT,
  Accept: 'application/json',
};

export interface FetchedMetadata {
  title?: string;
  site_name?: string;
  favicon_url?: string;
  preview_image_url?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function clean(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const decoded = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return decoded || undefined;
}

function resolveHref(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3]) : undefined;
}

export function parsePageMetadata(html: string, baseUrl: string): FetchedMetadata {
  const head = html.slice(0, MAX_HTML_BYTES);

  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attribute(tag, '(?:property|name)') ?? '').toLowerCase();
    const content = clean(attribute(tag, 'content'));
    if (key && content && !meta.has(key)) {
      meta.set(key, content);
    }
  }

  let favicon: string | undefined;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase();
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) {
      continue;
    }
    const href = attribute(tag, 'href');
    if (href) {
      favicon = resolveHref(href, baseUrl);
      if (favicon) {
        break;
      }
    }
  }

  const titleTag = clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const image = meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image');

  return {
    title: meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag,
    site_name: meta.get('og:site_name'),
    favicon_url: favicon,
    preview_image_url: image ? resolveHref(image, baseUrl) : undefined,
  };
}

/**
 * Fetches a page and extracts its metadata. Resolves to null on timeout,
 * non-OK responses, non-HTML content, or any other failure — never throws.
 */
export async function fetchPageMetadata(url: string): Promise<FetchedMetadata | null> {
  // Some sites (YouTube especially) serve a consent/JS-only shell to bare
  // fetches, so scraping yields a useless "YouTube" title and logo. Prefer
  // their oEmbed endpoint, which returns the real title + thumbnail; fall back
  // to HTML scraping when there's no oEmbed provider or it fails.
  const oembed = oembedEndpoint(url);
  if (oembed) {
    const fromOembed = await fetchOembed(oembed);
    if (fromOembed?.title) {
      return fromOembed;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: HTML_HEADERS,
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      return null;
    }
    // Read raw bytes and decode with the page's real charset. Many Korean/CJK
    // sites serve legacy encodings (EUC-KR, Shift_JIS, …), often declared only
    // in a <meta> tag, so decoding as UTF-8 produces mojibake.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const charset = detectCharset(contentType, bytes);
    const html = await decodeHtml(bytes, charset);
    // Redirects may have moved us; resolve relative URLs against the final URL.
    return parsePageMetadata(html, response.url || url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decode raw HTML bytes for the detected charset. UTF-8 (the overwhelming
 * majority of pages) uses the built-in decoder, so the common path never pulls
 * in the heavy legacy encoding tables; only legacy charsets (euc-kr, shift_jis,
 * …) lazy-load `legacy-decoder`. If that chunk can't be loaded, fall back to a
 * best-effort UTF-8 decode rather than losing all metadata.
 */
async function decodeHtml(bytes: Uint8Array, charset: string): Promise<string> {
  if (charset === 'utf-8') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  try {
    const { decodeBytes } = await import('./legacy-decoder.ts');
    return decodeBytes(bytes, charset);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Determine a page's charset from the HTTP Content-Type header, falling back to
 * a `<meta charset>` / `<meta http-equiv>` declaration sniffed from the first
 * bytes (which are ASCII-compatible across these encodings). Returns a WHATWG
 * label suitable for the decoder; defaults to utf-8.
 */
export function detectCharset(
  contentType: string | null | undefined,
  headBytes: Uint8Array,
): string {
  const fromHeader = contentType?.match(/charset\s*=\s*["']?([^"';,\s]+)/i)?.[1];
  if (fromHeader) {
    return normalizeCharsetLabel(fromHeader);
  }
  let ascii = '';
  const limit = Math.min(headBytes.length, 2048);
  for (let i = 0; i < limit; i += 1) {
    ascii += String.fromCharCode(headBytes[i]);
  }
  const meta =
    ascii.match(/<meta[^>]+charset\s*=\s*["']?([\w:-]+)/i)?.[1] ??
    ascii.match(/charset\s*=\s*["']?([\w:-]+)/i)?.[1];
  return normalizeCharsetLabel(meta ?? 'utf-8');
}

/** Map common charset aliases to the WHATWG label the decoder understands. */
export function normalizeCharsetLabel(label: string): string {
  const c = label.trim().toLowerCase();
  const aliases: Record<string, string> = {
    'euc-kr': 'euc-kr',
    euckr: 'euc-kr',
    cp949: 'euc-kr',
    uhc: 'euc-kr',
    ms949: 'euc-kr',
    'windows-949': 'euc-kr',
    'x-windows-949': 'euc-kr',
    'ks_c_5601-1987': 'euc-kr',
    ksc5601: 'euc-kr',
    korean: 'euc-kr',
    shift_jis: 'shift_jis',
    'shift-jis': 'shift_jis',
    sjis: 'shift_jis',
    'x-sjis': 'shift_jis',
    cp932: 'shift_jis',
    ms932: 'shift_jis',
    'windows-31j': 'shift_jis',
    'euc-jp': 'euc-jp',
    eucjp: 'euc-jp',
    gb2312: 'gbk',
    gbk: 'gbk',
    cp936: 'gbk',
    ms936: 'gbk',
    gb18030: 'gb18030',
    big5: 'big5',
    cp950: 'big5',
    'iso-8859-1': 'windows-1252',
    latin1: 'windows-1252',
    'windows-1252': 'windows-1252',
    cp1252: 'windows-1252',
  };
  return aliases[c] ?? (c || 'utf-8');
}

/**
 * Extract a YouTube video id from watch / youtu.be / shorts / embed URLs.
 * Returns null for anything that isn't a recognizable YouTube video URL.
 */
export function youtubeVideoId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const isYouTubeHost = host === 'youtube.com' || host === 'youtube-nocookie.com';

  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id || null;
  }
  if (isYouTubeHost) {
    const v = parsed.searchParams.get('v');
    if (v) {
      return v;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'shorts' || segments[0] === 'embed' || segments[0] === 'live') {
      return segments[1] ?? null;
    }
  }
  return null;
}

/**
 * The oEmbed JSON endpoint for a URL, or null when there's no known provider.
 * YouTube ids are normalized to a canonical watch URL so shorts/youtu.be all
 * resolve.
 */
export function oembedEndpoint(rawUrl: string): string | null {
  const youtubeId = youtubeVideoId(rawUrl);
  if (youtubeId) {
    const watch = `https://www.youtube.com/watch?v=${youtubeId}`;
    return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`;
  }
  return null;
}

interface OembedResponse {
  title?: unknown;
  provider_name?: unknown;
  thumbnail_url?: unknown;
}

/** Map an oEmbed JSON payload to our metadata shape. */
export function parseOembed(json: OembedResponse): FetchedMetadata {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    title: str(json.title),
    site_name: str(json.provider_name),
    preview_image_url: str(json.thumbnail_url),
    // favicon is left to URL-derived metadata (origin/favicon.ico).
  };
}

async function fetchOembed(endpoint: string): Promise<FetchedMetadata | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: OEMBED_HEADERS,
    });
    if (!response.ok) {
      return null;
    }
    return parseOembed((await response.json()) as OembedResponse);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
