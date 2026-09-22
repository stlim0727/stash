-- Add preference column ('system' | 'en' | 'ko') to public.user_preferences
-- to preserve user intent separately from the currently resolved locale.
alter table public.user_preferences
  add column if not exists preference text not null default 'system';
