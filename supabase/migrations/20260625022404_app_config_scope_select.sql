-- Tighten app_config read access (repo: 20260624000000_app_config_scope_select.sql).
-- Scope the anon-readable SELECT policy to exactly the one public startup key
-- (min_app_version) so adding a non-public config row later cannot leak by default.
drop policy if exists "anyone can read app_config" on public.app_config;
drop policy if exists "read public app_config keys" on public.app_config;

create policy "read public app_config keys"
  on public.app_config for select
  using (key in ('min_app_version'));
