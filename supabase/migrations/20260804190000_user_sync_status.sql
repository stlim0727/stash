-- Per-user sync/app-version tracking for the admin dashboard (GH #687).
--
-- There is no per-user "profile" table in this schema (see
-- docs/architecture/data-model.md — users are managed entirely by Supabase
-- Auth, and bookmarks/tags/collections reference the auth user id directly
-- with no natural "one row per user" home for this). This adds a small
-- owner-scoped table instead.
--
-- Scope note: this migration only creates the table. No client code writes
-- to it yet — wiring the mobile sync path to populate app_version /
-- last_synced_at is a deliberate follow-up (see the issue thread), so both
-- columns stay null for every existing row until then. That is expected.
--
-- app_version here is intentionally redundant with the existing per-user
-- app_version already stamped into auth.users.raw_user_meta_data (see
-- apps/mobile/src/supabase/app-version-tracker.ts, populated from
-- v1.0.0-rc17 onward) — this column is reserved for a possible future
-- sync-path stamp (e.g. "app version as of last successful sync" rather than
-- "app version as of last launch"). Until the follow-up lands, prefer
-- auth.users.raw_user_meta_data->>'app_version' as the populated source; see
-- admin_user_overview below, which reads from both.

create table if not exists public.user_sync_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  app_version text,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.user_sync_status enable row level security;

drop policy if exists "Users can read their sync status" on public.user_sync_status;
create policy "Users can read their sync status"
  on public.user_sync_status for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their sync status" on public.user_sync_status;
create policy "Users can insert their sync status"
  on public.user_sync_status for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their sync status" on public.user_sync_status;
create policy "Users can update their sync status"
  on public.user_sync_status for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy: nothing in the product deletes this row directly (it is
-- cleaned up automatically via the FK's `on delete cascade` when the owning
-- auth user is removed, e.g. by cleanup_anonymous_users()).
