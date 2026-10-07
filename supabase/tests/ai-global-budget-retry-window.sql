-- Isolated fixture; all rows and settings are rolled back. No model calls.
begin;
select pg_advisory_xact_lock(hashtextextended('keepory:ai-global-budget', 0));
delete from public.ai_budget_reservations;
update public.ai_runtime_limits set enabled=true, hourly_call_limit=1, daily_call_limit=10;
insert into public.ai_budget_reservations(created_at) values(now()-interval '15 minutes');
set local role service_role;
do $$
declare verdict jsonb;
begin
  verdict := public.reserve_ai_enrichment_budget();
  if verdict->>'allowed' <> 'false' or (verdict->>'retry_after')::int <> 2700 then
    raise exception 'FAIL: hourly window deadline %', verdict;
  end if;
  if (select count(*) from public.ai_budget_reservations) <> 1 then
    raise exception 'FAIL: denied reservation changed ledger';
  end if;
end $$;
reset role;
delete from public.ai_budget_reservations;
update public.ai_runtime_limits set hourly_call_limit=10, daily_call_limit=1;
insert into public.ai_budget_reservations(created_at) values(now()-interval '6 hours');
set local role service_role;
do $$
declare verdict jsonb;
begin
  verdict := public.reserve_ai_enrichment_budget();
  if verdict->>'allowed' <> 'false' or (verdict->>'retry_after')::int <> 64800 then
    raise exception 'FAIL: daily window deadline %', verdict;
  end if;
end $$;
reset role;
-- Both windows bind; wait for the later deadline.
update public.ai_runtime_limits set hourly_call_limit=1, daily_call_limit=2;
insert into public.ai_budget_reservations(created_at) values(now()-interval '15 minutes');
set local role service_role;
do $$
declare verdict jsonb;
begin
  verdict := public.reserve_ai_enrichment_budget();
  if (verdict->>'retry_after')::int <> 64800 then raise exception 'FAIL: overlapping deadlines %', verdict; end if;
end $$;
reset role;
-- Expired rows are discarded and admission resumes with one new reservation.
update public.ai_budget_reservations set created_at=now()-interval '25 hours';
set local role service_role;
do $$
begin
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'true' then raise exception 'FAIL: expiry did not restore admission'; end if;
  if (select count(*) from public.ai_budget_reservations) <> 1 then raise exception 'FAIL: expired ledger cleanup'; end if;
end $$;
reset role;
delete from public.ai_budget_reservations;
update public.ai_runtime_limits set hourly_call_limit=0;
set local role service_role;
do $$
begin
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'false' then raise exception 'FAIL: zero cap'; end if;
end $$;
reset role;
do $$
begin
  if has_function_privilege('anon','public.reserve_ai_enrichment_budget()','execute')
    or has_function_privilege('authenticated','public.reserve_ai_enrichment_budget()','execute')
    or not has_function_privilege('service_role','public.reserve_ai_enrichment_budget()','execute') then
    raise exception 'FAIL: admission RPC grants';
  end if;
end $$;
rollback;
