-- Tier A anonymous-user cleanup: delete EMPTY + IDLE anonymous users.
--
-- Stash creates an anonymous Supabase user on first launch (anonymous-first
-- sessions). Many of those are throwaway: a user opens the app, never saves
-- anything, never upgrades to a real account, and never comes back. Those rows
-- accumulate forever in auth.users. This migration reaps the safe subset of them
-- on a daily schedule, and keeps an audit trail of every deletion.
--
-- TIER A ONLY (this migration):
--   An anonymous user is eligible iff ALL of the following hold:
--     * is_anonymous = true                          (never upgraded)
--     * no auth.identities row                       (no linked OAuth/email)
--     * email is null or empty                       (belt-and-suspenders w/ above)
--     * zero rows in EVERY table holding user-authored content for that user:
--         public.bookmarks, public.collections, public.tags,
--         public.feedback_reports (support reports the user typed),
--         public.api_keys        (named credentials the user created)  (EMPTY)
--     * coalesce(last_sign_in_at, created_at) older than 7 days        (IDLE, weak)
--     * no auth.sessions row updated within the last 7 days            (IDLE, real)
--   i.e. anonymous, ownerless, carrying no user data, and untouched for a week.
--   This is deliberately conservative: a single saved bookmark, a support report,
--   an API key, a recent session, or any linked identity keeps the user.
--
--   "EMPTY" deliberately includes feedback_reports + api_keys, not just
--   bookmarks/collections/tags. Both CASCADE-delete with auth.users and hold
--   user-authored/meaningful rows (a typed support message; a named credential),
--   so reaping a user that owns either would silently destroy that content. They
--   are eligibility-BLOCKING. (predicate v1 missed these — fixed in v2 below.)
--
--   Other CASCADE children are intentionally NOT eligibility-blocking, by design:
--     * public.ai_enrichments — AI output DERIVED from a bookmark (has bookmark_id).
--       It cannot exist without a bookmark, and the bookmarks guard already keeps
--       any user that owns one. An "empty" user (zero bookmarks) therefore owns
--       zero enrichments; cascading them away loses no independent user content.
--     * public.ai_enrichment_requests — a per-user rate-limit/throttle LOG
--       (id/user_id/created_at only, no user content). Safe to cascade.
--
-- WHICH IDLE CLAUSE ACTUALLY GUARDS (verified read-only against prod 2026-06-28):
--   GoTrue stamps auth.users.last_sign_in_at exactly once, at anonymous creation,
--   and does NOT advance it on app reuse or token refresh. Verified: all 29 live
--   anon users have last_sign_in_at within ~0.1s of created_at (lsia - created_at
--   sub-second for every row). So for anonymous users
--     coalesce(last_sign_in_at, created_at)  ==  created_at, effectively,
--   and the first idle clause degenerates to an ACCOUNT-AGE check, not a
--   last-activity check. An anon user created 8 days ago but active yesterday is
--   "old enough" by this clause. (Kept anyway: it's a cheap correctness floor that
--   guarantees we never reap a brand-new account, and would start to matter if a
--   future GoTrue version begins advancing last_sign_in_at.)
--
--   The REAL idle signal is the auth.sessions clause. Verified that
--   auth.sessions.updated_at DOES advance on token refresh (it tracks
--   refreshed_at): e.g. a live anon session showed updated_at ~13.5h past its
--   created_at after a refresh, and an upgraded user's session showed updated_at
--   8 days past created_at. So "no session updated in 7 days" is a genuine
--   "client has not refreshed/used this account in a week" guard, and it is the
--   load-bearing half of the IDLE predicate. The two clauses are ANDed, so the
--   effective rule is: account is >7 days old AND no session activity in 7 days.
--
-- TIER B (NOT implemented here — DELIBERATELY DEFERRED):
--   Deleting *data-bearing* anonymous users (anonymous accounts that DO have
--   bookmarks/collections/tags but are long-abandoned) is a PRODUCT decision, not
--   an engineering one: it destroys real captured content that the user might
--   still reclaim by upgrading on the same device. We do NOT delete those here.
--   Any Tier B retention/expiry policy must be decided with product and shipped as
--   a separate, explicitly-approved migration. Do not widen this predicate.
--
-- CASCADE: deleting an auth.users row removes all children. Every FK referencing
-- auth.users in this project is ON DELETE CASCADE (verified: bookmarks,
-- collections, tags, api_keys, ai_enrichments, ai_enrichment_requests,
-- feedback_reports, and all auth.* children). bookmark_tags cascades transitively
-- via bookmarks/tags. So a plain DELETE FROM auth.users is sufficient — but note
-- that "sufficient" only means referentially safe; whether cascading a given child
-- is acceptable DATA-wise is a separate question, handled by the EMPTY guards
-- above. Content-bearing children (bookmarks, collections, tags, feedback_reports,
-- api_keys) are eligibility-blocking; derived/log children (ai_enrichments,
-- ai_enrichment_requests) are not. See the EMPTY notes above for the reasoning.
--
-- LIVE-JWT WIPE WINDOW (acknowledged, bounded, accepted):
--   A Supabase access token (JWT) is self-contained and valid until its own `exp`,
--   independent of the auth.sessions.updated_at we check here. So in principle an
--   anonymous user that (a) captured nothing, (b) went idle >=7 days, and (c) still
--   holds a non-expired access token — or lazily refreshes one right before the cron
--   runs — could have its auth.users row CASCADE-deleted out from under a live
--   client, and a subsequent request would execute against a now-deleted user.
--
--   Why this is acceptable for Tier A specifically:
--     * Blast radius is an EMPTY user. Tier A requires zero bookmarks/collections/
--       tags, so a CASCADE delete destroys no user-authored or generated content —
--       only an ownerless, dataless auth row. There is nothing to lose.
--     * The window is short and self-healing. This project uses the default GoTrue
--       config: access-token JWT TTL ~1 hour, and (verified) NO session time-box and
--       NO inactivity timeout — auth.sessions.not_after is null for all 34 live
--       sessions. So the live-JWT race is at most ~1h after deletion. When that token
--       expires (or the client tries to refresh sooner), the refresh hits a deleted
--       user and 4xxs; the app's restoreSession path treats that as "no session" and
--       single-flights a fresh anonymous sign-in (see supabase/ auth client). Net
--       effect on the user: a new empty anon account, i.e. exactly the state they
--       were already in. No data loss, no stuck client.
--     * The 7-day idle gate makes (c) unlikely in practice: a client refreshing its
--       token bumps auth.sessions.updated_at, which removes the user from the
--       eligible set for another 7 days. To be deleted mid-refresh you must refresh
--       in the narrow gap between the predicate snapshot and the DELETE within a
--       single cron transaction.
--
--   CAVEAT / future-proofing: the ~1h bound depends on the default JWT TTL and on
--   refresh tokens not being independently revoked-expiring. Because there is no
--   inactivity timeout configured, a refresh token never ages out on its own, so the
--   7-day session-idle interval is NOT shorter than any refresh-token TTL — there is
--   no TTL to undershoot, and widening the interval would not close the ~1h JWT race
--   (only a token TTL / explicit session revocation would). If a future change adds
--   a refresh-token inactivity timeout, the idle interval here should be set to
--   AT LEAST that timeout so we never delete an account whose refresh token is still
--   live; flag and re-derive at that point rather than silently keeping 7 days.
--
-- SAFETY: the cleanup function is SECURITY DEFINER with an empty search_path and
-- fully-qualified names; it is NOT executable by anon/authenticated. It is invoked
-- only by pg_cron (and by a privileged operator for the one-time purge). It is
-- set-based and idempotent — re-running it simply finds whatever is currently
-- eligible. Each run capped at 500 deletions to bound lock/WAL impact.

