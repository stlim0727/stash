-- Add AI suggestion dismissal fields to public.bookmarks to enable device sync
alter table public.bookmarks
  add column if not exists dismissed_suggested_tags text[] not null default '{}'::text[],
  add column if not exists dismissed_suggested_folders text[] not null default '{}'::text[],
  add column if not exists reviewed_summary_tokens text[] not null default '{}'::text[];
