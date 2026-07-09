-- Mirror of repo migration 20260621000001_ai_enrichments_unique_bookmark.sql
-- (PR #146). Required by the deployed edge function's on_conflict=bookmark_id
-- upsert; without it PostgREST returns 400 (42P10) after the provider runs.
-- Verified 0 duplicate (bookmark_id) rows live, so the dedupe DELETE is a no-op
-- here and the constraint adds cleanly.

delete from public.ai_enrichments a
  using public.ai_enrichments b
 where a.bookmark_id = b.bookmark_id
   and (a.created_at < b.created_at
        or (a.created_at = b.created_at and a.id < b.id));

alter table public.ai_enrichments
  add constraint ai_enrichments_bookmark_id_key unique (bookmark_id);
