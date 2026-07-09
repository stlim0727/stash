-- Add soft-delete (trash) to bookmarks.
alter table public.bookmarks
  add column if not exists deleted_at timestamptz default null;

create index if not exists bookmarks_user_deleted_at_idx
  on public.bookmarks (user_id, deleted_at);

-- App version gate
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);

alter table public.app_config enable row level security;

drop policy if exists "anyone can read app_config" on public.app_config;

create policy "anyone can read app_config"
  on public.app_config for select
  using (true);

insert into public.app_config (key, value)
  values ('min_app_version', '0.2.0')
  on conflict (key) do nothing;
