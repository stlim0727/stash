-- Tighten app_config read access.
--
-- The original policy (20260623000000_trash_and_app_config.sql) was
--   create policy "anyone can read app_config" ... for select using (true);
-- which lets anon read EVERY row in app_config, and silently makes any future
-- key public the moment it is inserted. We only ever read one public key from
-- the client — `min_app_version`, fetched pre-auth at startup to drive the
-- upgrade gate (apps/mobile/src/supabase/use-min-app-version.ts). Scope the
-- select policy to exactly that key so adding a non-public config row later
-- cannot leak through this table by default.
--
-- Reads stay anonymous: the policy uses the anon/authenticated roles (the
-- client sends the anon key) and the startup gate filters with
-- `?key=eq.min_app_version`, which still matches `using (key = 'min_app_version')`.
-- Writes remain service-role only (no insert/update/delete policy exists).

drop policy if exists "anyone can read app_config" on public.app_config;

create policy "read public app_config keys"
  on public.app_config for select
  using (key = 'min_app_version');
