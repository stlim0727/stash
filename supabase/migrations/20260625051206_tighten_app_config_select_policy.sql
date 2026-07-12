drop policy if exists "anyone can read app_config" on public.app_config;
drop policy if exists "read public app_config keys" on public.app_config;

create policy "read public app_config keys"
  on public.app_config for select
  using (key in ('min_app_version'));
