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
