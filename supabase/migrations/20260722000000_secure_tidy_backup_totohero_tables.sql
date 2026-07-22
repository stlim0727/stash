-- The Tidy Up backup tables for user totohero were created without RLS,
-- leaving real tag/bookmark_tags data publicly readable and writable via
-- PostgREST (flagged by Supabase security advisors as rls_disabled_in_public).
-- These are point-in-time rollback snapshots, not part of the app schema,
-- so lock them down the same way tidy-tags creates new backup tables:
-- enable RLS with no policies and revoke anon/authenticated grants.

alter table public.tidy_backup_totohero_tags enable row level security;
revoke all on table public.tidy_backup_totohero_tags from anon, authenticated;

alter table public.tidy_backup_totohero_bookmark_tags enable row level security;
revoke all on table public.tidy_backup_totohero_bookmark_tags from anon, authenticated;
