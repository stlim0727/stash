-- Run after access + global-budget migrations, on a test database or within
-- the explicit transaction below. Fixtures/configuration are always rolled back.
-- Never remove BEGIN/ROLLBACK when running against the linked project.
begin;
create temp table security_fixture as select
  gen_random_uuid() as user_a, gen_random_uuid() as user_b,
  gen_random_uuid() as bookmark_a, gen_random_uuid() as bookmark_b,
  gen_random_uuid() as enrichment_a;
insert into auth.users(id, aud, role, is_anonymous)
select user_a, 'authenticated', 'authenticated', true from security_fixture
union all select user_b, 'authenticated', 'authenticated', true from security_fixture;
insert into public.bookmarks(id, user_id, title, content_type, metadata_status)
select bookmark_a, user_a, 'security fixture A', 'text', 'pending' from security_fixture
union all select bookmark_b, user_b, 'security fixture B', 'text', 'pending' from security_fixture;
insert into public.ai_enrichments(id, user_id, bookmark_id)
select enrichment_a, user_a, bookmark_a from security_fixture;
grant select on security_fixture to authenticated;
select set_config('request.jwt.claim.sub', user_a::text, true),
       set_config('request.jwt.claims', jsonb_build_object('sub', user_a, 'role', 'authenticated', 'is_anonymous', true)::text, true)
from security_fixture;
set local role authenticated;
do $$
declare f record;
begin
  select * into f from security_fixture;
  begin
    insert into public.api_keys(user_id, name, key_hash) values (f.user_a, 'forged', 'fixture-hash');
    raise exception 'FAIL: client API key INSERT allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.api_keys set revoked_at = null where user_id = f.user_a;
    raise exception 'FAIL: client API key UPDATE allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.api_keys where user_id = f.user_a;
    raise exception 'FAIL: client API key DELETE allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.api_keys;
    raise exception 'FAIL: direct key hash reads allowed';
  exception when insufficient_privilege then null;
  end;
  update public.ai_enrichments set summary = 'own row allowed' where id = f.enrichment_a;
  if not found then raise exception 'FAIL: own enrichment update rejected'; end if;
  begin
    update public.ai_enrichments set bookmark_id = f.bookmark_b where id = f.enrichment_a;
    raise exception 'FAIL: foreign bookmark reassignment allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.reserve_ai_enrichment_budget();
    raise exception 'FAIL: client can spend global quota directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_pending_ai_enrichment_batch(40);
    raise exception 'FAIL: client can claim another user queue';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
-- Only touches the new admission ledger inside this rollback transaction.
-- Take the same global lock before clearing/configuring it for the test.
select pg_advisory_xact_lock(hashtextextended('keepory:ai-global-budget', 0));
delete from public.ai_budget_reservations;
update public.ai_runtime_limits set enabled = true, hourly_call_limit = 2, daily_call_limit = 3 where id;
set local role service_role;
do $$
begin
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'true' then raise exception 'FAIL: first reservation denied'; end if;
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'true' then raise exception 'FAIL: second reservation denied'; end if;
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'false' then raise exception 'FAIL: global hourly cap bypassed'; end if;
  update public.ai_runtime_limits set enabled = false where id;
  if public.reserve_ai_enrichment_budget()->>'allowed' <> 'false' then raise exception 'FAIL: kill switch bypassed'; end if;
end;
$$;
reset role;
rollback;
