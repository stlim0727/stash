/**
 * Basic URL normalization and validation for manual bookmark entry.
 * Real canonicalization and hashing arrive with metadata enrichment.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (!parsed.hostname.includes('.')) {
    return null;
  }

  return parsed.toString();
}

/**
 * Pulls the first usable web URL out of arbitrary shared text. Share sheets
 * often hand over a string like "Great read https://example.com/x" rather
 * than a bare URL, so try a direct normalize first, then scan for an
 * embedded http(s) link.
 */
export function extractFirstUrl(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  const direct = normalizeUrl(input);
  if (direct) {
    return direct;
  }

  const match = input.match(/https?:\/\/[^\s]+/i);
  if (match) {
    // Strip trailing punctuation commonly appended by sharing menus or browser URL bars
    // (e.g. trailing periods, commas, closing parentheses, brackets, or quotes).
    const cleaned = match[0].replace(/[.,;:)\]!?"']$/, '');
    return normalizeUrl(cleaned);
  }
  return null;
}

/**
 * Known tracking/analytics query parameters that don't identify content, so
 * stripping them lets `?utm_source=x` and the clean URL dedupe to one bookmark.
 * Any `utm_*` param is also dropped (prefix match below).
 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'yclid',
  'msclkid',
  'mc_eid',
  'mc_cid',
  'igshid',
  'igsh',
  'mkt_tok',
  'vero_id',
  '_hsenc',
  '_hsmi',
  'oly_anon_id',
  'oly_enc_id',
  'ref',
  'ref_src',
  'ref_url',
  'spm',
  'scm',
]);

/**
 * Hosts where the `si` query param is a share-source tracking token rather than
 * content-identifying. YouTube (and the `youtu.be` / `share.google` share
 * links) append `?si=…` to every "Share" action, so the same video re-shared
 * twice would otherwise produce two dedupe keys. Scoped to these hosts on
 * purpose: `si` is a short, generic param name that other sites may use
 * meaningfully, so it is not safe to strip globally.
 */
function stripsShareSi(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'youtu.be' ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'share.google'
  );
}

/**
 * Best-effort canonical form for deduplication. Conservative on purpose — only
 * changes that are safe across the web: drop the fragment and known tracking
 * params, sort the remaining query, and trim a trailing slash on non-root
 * paths. Host/scheme casing is already normalized by `URL`. Returns the input
 * unchanged if it can't be parsed. Does NOT strip `www.` (can be a different
 * host) — that's left to enrichment resolving a real canonical URL.
 */
export function canonicalizeUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  parsed.hash = '';

  const dropSi = stripsShareSi(parsed.hostname);
  const drop: string[] = [];
  parsed.searchParams.forEach((_value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower) || (dropSi && lower === 'si')) {
      drop.push(key);
    }
  });
  for (const key of drop) {
    parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}
