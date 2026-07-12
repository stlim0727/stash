-- Extend the public app_config allowlist for release update control.
--
-- These keys are intentionally public: clients read them before or during auth
-- bootstrap to decide whether an installed build may continue.
drop policy if exists "read public app_config keys" on public.app_config;

create policy "read public app_config keys"
  on public.app_config for select
  using (key in ('min_app_version', 'latest_app_version', 'update_url', 'update_message'));

insert into public.app_config (key, value)
  values
    ('update_url', 'https://play.google.com/store/apps/details?id=com.keepory.app'),
    ('update_message', 'This version of Keepory is no longer supported. Please update to continue.')
  on conflict (key) do nothing;
