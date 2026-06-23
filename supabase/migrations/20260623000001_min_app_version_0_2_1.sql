-- Raise the minimum required client version to 0.2.1.
-- The trash system (deleted_at column) shipped in 0.2.1; pre-trash 0.2.0
-- builds must not be allowed through the startup gate.
insert into public.app_config (key, value)
  values ('min_app_version', '0.2.1')
  on conflict (key) do update set value = excluded.value;
