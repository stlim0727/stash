/**
 * Fetch + parse real page metadata (OpenGraph/Twitter cards, <title>,
 * favicon). The parser is pure and regex-based — React Native has no DOM —
 * and the fetcher resolves to null on any failure so enrichment can always
 * fall back to URL-derived metadata.
 */

// Relative .ts import (not the @ alias) so Node's test runner can resolve it.
import { recordLog } from '../observability/log-buffer.ts';

const FETCH_TIMEOUT_MS = 8000;
/** Metadata lives in <head>; don't parse unbounded documents. */
const MAX_HTML_BYTES = 512 * 1024;

/**
 * Our honest, identifiable User-Agent — the default. A header-less fetch looks
 * like an anonymous bot, and some sites answer those with a 403 or a
 * content-free JS shell, leaving their OpenGraph tags unreachable (the preview
 * then fell back to the bare URL slug, e.g. a `naver.me/<code>` short link
 * yielded the code as the title and no image).
 *
 * Rather than impersonate a browser up front, we identify ourselves the way
 * reputable link-unfurlers do (facebookexternalhit / Slackbot / Twitterbot): a
 * `Mozilla/5.0 (compatible; …)` token plus the app name and a URL, so any site
 * admin can recognize — and, if they wish, block — the fetcher.
 */
const BOT_USER_AGENT =
  'Mozilla/5.0 (compatible; StashBot/1.0; +https://github.com/stlim0727/stash) link-preview fetcher';

/**
 * A browser User-Agent used only as a fallback. Some portals (notably Naver and
 * other large CJK sites) gate previews strictly on a real browser UA and refuse
 * the honest bot. We retry with this *only after* such a site has actively
 * refused the honest request, so we stay transparent by default and impersonate
 * a browser solely when that is the minimum needed to coax out a preview.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function htmlHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en;q=0.9,*;q=0.5',
  };
}

const OEMBED_HEADERS: Record<string, string> = {
  'User-Agent': BOT_USER_AGENT,
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
 * The result of one HTML fetch attempt: the parsed metadata (null on any
 * failure) plus a short, log-safe `outcome` tag describing what happened
 * (`ok`, `no_title`, `http_403`, `non_html:application/json`, `error:AbortError`,
 * …) so callers can record *why* a preview could not be extracted. `finalUrl`
 * is the post-redirect URL (when we got that far), so callers can react to where
 * a short link actually landed.
 */
interface HtmlFetchResult {
  metadata: FetchedMetadata | null;
  outcome: string;
  finalUrl?: string;
}

/** Fetch and parse a page's HTML metadata with a specific User-Agent. */
async function fetchHtmlMetadata(url: string, userAgent: string): Promise<HtmlFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: htmlHeaders(userAgent),
    });
    if (!response.ok) {
      return { metadata: null, outcome: `http_${response.status}` };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      return { metadata: null, outcome: `non_html:${contentType.split(';')[0] || 'unknown'}` };
    }
    // Read raw bytes and decode with the page's real charset. Many Korean/CJK
    // sites serve legacy encodings (EUC-KR, Shift_JIS, …), often declared only
    // in a <meta> tag, so decoding as UTF-8 produces mojibake.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const charset = detectCharset(contentType, bytes);
    const html = await decodeHtml(bytes, charset);
    // Redirects may have moved us; resolve relative URLs against the final URL.
    const finalUrl = response.url || url;
    const metadata = parsePageMetadata(html, finalUrl);
    if (!metadata.title) {
      // A 200 with no parseable title is the classic "content-free JS shell".
      // Note the final URL so a redirect chain (e.g. naver.me → m.blog…) shows.
      return { metadata, outcome: `no_title@${finalUrl}`, finalUrl };
    }
    return { metadata, outcome: 'ok', finalUrl };
  } catch (err) {
    return { metadata: null, outcome: `error:${err instanceof Error ? err.name : 'unknown'}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Some pages are pure client-side SPAs whose initial HTML is a title-less shell
 * (so regex scraping yields nothing), but expose a *server-rendered* sibling
 * page with OpenGraph/`<title>` tags for link sharing. Given the URL we actually
 * landed on, return such a sibling to fetch instead, or null when there isn't a
 * known one.
 *
 * Currently handles Naver Map place entries: `map.naver.com/p/entry/place/{id}`
 * (the new SPA wrapper) → `m.place.naver.com/place/{id}/home`, which serves the
 * place name + image as OG meta. Also accepts the older direct `place.naver.com`
 * hosts.
 */
export function previewSourceUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const isNaver = host === 'naver.com' || host.endsWith('.naver.com');
  if (!isNaver) {
    return null;
  }
  // A numeric place id from either the map wrapper (/p/entry/place/{id}) or a
  // direct place host (/place/{id}/…).
  const placeId = parsed.pathname.match(/\/place\/(\d+)(?:\/|$)/)?.[1];
  if (placeId) {
    return `https://m.place.naver.com/place/${placeId}/home`;
  }
  return null;
}

