-- Forward migration for databases where ai_global_budget is already applied.
-- Preserve admission caps, serialization, ledger and service-only execution.
create or replace function public.reserve_ai_enrichment_budget()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  config public.ai_runtime_limits%rowtype;
  hour_count bigint;
  day_count bigint;
  earliest_hour timestamptz;
  earliest_day timestamptz;
  delay_seconds integer := 60;
begin
  perform pg_advisory_xact_lock(hashtextextended('keepory:ai-global-budget', 0));
  select * into config from public.ai_runtime_limits where id = true for update;
  if not found or not config.enabled then
    return jsonb_build_object('allowed', false, 'reason', 'ai_paused', 'retry_after', 60);
  end if;
  delete from public.ai_budget_reservations where created_at < now() - interval '1 day';
  select count(*),
         count(*) filter (where created_at >= now() - interval '1 hour'),
         min(created_at),
         min(created_at) filter (where created_at >= now() - interval '1 hour')
  into day_count, hour_count, earliest_day, earliest_hour
  from public.ai_budget_reservations;
  if day_count >= config.daily_call_limit or hour_count >= config.hourly_call_limit then
    if day_count >= config.daily_call_limit and earliest_day is not null then
      delay_seconds := greatest(delay_seconds, ceil(extract(epoch from (earliest_day + interval '1 day' - now())))::integer);
    end if;
    if hour_count >= config.hourly_call_limit and earliest_hour is not null then
      delay_seconds := greatest(delay_seconds, ceil(extract(epoch from (earliest_hour + interval '1 hour' - now())))::integer);
    end if;
    return jsonb_build_object('allowed', false, 'reason', 'global_budget_limit', 'retry_after', greatest(delay_seconds, 60));
  end if;
  insert into public.ai_budget_reservations default values;
  return jsonb_build_object('allowed', true);
end;
$$;
revoke all on function public.reserve_ai_enrichment_budget() from public, anon, authenticated;
grant execute on function public.reserve_ai_enrichment_budget() to service_role;
