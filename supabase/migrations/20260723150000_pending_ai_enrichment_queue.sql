-- AI enrichment overflow queue (STASH #578, Phase 2 of #574).
--
-- Design: normal enrichment requests keep calling ai-enrich directly and
-- synchronously, completely unchanged (see supabase/functions/ai-enrich) —
-- this queue is NOT a replacement for that path and adds no latency to it.
-- A row here is created ONLY when a direct request would otherwise be
-- rejected with 429 (quota exceeded, request_ai_enrichment_slot() — see
-- 20260620000000_ai_enrichment_rate_limit.sql). Instead of the client just
-- recording a failed/rate-limited attempt, the overflow request is enqueued
-- here (apps/mobile/src/store/bookmarks.tsx, the AI_RATE_LIMITED handling)
-- for a periodic pg_cron-driven worker (supabase/functions/ai-enrich/index.ts,
-- the `batch_worker` request mode) to process later in small batches.
--
-- One pending row per bookmark (unique bookmark_id): the client enqueues with
-- a plain INSERT (Prefer: resolution=ignore-duplicates), so a repeat 429 for
-- an already-queued bookmark silently no-ops against the existing row rather
-- than erroring on the unique constraint — mirrors how the local sync mutation
-- queue collapses to one entry per bookmark.
--
-- RLS: the client may only INSERT its own row (owner-scoped, mirrors
-- ai_enrichments' pattern). There is no client-facing select/update/delete
-- policy at all — the worker does all reading/claiming/writing via
-- service-role (which bypasses RLS), so a client can never read another
-- user's queue, never mark its own row 'done' to skip real processing, and
-- never revive/reset a row the worker already settled (same shape as the
-- append-only ai_enrichment_requests ledger, reachable only through a
-- SECURITY DEFINER function or service role).

create table if not exists public.pending_ai_enrichment (
  id uuid primary key default gen_random_uuid(),
  bookmark_id uuid not null unique references public.bookmarks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The enqueuing user's locale at request time (M12 parity with the
  -- synchronous path's `locale` field), so the worker can still ask the model
  -- to answer in the user's language. Nullable: an older client build that
  -- doesn't send it just gets the model's English default, same as omitting
  -- `locale` on the synchronous path today.
  locale text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Drives the worker's round-robin claim query below (status + created_at).
create index if not exists pending_ai_enrichment_status_created_idx
  on public.pending_ai_enrichment (status, created_at);

alter table public.pending_ai_enrichment enable row level security;

-- `auth.uid() = user_id` alone is not enough: it stops a caller from claiming
-- to be someone ELSE, but a bare user_id check does nothing to stop a caller
-- from enqueuing overflow work for a bookmark_id that isn't theirs (e.g. a
-- guessed/enumerated UUID belonging to another user). The `exists` clause
-- closes that: only a bookmark the caller actually owns may be enqueued.
-- Without it, the worker would later write the resulting ai_enrichments row
-- with `user_id` = the attacker (see index.ts's batch handler, which trusts
-- the pending row's user_id) but `bookmark_id` = the victim's bookmark — since
-- ai_enrichments.bookmark_id is unique, that upsert would both corrupt the
-- victim's real enrichment row and leak their bookmark's content to the
-- attacker's own next sync pull (RLS on ai_enrichments scopes by the row's
-- user_id, which would now be the attacker's).
drop policy if exists "Users can enqueue their own pending enrichment" on public.pending_ai_enrichment;
create policy "Users can enqueue their own pending enrichment"
  on public.pending_ai_enrichment for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.bookmarks b
      where b.id = pending_ai_enrichment.bookmark_id
        and b.user_id = auth.uid()
    )
  );

-- ── Round-robin claim ────────────────────────────────────────────────────
-- Claims up to p_limit pending rows for one worker pass, fairly interleaved
-- across users: every user's Nth-oldest pending row is claimed before
-- anyone's (N+1)th (row_number() partitioned by user_id, ordered by rn first),
-- so one user's large overflow backlog can never crowd out another user's few
-- items in the same pass — and since each pass only ever takes a bounded
-- p_limit, a backlog that outlasts one pass simply continues fairly on the
-- next tick rather than starving anyone permanently.
--
-- Also reclaims rows stuck in 'processing' for over 10 minutes — the worker
-- marks a row 'processing' before doing any LLM call, so a mid-batch crash or
-- timeout would otherwise strand it there forever; the claim query treats a
-- stale 'processing' row as claimable again, same as a fresh 'pending' one.
--
-- SECURITY DEFINER, service_role only: this claims and mutates rows across
-- ALL users, so it must never be reachable by a client role.
create or replace function public.claim_pending_ai_enrichment_batch(p_limit int default 40)
returns setof public.pending_ai_enrichment
language sql
security definer
set search_path = public
as $$
  with ranked as (
    select id,
           row_number() over (partition by user_id order by created_at asc) as rn
    from public.pending_ai_enrichment
    where status = 'pending'
       or (status = 'processing' and updated_at < now() - interval '10 minutes')
  ),
  selected as (
    select id from ranked
    order by rn asc, id asc
    limit greatest(p_limit, 0)
  )
  update public.pending_ai_enrichment p
  set status = 'processing', updated_at = now()
  from selected s
  where p.id = s.id
  returning p.*;
$$;

revoke all on function public.claim_pending_ai_enrichment_batch(int) from public;
revoke all on function public.claim_pending_ai_enrichment_batch(int) from anon;
revoke all on function public.claim_pending_ai_enrichment_batch(int) from authenticated;
grant execute on function public.claim_pending_ai_enrichment_batch(int) to service_role;

-- ── Scheduled dispatch ───────────────────────────────────────────────────
-- Every minute, best-effort-ping the ai-enrich edge function's batch-worker
-- mode via pg_net, reusing the SAME Vault-stored URL/secret the existing
-- dispatch_ai_enrichment trigger already uses (`ai_enrich_url` /
-- `ai_enrich_secret` — see 20260621000000_ai_enrich_server_trigger.sql) so
-- there is no new secret to configure. A missing Vault entry or a pg_net
-- hiccup is a silent no-op: this is a background job, not a user-facing
-- request, and the edge function's own claim step is what actually does the
-- work — a missed or doubled tick is harmless (claimed rows move to
-- 'processing' before any LLM call, so two overlapping ticks can't double-bill
-- the same row).
create extension if not exists pg_cron;
-- Already installed by 20260621000000_ai_enrich_server_trigger.sql; declared
-- again here (idempotent) so this migration doesn't implicitly depend on
-- ordering against that one, matching the same defensive re-declaration in
-- 20260626000000_feedback_bridge_webhook.sql.
create extension if not exists pg_net;

create or replace function public.dispatch_pending_ai_enrichment_worker()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'ai_enrich_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'ai_enrich_secret';

    if v_url is null or v_secret is null then
      return;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ai-enrich-secret', v_secret
      ),
      body := jsonb_build_object('batch_worker', true),
      timeout_milliseconds := 25000
    );
  exception
    when others then
      -- Swallow: this is a fire-and-forget scheduled ping, not a user request.
      null;
  end;
end;
$$;

revoke all on function public.dispatch_pending_ai_enrichment_worker() from public;
revoke all on function public.dispatch_pending_ai_enrichment_worker() from anon;
revoke all on function public.dispatch_pending_ai_enrichment_worker() from authenticated;

-- Idempotent — unschedule any existing job with this name first so re-running
-- this migration doesn't create duplicate schedules (mirrors
-- anon-user-cleanup-daily's pattern). Standard 5-field cron caps at 1-minute
-- resolution; '* * * * *' is that resolution, run every minute.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ai-enrichment-overflow-worker') then
    perform cron.unschedule('ai-enrichment-overflow-worker');
  end if;

  perform cron.schedule(
    'ai-enrichment-overflow-worker',
    '* * * * *',
    $cron$ select public.dispatch_pending_ai_enrichment_worker(); $cron$
  );
end;
$$;
