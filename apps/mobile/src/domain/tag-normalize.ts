/** Collapse internal whitespace and trim — the canonical display form. */
export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * URL/identifier-safe slug for a tag or collection name. Unicode letters and
 * numbers are preserved (e.g. Korean 요리 → "요리"); only punctuation and
 * separators collapse to hyphens. Keeping non-Latin scripts is essential: a
 * `[a-z0-9]`-only slug collapses any Korean/Japanese/etc. name to '', which
 * then gets dropped at tag creation.
 */
export function slugify(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
