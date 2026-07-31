-- Hourly-bucketed admin visibility into both quota layers, extending the
-- single-row 24h-aggregate views in 20260724110000_admin_ai_queue_views.sql
-- with a per-hour trend. A rolled-up 24h total can't distinguish "steady
-- trickle" from "solid wall of rate_limited for the last 8 hours" — exactly
-- the shape that was previously only visible by hand-running bucket-by-hour
-- SQL to diagnose the Gemini free-tier saturation behind the bli9833 backlog.
-- Same admin-only pattern as the existing views: SQL-editor / MCP only,
-- grants revoked from anon/authenticated.

-- Google/provider-side quota health per hour, from ai_enrichment_calls. A
-- sustained run of rate_limited_calls near total_calls is Gemini's
-- project-wide free-tier cap (15 req/min, 1,000/day) being saturated — a
-- different bottleneck than the app's own per-user cap below, and one that
-- raising v_day_limit does nothing to relieve.
-- successful_calls_since_pacific_reset / pacific_reset_at answer "is Google's
-- 1,000/day RPD cap actually the bottleneck, or is it the 15/min burst cap
-- instead (which a low since-reset total alongside heavy rate_limited counts
-- would indicate)". This is NOT a trailing/rolling 24h window — Gemini's RPD
-- quota resets at a fixed instant, midnight Pacific time (confirmed against
-- https://ai.google.dev/gemini-api/docs/rate-limits: "Requests per day (RPD)
-- quotas reset at midnight Pacific time"), so the correct comparison is the
-- count since that fixed reset point, not a continuously-sliding sum. Same
-- value repeated on every row (computed once, cross-joined) alongside the
-- hour-by-hour breakdown for context.
create or replace view public.admin_google_quota_hourly as
with pacific_reset as (
  select date_trunc('day', now() at time zone 'America/Los_Angeles')
           at time zone 'America/Los_Angeles' as reset_at
),
daily_total as (
  select count(*) as successful_calls_since_pacific_reset
  from public.ai_enrichment_calls c, pacific_reset
  where not c.degraded and c.created_at >= pacific_reset.reset_at
),
hourly as (
  select
    hour,
    count(c.id) as total_calls,
    count(c.id) filter (where not c.degraded) as successful_calls,
    count(c.id) filter (where c.degraded_reason = 'rate_limited') as rate_limited_calls,
    count(c.id) filter (where c.degraded_reason = 'timeout') as timeout_calls,
    count(c.id) filter (where c.degraded_reason = 'provider_error') as provider_error_calls,
    count(distinct c.user_id) as distinct_users,
    sum(c.total_tokens) as total_tokens_spent
  from generate_series(
      date_trunc('hour', now() - interval '23 hours'),
      date_trunc('hour', now()),
      interval '1 hour'
    ) as hour
  left join public.ai_enrichment_calls c
    on date_trunc('hour', c.created_at) = hour
  group by hour
)
select
  hourly.hour,
  hourly.total_calls,
  hourly.successful_calls,
  hourly.rate_limited_calls,
  hourly.timeout_calls,
  hourly.provider_error_calls,
  hourly.distinct_users,
  hourly.total_tokens_spent,
  daily_total.successful_calls_since_pacific_reset,
  pacific_reset.reset_at as pacific_reset_at
from hourly
cross join daily_total
cross join pacific_reset
order by hourly.hour;

-- App-level per-user quota consumption per hour, from ai_enrichment_requests
-- (the sliding-window ledger request_ai_enrichment_slot() writes to). Shows
-- how close aggregate demand is running to the per-user hourly/daily caps,
-- independent of whether Google's own quota (above) is the real bottleneck.
create or replace view public.admin_user_quota_hourly as
select
  hour,
  count(r.id) as request_count,
  count(distinct r.user_id) as distinct_users
from generate_series(
    date_trunc('hour', now() - interval '23 hours'),
    date_trunc('hour', now()),
    interval '1 hour'
  ) as hour
left join public.ai_enrichment_requests r
  on date_trunc('hour', r.created_at) = hour
group by hour
order by hour;

revoke all on public.admin_google_quota_hourly from public, anon, authenticated;
revoke all on public.admin_user_quota_hourly from public, anon, authenticated;
