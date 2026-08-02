-- Codex review (PR #664) on the previous migration in this same change:
-- when BOTH the hourly and daily windows are exceeded at once, the daily
-- check runs first and returns unconditionally -- even when the daily
-- window's own retry_after would expire well BEFORE the hourly window's
-- does. Example (anonymous: 10/hour, 50/day): 40 requests about to age out
-- of the 24h window plus 10 in the last half-hour puts both v_day_count and
-- v_hour_count at their limits; the daily branch reports "resets in ~1
-- minute" when the true next allowed slot is actually ~30 minutes away,
-- gated by the still-binding hourly window.
--
-- This bug predates this migration's own accuracy fix for daily_limit's
-- retry_after (previously a flat 3600s, now computed exactly) -- but that
-- fix is exactly what makes this ordering bug newly visible and materially
-- wrong instead of a coincidental rough guess, since the UI now surfaces
-- this retry_after as a specific "resumes at HH:MM" claim (STASH-4P
-- follow-up). Fixing it here rather than deferring.
--
-- Compute both windows' retry_after whenever their count is at/over its
-- limit, and report whichever is LATER (the actually-binding constraint)
-- along with its matching reason. Same signature, same JSON shape.

create or replace function public.request_ai_enrichment_slot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_anonymous boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_hour_limit int;
  v_day_limit int;
  v_hour_count int;
  v_day_count int;
  v_oldest_in_hour timestamptz;
  v_oldest_in_day timestamptz;
  v_day_retry_after int;
  v_hour_retry_after int;
begin
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  if v_is_anonymous then
    v_hour_limit := 10;
    v_day_limit := 50;
  else
    v_hour_limit := 30;
    v_day_limit := 500;
  end if;

  delete from public.ai_enrichment_requests
   where user_id = v_user_id
     and created_at < now() - interval '1 day';

  select count(*), min(created_at)
    into v_day_count, v_oldest_in_day
    from public.ai_enrichment_requests
   where user_id = v_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at)
    into v_hour_count, v_oldest_in_hour
    from public.ai_enrichment_requests
   where user_id = v_user_id
     and created_at >= now() - interval '1 hour';

  if v_day_count >= v_day_limit then
    v_day_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_day + interval '1 day' - now())))
    )::int;
  end if;

  if v_hour_count >= v_hour_limit then
    v_hour_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
    )::int;
  end if;

  if v_day_retry_after is not null or v_hour_retry_after is not null then
    if v_hour_retry_after is null or coalesce(v_day_retry_after, 0) >= v_hour_retry_after then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'daily_limit',
        'limit', v_day_limit,
        'window', 'day',
        'retry_after', v_day_retry_after
      );
    else
      return jsonb_build_object(
        'allowed', false,
        'reason', 'hourly_limit',
        'limit', v_hour_limit,
        'window', 'hour',
        'retry_after', v_hour_retry_after
      );
    end if;
  end if;

  insert into public.ai_enrichment_requests (user_id) values (v_user_id);

  return jsonb_build_object(
    'allowed', true,
    'hour_limit', v_hour_limit,
    'hour_remaining', v_hour_limit - v_hour_count - 1,
    'day_limit', v_day_limit,
    'day_remaining', v_day_limit - v_day_count - 1
  );
end;
$$;

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
  v_oldest_in_day timestamptz;
  v_day_retry_after int;
  v_hour_retry_after int;
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

  select count(*), min(created_at)
    into v_day_count, v_oldest_in_day
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at)
    into v_hour_count, v_oldest_in_hour
    from public.ai_enrichment_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 hour';

  if v_day_count >= v_day_limit then
    v_day_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_day + interval '1 day' - now())))
    )::int;
  end if;

  if v_hour_count >= v_hour_limit then
    v_hour_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
    )::int;
  end if;

  if v_day_retry_after is not null or v_hour_retry_after is not null then
    if v_hour_retry_after is null or coalesce(v_day_retry_after, 0) >= v_hour_retry_after then
      return jsonb_build_object(
        'allowed', false,
        'reason', 'daily_limit',
        'limit', v_day_limit,
        'window', 'day',
        'retry_after', v_day_retry_after
      );
    else
      return jsonb_build_object(
        'allowed', false,
        'reason', 'hourly_limit',
        'limit', v_hour_limit,
        'window', 'hour',
        'retry_after', v_hour_retry_after
      );
    end if;
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
