-- M12: make degraded AI enrichment visible.
-- When the ai-enrich function falls back to the deterministic heuristics
-- (no model key configured, or a live rate-limit/outage), it records that here
-- so the app can show a clear, non-error signal instead of passing heuristics
-- off as real AI. `degraded_reason` is a coarse cause: 'not_configured',
-- 'rate_limited', 'timeout', or 'provider_error'. Both default to a non-degraded
-- value so existing rows keep meaning "produced by the configured model".

-- New rows only — we intentionally do NOT backfill historical model = 'dummy-v0'
-- rows. Backfilling would require bumping updated_at to clear the pull-sync
-- watermark, which re-pulls those rows and lets the enrichment pull path (an
-- unconditional upsert) overwrite a device's local 'stale' enrichment marker,
-- hiding the out-of-date warning. Historical fallback rows instead surface the
-- degraded note on their next re-enrichment or a full resync.
alter table public.ai_enrichments
  add column if not exists degraded boolean not null default false,
  add column if not exists degraded_reason text;
