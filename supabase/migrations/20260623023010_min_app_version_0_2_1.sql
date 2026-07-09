insert into public.app_config (key, value)
  values ('min_app_version', '0.2.1')
  on conflict (key) do update set value = excluded.value;
