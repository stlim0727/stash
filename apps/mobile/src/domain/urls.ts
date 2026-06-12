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
  return match ? normalizeUrl(match[0]) : null;
}
