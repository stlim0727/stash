-- M12: make degraded AI enrichment visible.
-- When the ai-enrich function falls back to the deterministic heuristics
-- (no model key configured, or a live rate-limit/outage), it records that here
-- so the app can show a clear, non-error signal instead of passing heuristics
-- off as real AI. `degraded_reason` is a coarse cause: 'not_configured',
-- 'rate_limited', 'timeout', or 'provider_error'. Both default to a non-degraded
-- value so existing rows keep meaning "produced by the configured model".

alter table public.ai_enrichments
  add column if not exists degraded boolean not null default false,
  add column if not exists degraded_reason text;

-- Backfill rows produced by the heuristic fallback before this migration: the
-- edge function already saved those with model = 'dummy-v0' (no model key, or a
-- live rate-limit/outage), so they are exactly the silently-degraded outputs the
-- new signal is meant to expose. The original cause wasn't recorded, so leave
-- degraded_reason null — the app shows the generic "basic suggestions" note when
-- the reason is null. Idempotent: the column defaults to false, so this only
-- touches existing dummy rows and is a no-op on re-run.
--
-- updated_at is bumped to now() on purpose: pull sync is incremental by an
-- updated_at watermark (overlapped by only ~5 min for clock skew), so without
-- this the changed rows would sit far behind every already-synced device's
-- watermark and never be re-pulled — the backfill would only ever reach a client
-- doing a full resync. Bumping it lands the change in the next incremental pull.
update public.ai_enrichments
  set degraded = true, updated_at = now()
  where model = 'dummy-v0' and degraded = false;
