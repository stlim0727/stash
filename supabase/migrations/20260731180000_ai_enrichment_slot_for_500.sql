-- Restore the server-role rate-limit path at the current signed-in limit (500).
--
-- Codex's review of #656 (PR review, 2026-07-31) correctly flagged that on a
-- database built fresh from the checked-in migrations, _ai_enrichment_slot /
-- request_ai_enrichment_slot_for (20260621000000_ai_enrich_server_trigger.sql)
-- would still hardcode the old 200/day limit -- that migration's CREATE OR
-- REPLACE never got touched when #656 bumped the day limit, because #656 only
-- targeted the standalone request_ai_enrichment_slot().
--
-- The live picture is actually one step worse than that: neither
-- _ai_enrichment_slot nor request_ai_enrichment_slot_for exist in THIS
-- project's live database at all (confirmed via pg_proc) -- a later migration
-- re-created request_ai_enrichment_slot() as a standalone function and the
-- server_trigger migration's split was never actually applied here, so every
-- call site that expects request_ai_enrichment_slot_for -- the ai-enrich edge
-- function's server-trigger path and the pending_ai_enrichment batch worker's
-- claimEnrichmentQuotaSlot -- has been silently failing the RPC and falling
-- through to fail-open (batch worker) or the fail-open/closed owner-anonymity
-- logic (server trigger) ever since. In practice this means the server/worker
-- paths currently have NO real per-user rate limit at all, not a stale 200.
--
-- This migration restores both functions, matching request_ai_enrichment_slot's
-- current live limits (signed-in 500/day, 30/hour; anonymous 50/day, 10/hour)
-- exactly, so the server-trigger and batch-worker paths are rate-limited again
-- and share the same 500/day ceiling documented in cost-estimates.md instead
-- of being unbounded.

create or replace function public._ai_enrichment_slot(
  p_user_id uuid,
  p_is_anonymous boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit int;
  v_day_limit int;
  v_hour_count int;
  v_day_count int;
  v_oldest_in_hour timestamptz;
  v_retry_after int;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- Serialize the check-then-insert for THIS user so a concurrent burst can't
  -- each read the same pre-insert counts and all slip past the cap. Per-user
  -- key: different users never contend; releases at transaction end.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if p_is_anonymous then
    v_hour_limit := 10;
    v_day_limit := 50;
  else
    v_hour_limit := 30;
    v_day_limit := 500;
  end if;

  -- Opportunistically prune rows past the widest window so the ledger stays
  -- small without a separate cron job.
  delete from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at < now() - interval '1 day';

  select count(*)
    into v_day_count
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at)
    into v_hour_count, v_oldest_in_hour
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 hour';

  if v_day_count >= v_day_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'limit', v_day_limit,
      'window', 'day',
      'retry_after', 3600
    );
  end if;

  if v_hour_count >= v_hour_limit then
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
    )::int;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'hourly_limit',
      'limit', v_hour_limit,
      'window', 'hour',
      'retry_after', v_retry_after
    );
  end if;

  insert into public.ai_enrichment_requests (user_id) values (p_user_id);

  return jsonb_build_object(
    'allowed', true,
    'hour_limit', v_hour_limit,
    'hour_remaining', v_hour_limit - v_hour_count - 1,
    'day_limit', v_day_limit,
    'day_remaining', v_day_limit - v_day_count - 1
  );
end;
$$;

-- Internal only: reached through request_ai_enrichment_slot_for below, never
-- called directly by a client role.
revoke all on function public._ai_enrichment_slot(uuid, boolean) from public;

-- The server path: the edge function (service-role) names the user
-- explicitly. is_anonymous is read from auth.users; an unknown user defaults
-- to the stricter anonymous cap. service_role only -- never reachable by a
-- client role. Deliberately does NOT touch request_ai_enrichment_slot() (the
-- app path) -- that function already carries the 500 limit live.
create or replace function public.request_ai_enrichment_slot_for(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_anonymous boolean;
begin
  select coalesce(is_anonymous, true) into v_is_anonymous
    from auth.users where id = p_user_id;
  return public._ai_enrichment_slot(p_user_id, coalesce(v_is_anonymous, true));
end;
$$;

revoke all on function public.request_ai_enrichment_slot_for(uuid) from public;
grant execute on function public.request_ai_enrichment_slot_for(uuid) to service_role;
