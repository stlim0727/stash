-- Admin dashboard views for GH #687 (per-user sync / AI-enrich / distribution
-- health, tool choice deferred — Metabase/Retool query these directly).
--
-- Same pattern as 20260724110000_admin_ai_queue_views.sql: views live in
-- `public` for convenient ad-hoc querying (SQL editor / Supabase MCP / a
-- future BI tool connecting with the service-role or postgres role), but
-- grants are explicitly revoked from `anon` and `authenticated` below so
-- they are never reachable via PostgREST from the app. Only a direct
-- postgres/service-role connection can read them.

-- 1. User overview: bookmark count, account type, last sync signal, created_at.
--
-- app_version is read from two places and coalesced, oldest-populated-first:
--   - auth.users.raw_user_meta_data->>'app_version' — already populated today
--     (stamped on launch since v1.0.0-rc17, see
--     apps/mobile/src/supabase/app-version-tracker.ts).
--   - user_sync_status.app_version — reserved for a future sync-path stamp;
--     null for every row until that follow-up lands.
-- last_synced_at / sync_status_app_version columns are also exposed
-- separately so a dashboard can distinguish "never synced" (both null) from
-- "has a launch-time version stamp but no recorded sync".
create or replace view public.admin_user_overview as
select
  u.id as user_id,
  u.email,
  case when u.is_anonymous then 'anonymous' else 'registered' end as account_type,
  count(b.id) filter (where b.deleted_at is null) as bookmark_count,
  coalesce(
    u.raw_user_meta_data ->> 'app_version',
    s.app_version
  ) as app_version,
  s.app_version as sync_status_app_version,
  s.last_synced_at,
  u.created_at
from auth.users u
left join public.bookmarks b on b.user_id = u.id
left join public.user_sync_status s on s.user_id = u.id
group by u.id, u.email, u.is_anonymous, u.raw_user_meta_data, s.app_version, s.last_synced_at, u.created_at
order by bookmark_count desc, u.created_at asc;

-- 2. Enrichment health: per-user metadata_status breakdown, same shape as
-- the existing admin_ai_queue_by_user view (STASH #578).
create or replace view public.admin_enrichment_health_by_user as
select
  user_id,
  count(*) filter (where deleted_at is null) as total_bookmarks,
  count(*) filter (where metadata_status = 'pending' and deleted_at is null) as pending_count,
  count(*) filter (where metadata_status = 'complete' and deleted_at is null) as complete_count,
  count(*) filter (where metadata_status = 'failed' and deleted_at is null) as failed_count,
  count(*) filter (where metadata_status = 'skipped' and deleted_at is null) as skipped_count
from public.bookmarks
group by user_id
order by pending_count desc, failed_count desc;

-- 3. Sync staleness: users whose most recent bookmark activity is >24h old
-- despite having active (non-archived, non-trashed) bookmarks — a proxy for
-- "sync might be stuck", since the local `sync_status` field never reaches
-- the server and last_synced_at isn't populated yet either (see the
-- migration note in 20260804190000_user_sync_status.sql).
create or replace view public.admin_sync_staleness as
select
  user_id,
  count(*) as active_bookmark_count,
  max(updated_at) as most_recent_bookmark_update,
  now() - max(updated_at) as staleness
from public.bookmarks
where deleted_at is null
  and not is_archived
group by user_id
having max(updated_at) < now() - interval '24 hours'
order by most_recent_bookmark_update asc;

-- 4. Flow-stall audit: bookmarks stuck in metadata_status = 'pending' for
-- more than 1 hour — enrichment was requested but seemingly never completed.
create or replace view public.admin_enrichment_flow_stalls as
select
  id as bookmark_id,
  user_id,
  url,
  created_at,
  updated_at,
  now() - updated_at as pending_for
from public.bookmarks
where metadata_status = 'pending'
  and deleted_at is null
  and updated_at < now() - interval '1 hour'
order by updated_at asc;

revoke all on public.admin_user_overview from public, anon, authenticated;
revoke all on public.admin_enrichment_health_by_user from public, anon, authenticated;
revoke all on public.admin_sync_staleness from public, anon, authenticated;
revoke all on public.admin_enrichment_flow_stalls from public, anon, authenticated;
