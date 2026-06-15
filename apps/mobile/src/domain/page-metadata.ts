/**
 * Fetch + parse real page metadata (OpenGraph/Twitter cards, <title>,
 * favicon). The parser is pure and regex-based — React Native has no DOM —
 * and the fetcher resolves to null on any failure so enrichment can always
 * fall back to URL-derived metadata.
 */

const FETCH_TIMEOUT_MS = 8000;
/** Metadata lives in <head>; don't parse unbounded documents. */
const MAX_HTML_BYTES = 512 * 1024;

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
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      return null;
    }
    const html = await response.text();
    // Redirects may have moved us; resolve relative URLs against the final URL.
    return parsePageMetadata(html, response.url || url);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      headers: { Accept: 'application/json' },
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
