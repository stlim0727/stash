-- AI summaries were removed from the enrichment product because they mostly
-- restated bookmark titles. Clear already-persisted suggestions as well, so
-- existing users do not keep seeing a proposal the provider no longer emits.
-- This is intentionally idempotent for projects where the summaries have
-- already been cleared operationally.
update public.ai_enrichments
set summary = null,
    updated_at = now()
where nullif(btrim(summary), '') is not null;
