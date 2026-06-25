-- Revoke every outstanding public-API key.
--
-- The public-api external surface (issuer `api-keys` + `public-api` edge
-- functions) was built and briefly live, but for the stable v0.2.2 cut we are
-- treating it as not-yet-exposed: keys stay revoked, the Settings entry stays
-- behind Developer Mode, and the surface is documented as internal/experimental
-- (docs/api/public-api.md). Re-enabling key minting is gated on the hardening
-- track (ownership-guard defense-in-depth, per-key rate limit, CORS).
--
-- This migration was applied live on 2026-06-25 ahead of the file existing in
-- the repo; it is backfilled here so the migration history is reproducible.
-- Idempotent: re-running only touches keys that are still active.

update public.api_keys
set revoked_at = now()
where revoked_at is null;
