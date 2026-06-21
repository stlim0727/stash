-- Server-side AI enrichment trigger.
--
-- Until now the mobile app was the only thing that fired ai-enrich: it waits
-- for a bookmark's metadata to settle on-device, then POSTs with the user's
-- JWT. That covers in-app saves but not the "shared a link, then left the app"
-- case, nor a second device — the row can sit in the cloud with no suggestions
-- until the app that owns it happens to come back.
--
-- This migration adds a database-driven backstop. When a bookmark's
-- metadata_status transitions out of 'pending' (the model now has a real
-- title/site, not the bare URL it was captured as) and nothing has enriched it
-- yet, a trigger calls the ai-enrich edge function via pg_net. There is no user
-- session in a trigger, so it authenticates with a shared secret header; the
-- edge function recognizes it and acts with the service-role key, scoping the
-- work to the bookmark's owner.
--
-- Two safety properties this file must never violate:
--   * Capture is sacred — dispatch is best-effort and wrapped so a missing
--     config or a pg_net hiccup can never abort the bookmark write.
--   * The per-user rate limit still applies — abuse is cheap (anyone can mint an
--     anonymous session and bulk-insert), so the server path spends a slot too,
--     via a service-role-only variant of the existing limiter.

-- pg_net: async, non-blocking HTTP from Postgres. http_post enqueues the request
-- and a background worker delivers it, so the trigger returns immediately and
-- the user's transaction is not held open on the network.
create extension if not exists pg_net;

-- ── Rate limit: a service-role variant keyed by an explicit user ─────────────
-- The existing request_ai_enrichment_slot() reads auth.uid()/auth.jwt() from the
-- forwarded token. The server path has no token, so we factor the window logic
-- into an internal helper that both wrappers share: the public one passes the
-- JWT-derived identity, the service one passes a user id it looked up.

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
    v_day_limit := 200;
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

-- Internal only: reached through the two wrappers below, never called directly
-- by a client role.
revoke all on function public._ai_enrichment_slot(uuid, boolean) from public;

-- The app path (unchanged behavior): identity from the forwarded JWT.
create or replace function public.request_ai_enrichment_slot()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public._ai_enrichment_slot(
    auth.uid(),
    coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  );
end;
$$;

revoke all on function public.request_ai_enrichment_slot() from public;
grant execute on function public.request_ai_enrichment_slot() to anon, authenticated;

-- The server path: the edge function (service-role) names the user explicitly.
-- is_anonymous is read from auth.users; an unknown user defaults to the stricter
-- anonymous cap. service_role only — never reachable by a client role.
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

-- ── Dispatch trigger ─────────────────────────────────────────────────────────
-- Fires after a bookmark write. Mirrors the client's deferred auto-trigger so
-- the two paths dedupe on the "already enriched?" check: whichever fires first
-- wins, the other no-ops.
create or replace function public.dispatch_ai_enrichment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  -- Skip archived rows and ones whose metadata is still being fetched (the model
  -- would only see the bare URL). Mirrors the client gate (fire on any settled
  -- status: complete/failed/skipped).
  if new.is_archived or new.metadata_status = 'pending' then
    return new;
  end if;

  -- On UPDATE, only react to an actual metadata_status transition. Bookmark
  -- edits and the sync watermark touch other columns constantly; without this
  -- every such write would re-evaluate (and the existing-enrichment query would
  -- run) for no reason.
  if tg_op = 'UPDATE' and old.metadata_status is not distinct from new.metadata_status then
    return new;
  end if;

  -- Already has (or is getting) suggestions: nothing to do. This is the dedupe
  -- seam with the client path.
  if exists (select 1 from public.ai_enrichments where bookmark_id = new.id) then
    return new;
  end if;

  -- Best-effort dispatch. A missing config (operator hasn't set up the
  -- server-trigger secret yet) or any pg_net/Vault error must never abort the
  -- bookmark write — capture is sacred.
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'ai_enrich_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'ai_enrich_secret';

    if v_url is null or v_secret is null then
      return new;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ai-enrich-secret', v_secret
      ),
      body := jsonb_build_object(
        'bookmark_id', new.id,
        'user_id', new.user_id
      )
    );
  exception
    when others then
      -- Swallow: enrichment is fire-and-forget; the client backstop and the next
      -- metadata change still get another chance.
      null;
  end;

  return new;
end;
$$;

drop trigger if exists ai_enrich_dispatch on public.bookmarks;
create trigger ai_enrich_dispatch
  after insert or update on public.bookmarks
  for each row
  execute function public.dispatch_ai_enrichment();
