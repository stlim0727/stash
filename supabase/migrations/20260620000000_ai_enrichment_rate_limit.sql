-- AI enrichment rate limiting.
--
-- Every received bookmark auto-fires one ai-enrich call (see the deferred
-- trigger in apps/mobile/src/store/bookmarks.tsx), and the app is
-- anonymous-first: anyone can mint an anonymous session, so the AI endpoint is
-- a cheap abuse / cost vector against the model provider's quota. The ai-enrich
-- edge function holds NO service-role key (it authorizes via the caller's
-- forwarded JWT + RLS), so the per-user throttle is enforced here in the
-- database: an append-only ledger of requests plus a SECURITY DEFINER function
-- the edge function calls before invoking the model provider.
--
-- Anonymous sessions get a stricter cap than signed-in users, since they are
-- the cheap-to-create vector. Limits are a sliding window (rolling hour + day).

create table if not exists public.ai_enrichment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_enrichment_requests_user_created_at_idx
  on public.ai_enrichment_requests (user_id, created_at desc);

-- RLS on with no policies = deny all. The table is only ever written/read
-- through the SECURITY DEFINER function below, never directly by clients.
alter table public.ai_enrichment_requests enable row level security;

-- Atomically check the caller's sliding-window usage and, if under the limit,
-- record a slot. Returns a jsonb verdict the edge function maps to 200/429.
-- SECURITY DEFINER so it can touch the ledger (which has no client policies);
-- it scopes every read/write to auth.uid(), so a caller can only ever spend
-- their own quota.
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
  v_retry_after int;
begin
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- Signed-in users get the comfortable cap; anonymous sessions a tighter one.
  if v_is_anonymous then
    v_hour_limit := 10;
    v_day_limit := 50;
  else
    v_hour_limit := 30;
    v_day_limit := 200;
  end if;

  -- Opportunistically prune rows past the widest window so the ledger stays
  -- small without a separate cron job.
  delete from public.ai_enrichment_requests
   where user_id = v_user_id
     and created_at < now() - interval '1 day';

  select count(*)
    into v_day_count
    from public.ai_enrichment_requests
   where user_id = v_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at)
    into v_hour_count, v_oldest_in_hour
    from public.ai_enrichment_requests
   where user_id = v_user_id
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
    -- Retry once the oldest in-window request ages out of the hour.
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

-- Callable by both anonymous and signed-in sessions (the function decides the
-- cap); never by the public/unauthenticated role.
revoke all on function public.request_ai_enrichment_slot() from public;
grant execute on function public.request_ai_enrichment_slot() to anon, authenticated;
