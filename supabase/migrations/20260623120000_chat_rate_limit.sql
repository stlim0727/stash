-- Chat rate limiting.
--
-- The `chat` edge function runs an agentic loop (several model calls per user
-- turn, plus tool execution), so it is a bigger cost vector than a single
-- ai-enrich call. Like ai-enrich we enforce a per-user sliding-window cap in the
-- database via an append-only ledger + a SECURITY DEFINER function.
--
-- Unlike ai-enrich (which authorizes via the caller's forwarded JWT and so reads
-- auth.uid()), chat authenticates by a stash_ API key and talks to the DB with
-- the service role — there is no JWT context. So this variant takes the user id
-- as an argument and is callable only by the service role, mirroring ai-enrich's
-- request_ai_enrichment_slot_for(uuid). A stash_ key is only issued from a real
-- signed-in session, so all chat callers get the one (signed-in) tier.

create table if not exists public.chat_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists chat_requests_user_created_at_idx
  on public.chat_requests (user_id, created_at desc);

-- RLS on with no policies = deny all. Only the SECURITY DEFINER function below
-- (running as the service role) ever touches this table.
alter table public.chat_requests enable row level security;

-- Atomically check the user's sliding-window usage (rolling hour + day) and, if
-- under the cap, record a slot. Returns a jsonb verdict the edge function maps
-- to 200/429. The caller passes the user id (resolved from their API key); the
-- function is service-role-only, so a client cannot spend another user's quota
-- by forging the argument.
create or replace function public.request_chat_slot_for(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit int := 60;
  v_day_limit int := 500;
  v_hour_count int;
  v_day_count int;
  v_oldest_in_hour timestamptz;
  v_retry_after int;
begin
  if p_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- Serialize check-then-insert per user so a concurrent burst can't each read
  -- the same pre-insert counts and all slip past the cap. Transaction-scoped, so
  -- it releases when this RPC's transaction ends; only same-user calls contend.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Prune rows past the widest window so the ledger stays small without a cron.
  delete from public.chat_requests
   where user_id = p_user_id
     and created_at < now() - interval '1 day';

  select count(*)
    into v_day_count
    from public.chat_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 day';

  select count(*), min(created_at)
    into v_hour_count, v_oldest_in_hour
    from public.chat_requests
   where user_id = p_user_id
     and created_at >= now() - interval '1 hour';

  if v_day_count >= v_day_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'daily_limit',
      'limit', v_day_limit, 'window', 'day', 'retry_after', 3600
    );
  end if;

  if v_hour_count >= v_hour_limit then
    v_retry_after := greatest(
      1, ceil(extract(epoch from (v_oldest_in_hour + interval '1 hour' - now())))
    )::int;
    return jsonb_build_object(
      'allowed', false, 'reason', 'hourly_limit',
      'limit', v_hour_limit, 'window', 'hour', 'retry_after', v_retry_after
    );
  end if;

  insert into public.chat_requests (user_id) values (p_user_id);

  return jsonb_build_object(
    'allowed', true,
    'hour_remaining', v_hour_limit - v_hour_count - 1,
    'day_remaining', v_day_limit - v_day_count - 1
  );
end;
$$;

-- Service-role only — the chat function calls it with the service key; never the
-- anon/authenticated client roles.
revoke all on function public.request_chat_slot_for(uuid) from public;
grant execute on function public.request_chat_slot_for(uuid) to service_role;
