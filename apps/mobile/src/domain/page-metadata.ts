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
 * Hard ceiling on what a *non-streaming* runtime may buffer. The streaming path
 * in `readCappedBody` stops at MAX_HTML_BYTES and never reaches this, but the
 * `arrayBuffer()` fallback has no such control — so a body declaring more than
 * this is refused outright rather than allocated (Sentry STASH-3C).
 */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

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
    // Metadata lives in <head>, so ask for only the first MAX_HTML_BYTES. A
    // server that honors ranges (GitHub Pages, most CDNs) then sends a 206 with
    // just that slice instead of the whole document — the difference between a
    // few KB and, for one reported page, a 24 MB body inlining megabytes of
    // base64 in <body>. Servers that ignore the header return the full 200 body,
    // which `readCappedBody` still bounds — it stops reading at MAX_HTML_BYTES
    // rather than letting the whole body buffer.
    Range: `bytes=0-${MAX_HTML_BYTES - 1}`,
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
 * A short, privacy-safe summary of a page's <head> for the failure diagnostic:
 * how many <meta> tags it had, which og:/twitter: *keys* were present (the key
 * names are standardized tokens, not user content), and whether a <title> tag
 * existed at all. This is what distinguishes a genuinely empty JS shell
 * (`metas=0 og/tw=[]`) from a page our parser failed to read (e.g.
 * `og/tw=[og:image] title=false` → had cards but no title) — so a failed
 * preview tells us *why* from the logs/Sentry alone, without re-capturing HTML.
 */
