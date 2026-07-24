-- Admin-only visibility into the AI enrichment overflow queue (STASH #578) and
-- recent enrichment call activity, for manually checking "is the queue backing
-- up because of quota exhaustion" without a dedicated admin UI.
--
-- Not exposed to the app or its clients: these views live in `public` (for
-- convenient ad-hoc querying via the SQL editor / MCP tooling) but grants are
-- explicitly revoked from `anon` and `authenticated`, matching the existing
-- service-role-only pattern in this schema (e.g. claim_pending_ai_enrichment_batch
-- in 20260723150000_pending_ai_enrichment_queue.sql). Only a direct
-- postgres/service-role connection (Supabase Studio SQL editor, the Supabase
-- MCP tooling) can read them — never PostgREST/anon/authenticated.

create or replace view public.admin_ai_queue_summary as
select
  count(*) filter (where status = 'pending') as pending_count,
  count(*) filter (where status = 'processing') as processing_count,
  count(*) filter (where status = 'failed') as failed_count,
  count(distinct user_id) filter (where status in ('pending', 'processing')) as backlogged_users,
  min(created_at) filter (where status = 'pending') as oldest_pending_at,
  max(attempts) filter (where status in ('pending', 'processing')) as max_attempts_in_flight
from public.pending_ai_enrichment;

create or replace view public.admin_ai_queue_by_user as
select
  user_id,
  count(*) filter (where status = 'pending') as pending_count,
  count(*) filter (where status = 'processing') as processing_count,
  count(*) filter (where status = 'failed') as failed_count,
  min(created_at) as oldest_created_at,
  max(attempts) as max_attempts
from public.pending_ai_enrichment
group by user_id
order by pending_count desc, oldest_created_at asc;

-- Recent enrichment call activity (last 24h), to see how often the
-- synchronous path is actually hitting the rate limiter / degrading, not just
-- how big the overflow queue currently is.
create or replace view public.admin_ai_enrichment_activity_24h as
select
  count(*) as total_calls,
  count(*) filter (where degraded) as degraded_calls,
  count(*) filter (where degraded_reason = 'rate_limited') as rate_limited_calls,
  count(*) filter (where degraded_reason = 'timeout') as timeout_calls,
  count(*) filter (where degraded_reason = 'provider_error') as provider_error_calls,
  count(distinct user_id) as distinct_users,
  sum(total_tokens) as total_tokens_spent
from public.ai_enrichment_calls
where created_at > now() - interval '24 hours';

revoke all on public.admin_ai_queue_summary from public, anon, authenticated;
revoke all on public.admin_ai_queue_by_user from public, anon, authenticated;
revoke all on public.admin_ai_enrichment_activity_24h from public, anon, authenticated;
