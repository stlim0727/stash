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
