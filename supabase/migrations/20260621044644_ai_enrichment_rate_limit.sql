create table if not exists public.ai_enrichment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists ai_enrichment_requests_user_created_at_idx
  on public.ai_enrichment_requests (user_id, created_at desc);

alter table public.ai_enrichment_requests enable row level security;

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

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  if v_is_anonymous then
    v_hour_limit := 10;
    v_day_limit := 50;
  else
    v_hour_limit := 30;
    v_day_limit := 200;
  end if;

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

revoke all on function public.request_ai_enrichment_slot() from public;
grant execute on function public.request_ai_enrichment_slot() to anon, authenticated;
