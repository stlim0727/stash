// How an ai-enrich request authenticates.
//
// Two callers reach this function:
//
//  1. The mobile app — forwards the user's Supabase JWT in `Authorization`.
//     PostgREST runs as that user and RLS scopes every read/write. The function
//     holds no elevated privilege on this path (unchanged, pre-existing).
//
//  2. The database trigger (`dispatch_ai_enrichment`, see the
//     `..._ai_enrich_server_trigger.sql` migration) — fires server-side once a
//     bookmark's metadata settles, with no user session to forward. It proves
//     itself with a shared secret header (`x-ai-enrich-secret`) and the function
//     then acts with the service-role key, scoping work to the bookmark's owner
//     by `user_id` instead of RLS.
//
// This module is the pure, branch-only decision so it can be unit-tested under
// the Node lane without booting the Deno handler. It performs NO I/O.

export type CallerAuth =
  // The trusted server-trigger path: authenticated by the shared secret.
  | { kind: 'server' }
  // A normal app request: PostgREST is called with this forwarded user JWT.
  | { kind: 'user'; authorization: string }
  // Neither a valid secret nor a token — reject.
  | { kind: 'unauthorized' };

/**
 * Constant-time string comparison. A naive `===` short-circuits on the first
 * differing byte, leaking the shared secret's length/prefix to a timing
 * attacker who can call this public (verify_jwt=false) endpoint. Comparing every
 * byte regardless keeps the timing independent of where the mismatch is.
 *
 * Length is intentionally folded into the accumulator (not an early `return`)
 * so a wrong-length guess is indistinguishable from a wrong-value one.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    // charCodeAt past the end is NaN; `| 0` pins it to 0 so out-of-range
    // indexes still feed the accumulator deterministically.
    mismatch |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return mismatch === 0;
}

/**
 * Decide the caller's identity from the request headers and configured secret.
 *
 * A present `x-ai-enrich-secret` header is always treated as a server-path
 * attempt: it must match the configured secret exactly or the request is
 * rejected — it never falls through to the user path (so a bad secret can't be
 * silently downgraded). The secret takes precedence over any Authorization
 * header the trigger might also send.
 */
export function resolveCallerAuth(input: {
  authorization: string | null;
  secretHeader: string | null;
  triggerSecret: string | null;
}): CallerAuth {
  const { authorization, secretHeader, triggerSecret } = input;

  if (secretHeader !== null && secretHeader !== '') {
    if (triggerSecret && timingSafeEqual(secretHeader, triggerSecret)) {
      return { kind: 'server' };
    }
    return { kind: 'unauthorized' };
  }

  if (authorization) {
    return { kind: 'user', authorization };
  }

  return { kind: 'unauthorized' };
}

/**
 * Base64url-decode a single JWT segment to UTF-8 text. Pure and dependency-free
 * (works in both Deno and the Node test lane via `atob`). Returns null on any
 * malformed input rather than throwing.
 */
function decodeJwtSegment(segment: string): string | null {
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const binary = atob(padded);
    // atob yields a binary (latin1) string; re-decode as UTF-8 so multi-byte
    // claims survive. TextDecoder is available in Deno and modern Node.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether a forwarded `Authorization: Bearer <jwt>` belongs to an anonymous
 * Supabase session, read from the JWT's `is_anonymous` claim.
 *
 * This is a best-effort signal used only to decide how to behave when the
 * rate-limit verdict can't be obtained (fail closed for anonymous callers, open
 * for signed-in ones — see shouldFailClosedOnRateLimit). It does NOT verify the
 * signature: PostgREST already does that on the forwarded token, so a forged
 * `is_anonymous: false` would be rejected downstream regardless. If the token is
 * absent/garbled we treat the caller as anonymous (the safer default), so a
 * malformed token can't be used to dodge the fail-closed path.
 */
export function isAnonymousAuthorization(authorization: string | null): boolean {
  if (!authorization) return true;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return true;
  const payloadJson = decodeJwtSegment(parts[1]);
  if (payloadJson === null) return true;
  try {
    const claims = JSON.parse(payloadJson) as { is_anonymous?: unknown };
    // Only an explicit `is_anonymous: false` counts as signed-in; anything else
    // (true, missing, non-boolean) is treated as anonymous.
    return claims.is_anonymous !== false;
  } catch {
    return true;
  }
}

/**
 * When the rate-limit verdict cannot be obtained (RPC non-OK or threw), decide
 * whether to fail CLOSED (reject the request) or OPEN (allow it).
 *
 * The control follows the *cost anchor*, i.e. who ultimately owns the work:
 *
 * - signed-in user path  → OPEN: a real account is a weak-but-real cost anchor;
 *   a transient limiter outage shouldn't break AI suggestions for them.
 * - anonymous user path   → CLOSED: anonymous-first sign-ups mean the limiter is
 *   the only cost control, so a DB hiccup must not become an open faucet.
 * - server-trigger path   → depends on the TARGET BOOKMARK'S OWNER. The trigger
 *   fires for user-created rows carrying `bookmark.user_id`, so an anonymous
 *   user can still drive unthrottled server-path enrichment during an outage.
 *   Fail OPEN only when the owner is a real (non-anonymous) user; fail CLOSED
 *   when the owner is anonymous OR their status couldn't be determined (the
 *   safe default — `ownerIsAnonymous` undefined ⇒ closed).
 *
 * Pure decision so it can be unit-tested without booting the handler.
 *
 * @param ownerIsAnonymous Only consulted on the server path: whether the target
 *   bookmark's owner is an anonymous user. `undefined` means "couldn't be
 *   determined" and is treated as anonymous (fail closed).
 */
export function shouldFailClosedOnRateLimit(
  caller: CallerAuth,
  ownerIsAnonymous?: boolean,
): boolean {
  if (caller.kind === 'user') {
    return isAnonymousAuthorization(caller.authorization);
  }
  if (caller.kind === 'server') {
    // Fail open only for a confirmed real owner; anonymous or unknown → closed.
    return ownerIsAnonymous !== false;
  }
  // 'unauthorized' never reaches here (rejected earlier), but be safe: closed.
  return true;
}
