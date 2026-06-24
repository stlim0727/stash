// Pure, I/O-free request-input validation for the ai-enrich function.
//
// Edge functions are deployed per-directory and don't share an import map, so
// each one carries its own small validators rather than importing across
// function dirs. This `isUuid` is intentionally identical to
// supabase/functions/public-api/filters.ts `isUuid` — keep the two regexes in
// lockstep; do NOT let them diverge.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value is a well-formed UUID. Gate any identifier (here, the request
 * body's `bookmark_id`) before it is interpolated into an `eq.${id}` PostgREST
 * filter — on the server path the service-role key bypasses RLS, so a forged id
 * like `x&select=*&or=(...)` would otherwise smuggle arbitrary PostgREST params.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
