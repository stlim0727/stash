// Shared URL handling for edge functions — the canonical/normalize logic that
// the mobile app keeps in apps/mobile/src/domain/urls.ts and that public-api
// and chat both need. Kept byte-compatible with the client so the server's
// `url_hash` (canonical URL) matches what the app computes, and the active-URL
// unique index dedupes the same way on both sides.
//
// Dependency-free and runtime-agnostic (only the standard `URL`), so it runs in
// Deno edge functions and is unit-testable under Node.

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'dclid', 'yclid', 'msclkid', 'mc_eid', 'mc_cid',
  'igshid', 'igsh', 'mkt_tok', 'vero_id', 'oly_anon_id', 'oly_enc_id',
  '_hsenc', '_hsmi', 'ref', 'ref_src', 'ref_url', 'spm', 'scm',
]);

function stripsShareSi(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'share.google';
}

/** Strip tracking params + fragment and sort the query so equivalent URLs map
 *  to one key. Returns the input unchanged if it doesn't parse as a URL. */
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
  parsed.searchParams.forEach((_v, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || TRACKING_PARAMS.has(lower) || (dropSi && lower === 'si')) {
      drop.push(key);
    }
  });
  for (const key of drop) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}

/** Validate + normalize a user-supplied URL. Rejects interior whitespace and
 *  non-http(s) schemes; adds https:// when no scheme is present. Returns null
 *  when the input can't be a saveable web URL. */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;
  return parsed.toString();
}
