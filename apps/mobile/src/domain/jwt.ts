/**
 * Minimal, dependency-free JWT payload decoder — extracts only the `sub`
 * claim, for diagnosing STASH-4D/4E: does the identity Postgres's `auth.uid()`
 * actually resolves from the access token match the client session object's
 * `user.id`? The two are normally the same value carried two ways, but
 * nothing structurally guarantees it, and the session's own `user.id` field
 * is what every other diagnostic (and the RLS row's `user_id` column) relies
 * on being correct.
 *
 * No `atob`/`Buffer` dependency — Hermes doesn't reliably provide either (see
 * `supabase/oauth.ts`'s own hand-rolled base64 for the same reason). Never
 * returns or logs the raw token, only the decoded subject.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode a base64url (JWT-segment) string to UTF-8 text, or null on any
 *  malformed input. The percent-encoding trick avoids needing atob/TextDecoder. */
function base64UrlDecodeToString(segment: string): string | null {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of base64) {
    if (char === '=') {
      break;
    }
    const value = BASE64_ALPHABET.indexOf(char);
    if (value === -1) {
      return null;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return null;
  }
}

/**
 * Extract the `sub` claim from a JWT's payload segment, without verifying
 * the signature (PostgREST already does that; this is diagnostic-only —
 * never a trust boundary). Returns null for a malformed token, a payload
 * that isn't valid JSON, or a missing/non-string `sub`.
 */
export function jwtSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const json = base64UrlDecodeToString(parts[1]);
  if (json === null) {
    return null;
  }
  try {
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}
