-- One project-wide admission ledger, shared by synchronous, trigger and worker
-- calls. Reservations are conservative: failures/refunds do not restore the
-- global budget, so provider outages cannot create an unlimited retry faucet.
create table public.ai_runtime_limits (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  hourly_call_limit integer not null default 60 check (hourly_call_limit between 0 and 10000),
  daily_call_limit integer not null default 1000 check (daily_call_limit between 0 and 100000),
  updated_at timestamptz not null default now()
);
create table public.ai_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create index ai_budget_reservations_created_at_idx on public.ai_budget_reservations(created_at);
alter table public.ai_runtime_limits enable row level security;
alter table public.ai_budget_reservations enable row level security;
revoke all on public.ai_runtime_limits, public.ai_budget_reservations from public, anon, authenticated;
grant select, insert, update on public.ai_runtime_limits to service_role;
grant select, insert, delete on public.ai_budget_reservations to service_role;
insert into public.ai_runtime_limits(id) values (true);

create or replace function public.reserve_ai_enrichment_budget()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  config public.ai_runtime_limits%rowtype;
  hour_count bigint;
  day_count bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('keepory:ai-global-budget', 0));
  select * into config from public.ai_runtime_limits where id = true for update;
  if not found or not config.enabled then
    return jsonb_build_object('allowed', false, 'reason', 'ai_paused', 'retry_after', 60);
  end if;
  delete from public.ai_budget_reservations where created_at < now() - interval '1 day';
  select count(*), count(*) filter (where created_at >= now() - interval '1 hour')
  into day_count, hour_count from public.ai_budget_reservations;
  if day_count >= config.daily_call_limit or hour_count >= config.hourly_call_limit then
    return jsonb_build_object('allowed', false, 'reason', 'global_budget_limit', 'retry_after', 60);
  end if;
  insert into public.ai_budget_reservations default values;
  return jsonb_build_object('allowed', true);
end;
$$;
revoke all on function public.reserve_ai_enrichment_budget() from public, anon, authenticated;
grant execute on function public.reserve_ai_enrichment_budget() to service_role;
