// Pure, I/O-free helpers for building PostgREST filter expressions safely.
//
// PostgREST decodes and parses the query string structurally: `,` separates
// conditions, `()` groups them, and `*`/`%` are ilike wildcards. Interpolating
// untrusted input straight into a filter therefore lets a caller break out of
// the intended expression — e.g. `q=foo),is_archived.eq.false` closes the `or(`
// group early. These helpers mirror the hardened mobile client
// (apps/mobile/src/api/bookmarks.ts) so the public API can't be tricked into a
// within-account filter bypass.
//
// Kept in their own module (no Deno/global I/O) so they can be unit-tested under
// the Node test lane without booting the edge handler.

/**
 * Strip characters with structural meaning inside a PostgREST `or=()` /
 * `ilike` expression so user input cannot corrupt the filter. Matches
 * apps/mobile/src/api/bookmarks.ts:719 exactly: `/[%*,()]/g`.
 */
export function sanitizeQuery(query: string): string {
  return query.replace(/[%*,()]/g, '');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is a well-formed UUID. Used to gate any identifier (path
 * params, query params) before it is interpolated into an `eq.${id}` filter, so
 * stray PostgREST operators (`&`, `=`, `,`, `)`) in a forged id can never inject
 * extra params/conditions.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A `collection_id` query param is only ever the literal string `'null'`
 * (meaning "uncollected") or a UUID. Anything else is rejected so it can never
 * be interpolated into `eq.${collectionId}` and inject extra filter conditions.
 */
export function isValidCollectionId(value: string): boolean {
  return value === 'null' || isUuid(value);
}

/**
 * Build the value list for a PostgREST `in.(...)` filter with each value
 * double-quoted and embedded quotes/backslashes escaped — the same shape as the
 * hardened mobile copy (apps/mobile/src/api/bookmarks.ts:180-182). Quoting keeps
 * a value containing `,` or `)` from being parsed as extra list members /
 * closing the group early.
 *
 * Backslashes are escaped FIRST, then quotes — otherwise a trailing `\` would
 * combine with our injected `\"` and let the value escape its own quote
 * (`a\"` → `"a\\""` not `"a\""`).
 */
export function inFilter(values: string[]): string {
  return `(${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')})`;
}
