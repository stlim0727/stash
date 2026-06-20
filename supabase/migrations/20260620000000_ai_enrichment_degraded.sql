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
