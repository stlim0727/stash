-- Add soft-delete (trash) to bookmarks.
-- deleted_at replaces the archive-as-delete pattern: setting deleted_at moves a
-- bookmark to the trash; null means it is active. Permanently deleting (empty
-- trash) removes the row entirely.
alter table public.bookmarks
  add column if not exists deleted_at timestamptz default null;

create index if not exists bookmarks_user_deleted_at_idx
  on public.bookmarks (user_id, deleted_at);

-- App version gate: the minimum client version allowed to read/write data.
-- A single row keyed 'min_app_version' holds a semver string (e.g. '0.2.0').
-- The app fetches this on startup and blocks with an upgrade prompt when its
-- own version is below the minimum.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

-- Allow any authenticated (or anonymous) user to read config; only service-role
-- can write (done via the Supabase dashboard or a migration).
alter table public.app_config enable row level security;

create policy "anyone can read app_config"
  on public.app_config for select
  using (true);

-- Seed the initial minimum version.
insert into public.app_config (key, value)
  values ('min_app_version', '0.2.0')
  on conflict (key) do nothing;