/**
 * Fetches a page and extracts its metadata. Resolves to null on timeout,
 * non-OK responses, non-HTML content, or any other failure — never throws.
 *
 * Hybrid User-Agent strategy: try the honest bot UA first, and only when a site
 * refuses it — a 403/non-OK that yields null, or a content-free shell with no
 * title — retry once impersonating a browser. This keeps us transparent by
 * default and falls back to impersonation only for sites that actively gate
 * previews on a real browser UA (notably Naver and other CJK portals).
 *
 * SPA fallback: if both attempts land on a title-less shell with a known
 * server-rendered sibling (see `previewSourceUrl`, e.g. a Naver Map place), we
 * fetch that sibling for the real metadata.
 *
 * Diagnostics: the happy path (a title on the first try) is silent, but any
 * fallback or outright failure is logged. A run that yields no title at all is
 * logged at `error` level so it reaches Sentry (URL-scrubbed there; full detail
 * stays in the in-app diagnostics buffer) — that is exactly the "no proper
 * preview" symptom, annotated with the per-UA outcomes so we can see whether a
 * portal returned a 403, a shell, a redirect, or a network error.
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

  const bot = await fetchHtmlMetadata(url, BOT_USER_AGENT);
  if (bot.metadata?.title) {
    return bot.metadata;
  }
  // The honest request was refused or returned a title-less shell; try once as a
  // browser. Keep the bot result as a fallback so we never discard usable
  // partial metadata (e.g. a favicon) the browser retry can't improve on.
  const browser = await fetchHtmlMetadata(url, BROWSER_USER_AGENT);
  let result = browser.metadata ?? bot.metadata;

  // SPA shell with no title: if we landed on a page that has a server-rendered
  // sibling (e.g. a Naver Map place entry), fetch that for the real metadata.
  let spa: HtmlFetchResult | null = null;
  if (!result?.title) {
    const landedOn = browser.finalUrl ?? bot.finalUrl;
    const altUrl = landedOn ? previewSourceUrl(landedOn) : null;
    if (altUrl) {
      spa = await fetchHtmlMetadata(altUrl, BROWSER_USER_AGENT);
      if (spa.metadata?.title) {
        recordLog('info', `preview: recovered via ${altUrl} for ${url}`);
        return spa.metadata;
      }
      result = result ?? spa.metadata;
    }
  }

  if (!result?.title) {
    // Full failure: no title from any attempt. Error level → Sentry.
    const spaPart = spa ? `, spa=${spa.outcome}` : '';
    recordLog(
      'error',
      `preview: no title for ${url} (bot=${bot.outcome}, browser=${browser.outcome}${spaPart})`,
    );
  } else {
    // Recovered via the browser fallback; keep an info breadcrumb in-app.
    recordLog(
      'info',
      `preview: recovered via browser UA for ${url} (bot=${bot.outcome})`,
    );
  }
  return result;
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
