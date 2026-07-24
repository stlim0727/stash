-- Push notification tokens (STASH #579, follow-on to #578's overflow queue).
--
-- Design: the mobile client registers an Expo push token here after the user
-- opts IN to the "notify when AI catches up" setting AND grants OS
-- notification permission (see apps/mobile/src/notifications/). The batch
-- worker (supabase/functions/ai-enrich/index.ts, runBatchWorker) reads this
-- table with the service-role key — never RLS — once it detects a user's
-- pending_ai_enrichment backlog has fully drained, and POSTs to Expo's push
-- API for every token on file.
--
-- Registered (non-anonymous) users only for v1: an anonymous session has no
-- stable cross-device identity, so a token bound to one is worth little. The
-- client already gates the toggle to a non-anonymous session, but per this
-- repo's convention (see 20260714000000_feedback_reports_require_signed_in.sql)
-- that gate is enforced again in the INSERT/UPDATE policies below via the
-- forwarded JWT's `is_anonymous` claim, so an anonymous session can't
-- register a token by calling the REST endpoint directly either.
--
-- One row per (user_id, token): a user may have several tokens (one per
-- device), but re-registering the same token (e.g. app relaunch, permission
-- re-grant) upserts in place via `on_conflict=user_id,token`
-- (Prefer: resolution=merge-duplicates) rather than growing a duplicate list.

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token)
);

-- Drives the worker's per-user token lookup after a drained-queue detection.
create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

-- Owner-scoped INSERT, gated to non-anonymous callers (see the migration
-- header for why). Mirrors feedback_reports' `with check` shape exactly.
drop policy if exists "Users can register their own push token" on public.push_tokens;
create policy "Users can register their own push token"
  on public.push_tokens for insert
  with check (
    auth.uid() = user_id
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );

-- Owner-scoped UPDATE for the upsert path (`on_conflict=user_id,token` PATCHes
-- an existing row rather than re-inserting), same non-anonymous gate as
-- INSERT so a session can't flip an existing row live out from under the
-- gate by going anonymous first.
drop policy if exists "Users can update their own push token" on public.push_tokens;
create policy "Users can update their own push token"
  on public.push_tokens for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );

-- Owner-scoped SELECT so the client can show "notifications enabled on this
-- device" state without a separate local-only flag that could drift from the
-- server truth. No anonymity gate needed here (read-only, own rows only).
drop policy if exists "Users can view their own push tokens" on public.push_tokens;
create policy "Users can view their own push tokens"
  on public.push_tokens for select
  using (auth.uid() = user_id);

-- Owner-scoped DELETE so turning the setting off can deregister the token
-- (best-effort cleanup) instead of leaving a stale row behind. No anonymity
-- gate: deleting your own row is safe even from an anonymous session (there's
-- nothing sensitive about being allowed to unregister a token you own — and
-- since INSERT/UPDATE already can't be reached anonymously, an anonymous
-- session can never own a push_tokens row in the first place).
drop policy if exists "Users can delete their own push token" on public.push_tokens;
create policy "Users can delete their own push token"
  on public.push_tokens for delete
  using (auth.uid() = user_id);