-- pg_cron: in-database job scheduler used for the daily reap.
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Audit log. UUIDs only — NO PII (no email, no IP, no content). RLS on, and
-- intentionally NO client policies: only the definer function / privileged roles
-- may read or write it. (RLS with zero policies = deny-all for anon/authenticated.)
-- ---------------------------------------------------------------------------
create table if not exists public.anon_user_cleanup_log (
  id                uuid primary key default gen_random_uuid(),
  run_at            timestamptz not null default now(),
  deleted_count     int not null,
  deleted_ids       uuid[] not null default '{}',
  predicate_version text not null
);

alter table public.anon_user_cleanup_log enable row level security;
-- No policies are defined on purpose: clients (anon/authenticated) get deny-all.
-- The SECURITY DEFINER function below runs as the table owner and bypasses RLS.

-- ---------------------------------------------------------------------------
-- Cleanup function. SECURITY DEFINER + empty search_path + fully-qualified names
-- so it cannot be hijacked via a mutable search_path. Deletes the Tier A set in
-- one statement and records the audit row in the SAME transaction.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_anonymous_users()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Bump this string whenever the eligibility predicate below changes, so the
  -- audit log records which logic produced each deletion batch.
  v_predicate_version constant text := 'tier-a-v2';
  v_deleted_ids uuid[];
  v_deleted_count int;