export function htmlHeadSummary(html: string): string {
  const head = html.slice(0, MAX_HTML_BYTES);
  const metaTags = head.match(/<meta\b[^>]*>/gi) ?? [];
  const keys: string[] = [];
  for (const tag of metaTags) {
    const key = (attribute(tag, '(?:property|name)') ?? '').toLowerCase();
    if (/^(og:|twitter:)/.test(key) && !keys.includes(key)) {
      keys.push(key);
    }
  }
  const hasTitleTag = /<title[^>]*>/i.test(head);
  return `metas=${metaTags.length} og/tw=[${keys.join(',')}] title=${hasTitleTag}`;
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

interface CappedBody {
  /** At most MAX_HTML_BYTES, ready to decode. */
  bytes: Uint8Array;
  /** Bytes actually pulled off the wire — equals `bytes.length` unless truncated. */
  read: number;
  truncated: boolean;
}

/**
 * Read at most MAX_HTML_BYTES of a response body.
 *
 * Bounding the *decode* is not enough: `response.arrayBuffer()` materializes the
 * WHOLE body before any JS-side slice can run, so a page that ignores our Range
 * header allocates its full size inside the native fetch pump. During a 500+
 * bookmark import that ran the Android heap out and crashed the app with
 * `OutOfMemoryError` in `okio.Buffer.readByteArray`, under
 * `expo.modules.fetch.NativeResponse.pumpResponseBodyStream` (Sentry STASH-3C).
 *
 * So prefer streaming: pull chunks only until we have the head we actually
 * parse, then cancel the reader — the native pump stops and the remainder of the
 * body is never allocated. Runtimes without a streaming body (the web fetch
 * polyfill, test stubs) fall back to `arrayBuffer()`, guarded by the declared
 * Content-Length so an oversized body is refused rather than buffered. Returns
 * null when the body is too large to read safely.
 */
async function readCappedBody(response: Response): Promise<CappedBody | null> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BUFFERED_BYTES) {
      return null;
    }
    const raw = new Uint8Array(await response.arrayBuffer());
    const truncated = raw.length > MAX_HTML_BYTES;
    return {
      bytes: truncated ? raw.subarray(0, MAX_HTML_BYTES) : raw,
      read: raw.length,
      truncated,
    };
  }

  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (read < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
      read += value.length;
    }
  } finally {
    // Stops the native body pump. Without it the rest of a huge body keeps
    // streaming into the buffer we just decided not to read — which is the
    // allocation that OOM'd in the first place.
    await reader.cancel().catch(() => {});
  }

  const size = Math.min(read, MAX_HTML_BYTES);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.length, size - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { bytes, read, truncated: read > MAX_HTML_BYTES };
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
    const body = await readCappedBody(response);
    if (!body) {
      const declared = response.headers.get('content-length') ?? 'unknown';
      return { metadata: null, outcome: `too_large:${declared}` };
    }
    const charset = detectCharset(contentType, body.bytes);
    const html = await decodeHtml(body.bytes, charset);
    // Redirects may have moved us; resolve relative URLs against the final URL.
    const finalUrl = response.url || url;
    const metadata = parsePageMetadata(html, finalUrl);
    if (!metadata.title) {
      // A 200 with no parseable title is the classic "content-free JS shell".
      // Note the final URL (so a redirect chain like naver.me → m.place shows)
      // and a structural head summary so the failure log says *why* on its own.
      const size = `${body.read}${body.truncated ? '+' : ''}`;
      const detail = `${htmlHeadSummary(html)} bytes=${size} ct=${contentType.split(';')[0] || 'unknown'}`;
      return { metadata, outcome: `no_title@${finalUrl} {${detail}}`, finalUrl };
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
  // Android (API 28+) blocks cleartext HTTP, so an http:// share (e.g. from an
  // app whose share payload predates its own https move) dies on-device before
  // the server's usual http→https redirect can run. Fetch the https twin
  // instead; the stored bookmark URL keeps its original scheme.
  const target = url.replace(/^http:\/\//i, 'https://');

  // Some sites (YouTube especially) serve a consent/JS-only shell to bare
  // fetches, so scraping yields a useless "YouTube" title and logo. Prefer
  // their oEmbed endpoint, which returns the real title + thumbnail; fall back
  // to HTML scraping when there's no oEmbed provider or it fails.
  let oembedOutcome: string | null = null;
  const directOembed = await fetchKnownOembedMetadata(target);
  if (directOembed.metadata?.title) {
    return directOembed.metadata;
  }
  if (directOembed.outcome) {
    oembedOutcome = directOembed.outcome;
  }

  const bot = await fetchHtmlMetadata(target, BOT_USER_AGENT);
  if (bot.metadata?.title) {
    return bot.metadata;
  }
  // The honest request was refused or returned a title-less shell; try once as a
  // browser. Keep the bot result as a fallback so we never discard usable
  // partial metadata (e.g. a favicon) the browser retry can't improve on.
  const browser = await fetchHtmlMetadata(target, BROWSER_USER_AGENT);
  let result = browser.metadata ?? bot.metadata;
  const landedOn = browser.finalUrl ?? bot.finalUrl;

  // Short links such as share.google can redirect to a known oEmbed provider
  // (notably YouTube Shorts). The original URL has no oEmbed endpoint, and the
  // redirected HTML can still be a title-less shell, so try the final URL before
  // conceding to URL-derived fallback metadata.
  if (!result?.title && landedOn && landedOn !== target) {
    const redirectedOembed = await fetchKnownOembedMetadata(landedOn);
    if (redirectedOembed.metadata?.title) {
      recordLog('info', `preview: recovered via oEmbed for ${landedOn} from ${url}`);
      return redirectedOembed.metadata;
    }
    if (redirectedOembed.outcome) {
      oembedOutcome = oembedOutcome
        ? `${oembedOutcome};redirect=${redirectedOembed.outcome}`
        : `redirect=${redirectedOembed.outcome}`;
    }
  }

  // SPA shell with no title: if we landed on a page that has a server-rendered
  // sibling (e.g. a Naver Map place entry), fetch that for the real metadata.
  let spa: HtmlFetchResult | null = null;
  if (!result?.title) {
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
    // Full failure: no title from any attempt. Warn level — enrichment is
    // fire-and-forget and no-title is expected for JS-heavy or dead-link pages,
    // so this does not warrant a Sentry error.
    const spaPart = spa ? `, spa=${spa.outcome}` : '';
    const oembedPart = oembedOutcome ? `, oembed=${oembedOutcome}` : '';
    recordLog(
      'warn',
      `preview: no title for ${url} (bot=${bot.outcome}, browser=${browser.outcome}${spaPart}${oembedPart})`,
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

async function fetchKnownOembedMetadata(
  rawUrl: string,
): Promise<{ metadata: FetchedMetadata | null; outcome: string | null }> {
  const oembed = oembedEndpoint(rawUrl);
  if (!oembed) {
    return { metadata: null, outcome: null };
  }
  const fromOembed = await fetchOembed(oembed);
  if (fromOembed?.title) {
    const videoId = youtubeVideoId(rawUrl);
    if (videoId && fromOembed.preview_image_url) {
      fromOembed.preview_image_url = await preferHiResYoutubeThumbnail(
        videoId,
        fromOembed.preview_image_url,
      );
    }
    return { metadata: fromOembed, outcome: 'ok' };
  }
  // Record why oEmbed didn't provide a title so the failure breadcrumb below
  // can pinpoint the provider (e.g. YouTube) rather than only the HTML shell:
  // `failed` = the endpoint errored/was non-OK, `no_title` = it answered but
  // carried no usable title.
  return { metadata: null, outcome: fromOembed ? 'no_title' : 'failed' };
}

/**
 * True for hosts that are known short-link wrappers around a YouTube URL
 * (currently just `share.google`, the Android share-sheet shortener) rather
 * than YouTube itself. `youtubeVideoId`/`oembedEndpoint` can't recognize
 * these directly since the video id only appears after following the
 * redirect — see `resolveKnownYoutubeShortener` below.
 */
function isKnownYoutubeShortenerHost(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '') === 'share.google';
  } catch {
    return false;
  }
}

/** Whether `checkYoutubeAvailability` can do anything useful with this URL. */
export function isYoutubeAvailabilityCandidate(rawUrl: string): boolean {
  return Boolean(youtubeVideoId(rawUrl)) || isKnownYoutubeShortenerHost(rawUrl);
}

/**
 * Follows a known shortener (`share.google`) to its final landing URL, without
 * reading the landed page's body — we only need the URL, not its content.
 * Returns null on any failure/timeout/non-shortener host.
 */
async function resolveKnownYoutubeShortener(rawUrl: string): Promise<string | null> {
  if (!isKnownYoutubeShortenerHost(rawUrl)) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(rawUrl, { redirect: 'follow', signal: controller.signal });
    return response.url || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a saved YouTube video is still available, per its oEmbed endpoint
 * (STASH-61: videos can be deleted/made private sometime after capture).
 * YouTube's oEmbed answers 404 for a deleted/nonexistent video — an
 * unambiguous confirmation the content is gone. A 401 is deliberately NOT
 * treated as unavailable: it means this app-owned, unauthenticated request
 * can't see a private video, but the signed-in owner opening the same link in
 * their own YouTube app still can — so a 401 resolves to `'unknown'` rather
 * than a false "unavailable" badge on a bookmark that's actually still
 * playable for its owner. Any other non-404 outcome (a real title, a
 * non-YouTube URL, a 5xx, a timeout, a network error) also resolves to
 * `'unknown'` rather than guessing, so a transient failure can never mislabel
 * a healthy video as unavailable. Note: a region-restricted video's oEmbed
 * typically still succeeds, so this check cannot detect that case —
 * deleted is the reliable, unambiguous subset it covers.
 *
 * Also resolves known share-link shorteners (`share.google`) to their
 * underlying YouTube URL first, so a video shared via the Android share sheet
 * still gets checked instead of silently being skipped.
 *
 * Callers are expected to invoke this on-demand (e.g. once when a bookmark's
 * Detail screen opens), never as background polling of the whole library —
 * "Capture is sacred" and privacy/battery both rule that out.
 */
export async function checkYoutubeAvailability(
  rawUrl: string,
): Promise<'available' | 'unavailable' | 'unknown'> {
  let endpoint = oembedEndpoint(rawUrl);
  if (!endpoint) {
    const resolved = await resolveKnownYoutubeShortener(rawUrl);
    endpoint = resolved ? oembedEndpoint(resolved) : null;
  }
  if (!endpoint) {
    return 'unknown';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: OEMBED_HEADERS,
    });
    if (response.status === 404) {
      return 'unavailable';
    }
    if (!response.ok) {
      return 'unknown';
    }
    const json = (await response.json()) as OembedResponse;
    return parseOembed(json).title ? 'available' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
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

/**
 * YouTube oEmbed hands back the 480×360 `hqdefault` thumbnail, which upscales
 * soft into a preview card on a 2× display. Prefer the 640×480 `sddefault`
 * (~1.5× the bytes, ≈1:1 for the card) when the video actually has one; older /
 * SD-only uploads 404 it, so fall back to the oEmbed thumbnail. `maxresdefault`
 * would ~triple the bytes for resolution the card can't show, so it isn't worth
 * fetching here. The thumbnails are served straight from YouTube's CDN, so this
 * costs no storage or egress of ours — only one HEAD during background
 * enrichment, which never blocks capture.
 */
async function preferHiResYoutubeThumbnail(videoId: string, fallback: string): Promise<string> {
  const sd = `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(sd, { method: 'HEAD', signal: controller.signal });
    return response.ok ? sd : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
