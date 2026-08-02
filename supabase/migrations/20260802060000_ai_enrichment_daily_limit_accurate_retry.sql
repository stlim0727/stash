-- The daily_limit branch of request_ai_enrichment_slot() / _ai_enrichment_slot()
-- has always returned a flat, hardcoded `retry_after: 3600` ("try again in an
-- hour") regardless of when the trailing-24h window will actually free a slot
-- -- unlike the hourly_limit branch a few lines below it, which already
-- computes an accurate retry_after from the oldest request in the trailing
-- hour. A user who just burned all 500 slots in a burst (e.g. a bulk
-- reimport) would see "try again in an hour" when the real wait could be
-- close to 24 hours; a user near the tail end of their day-window would be
-- told the same "an hour" when a slot is actually about to free up any
-- second. Confirmed live via the bli9833 investigation: oldest_in_day_window
-- was exactly 24h old, so the flat 3600 happened to roughly line up, but
-- that was a coincidence, not something the function computed.
--
-- Mirrors the existing hourly pattern exactly: track the oldest row in the
-- day window (already being scanned for v_day_count) and compute retry_after
-- from it the same way. Same signature, same returned JSON shape for both
-- functions -- only the daily_limit case's retry_after value becomes
-- accurate instead of a guess.

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
  v_retry_after int;
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
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_day + interval '1 day' - now())))
    )::int;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'limit', v_day_limit,
      'window', 'day',
      'retry_after', v_retry_after
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
    v_retry_after := greatest(
      1,
      ceil(extract(epoch from (v_oldest_in_day + interval '1 day' - now())))
    )::int;
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'limit', v_day_limit,
      'window', 'day',
      'retry_after', v_retry_after
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
