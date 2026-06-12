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