begin
  -- Select the eligible (Tier A) anonymous user ids, capped at 500 per run.
  with eligible as (
    select u.id
    from auth.users u
    where u.is_anonymous = true
      and not exists (
        select 1 from auth.identities i where i.user_id = u.id
      )
      and (u.email is null or u.email = '')
      and not exists (
        select 1 from public.bookmarks b where b.user_id = u.id
      )
      and not exists (
        select 1 from public.collections c where c.user_id = u.id
      )
      and not exists (
        select 1 from public.tags t where t.user_id = u.id
      )
      -- feedback_reports + api_keys hold user-authored content and CASCADE on
      -- delete (predicate v2). A user owning either is NOT "empty" — keep them.
      and not exists (
        select 1 from public.feedback_reports f where f.user_id = u.id
      )
      and not exists (
        select 1 from public.api_keys k where k.user_id = u.id
      )
      -- NOTE: for anon users last_sign_in_at == created_at (GoTrue never advances
      -- it post-creation — verified), so this clause is effectively an account-age
      -- floor, not a real idle check. The session clause below is the load-bearing
      -- idle guard. See the "WHICH IDLE CLAUSE ACTUALLY GUARDS" header block.
      and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '7 days'
      -- Real idle signal: auth.sessions.updated_at advances on token refresh
      -- (verified). "no session refreshed in 7 days" == client hasn't used this
      -- account in a week. This is the half of the predicate that actually bites.
      and not exists (
        select 1 from auth.sessions s
        where s.user_id = u.id
          and s.updated_at > now() - interval '7 days'
      )
    order by coalesce(u.last_sign_in_at, u.created_at) asc
    limit 500
  ),
  -- Set-based delete. Children removed via ON DELETE CASCADE.
  deleted as (
    delete from auth.users u
    using eligible e
    where u.id = e.id
    returning u.id
  )
  select coalesce(array_agg(d.id), '{}'::uuid[]), count(*)::int
    into v_deleted_ids, v_deleted_count
  from deleted d;

  -- Audit row in the same transaction as the delete.
  insert into public.anon_user_cleanup_log (deleted_count, deleted_ids, predicate_version)
  values (v_deleted_count, v_deleted_ids, v_predicate_version);

  return v_deleted_count;
end;
$$;

-- Lock down execution: only the definer/owner (and roles explicitly granted, i.e.
-- none here) and pg_cron may call it. Revoke the implicit PUBLIC grant and the
-- Supabase client roles.
revoke all on function public.cleanup_anonymous_users() from public;
revoke all on function public.cleanup_anonymous_users() from anon;
revoke all on function public.cleanup_anonymous_users() from authenticated;

-- ---------------------------------------------------------------------------
-- Schedule: daily at 00:17 UTC (off-peak), under a stable job name. Idempotent —
-- unschedule any existing job with this name first so re-running the migration
-- doesn't create duplicate schedules.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'anon-user-cleanup-daily') then
    perform cron.unschedule('anon-user-cleanup-daily');
  end if;

  perform cron.schedule(
    'anon-user-cleanup-daily',
    '17 0 * * *',
    $cron$ select public.cleanup_anonymous_users(); $cron$
  );
end;
$$;
