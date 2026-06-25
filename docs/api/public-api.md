# Public API — posture & status

Status for **v0.2.2**: **built but not exposed.** The external HTTP API exists in
the codebase and was briefly live, but for the stable cut it is treated as
internal/experimental. All issued keys are revoked, and the entry point is gated
behind Developer Mode. Do not advertise or document this as a shipped feature
until the hardening track below is closed.

## What it is

A REST surface for third-party / AI-tool access to a user's own bookmarks,
implemented as two Supabase edge functions:

- **`api-keys`** — issuer. The signed-in user mints a key (`stash_<hex>`, 32
  random bytes, shown once); the server stores only its SHA-256 hash. Reachable
  from the app at `apps/mobile/src/app/api-keys.tsx`.
- **`public-api`** — the API itself. Authenticates `Authorization: Bearer
  stash_<hex>` by hashing the token and looking up a non-revoked `api_keys` row
  to resolve the `user_id`, then performs all work under the service-role key.
  Serves a self-describing OpenAPI doc at `/public-api/openapi.json`.

Both functions run with `verify_jwt: false` and handle their own auth.

## Current posture (v0.2.2)

- **Keys revoked.** `supabase/migrations/20260625003436_revoke_all_api_keys.sql`
  revokes every outstanding key. Live state: 0 active keys.
- **Issuance denied server-side.** The `api-keys` issuer refuses to mint new
  keys unless `ENABLE_API_KEY_ISSUANCE=true` is set on the function (default:
  off, fail-closed — see `supabase/functions/api-keys/issuance.ts`). This is the
  real gate: a one-time revocation alone would not hold, since any signed-in
  user could otherwise mint a fresh key immediately. List and revoke stay
  available so existing key holders can still manage/revoke.
- **Discovery gated.** The Settings entry to mint keys is behind a client-side
  Developer Mode toggle (`apps/mobile/src/app/settings.tsx`). This gates
  discoverability, not the endpoint itself.
- **`app_config` reads scoped.** `app_config` SELECT is restricted to the single
  public startup key `min_app_version` (migration `app_config_scope_select`), so
  the table cannot leak future non-public config to anon.

All current `public-api` routes are owner-scoped (every query filters
`user_id=eq.<userId>`; tag/collection writes verify ownership first). A live
RLS isolation check (`pnpm verify:supabase`, 18 checks) confirms cross-user
list/read/write are rejected.

## Hardening gate — required before re-enabling key minting

Because the service-role path bypasses RLS, cross-tenant safety rests entirely
on per-route manual filters. Before keys are re-enabled or the API is exposed
externally, close all of:

1. **Defense-in-depth ownership guard.** `addTagsToBookmark`
   (`supabase/functions/public-api/index.ts`) does not itself verify the
   bookmark belongs to the caller — it is safe only because its current callers
   pre-verify. Add an ownership check inside the helper, plus a regression test
   asserting a forged `bookmark_id` from user A cannot be tagged by user B's key.
2. **Per-key rate limit** on `public-api` (no request ceiling today).
3. **Tighten CORS** — currently `Access-Control-Allow-Origin: *`.
4. **Document the surface** (routes, auth, error model) once the above land.

Until then, keys stay revoked, issuance stays denied server-side
(`ENABLE_API_KEY_ISSUANCE` unset), and the feature stays behind Developer Mode.
Re-enabling is a deliberate one-line flip (`ENABLE_API_KEY_ISSUANCE=true`) once
the above land.
