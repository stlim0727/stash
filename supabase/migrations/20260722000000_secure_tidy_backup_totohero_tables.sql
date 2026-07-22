-- The Tidy Up backup tables for user totohero were created without RLS,
-- leaving real tag/bookmark_tags data publicly readable and writable via
-- PostgREST (flagged by Supabase security advisors as rls_disabled_in_public).
-- These are point-in-time rollback snapshots, not part of the app schema,
-- so lock them down the same way tidy-tags creates new backup tables:
-- enable RLS with no policies and revoke anon/authenticated grants.
--
-- These tables were created ad hoc directly against the live database, not
-- by an earlier migration, so guard on existence: a fresh/CI/local database
-- replaying this migration chain from scratch never has them.

do $$
begin
  if to_regclass('public.tidy_backup_totohero_tags') is not null then
    execute 'alter table public.tidy_backup_totohero_tags enable row level security';
    execute 'revoke all on table public.tidy_backup_totohero_tags from anon, authenticated';
  end if;

  if to_regclass('public.tidy_backup_totohero_bookmark_tags') is not null then
    execute 'alter table public.tidy_backup_totohero_bookmark_tags enable row level security';
    execute 'revoke all on table public.tidy_backup_totohero_bookmark_tags from anon, authenticated';
  end if;
end $$;
