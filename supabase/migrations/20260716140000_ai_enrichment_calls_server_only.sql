-- Fix two gaps in the ai_enrichment_calls ledger flagged in review:
--
-- 1. The insert policy let any client holding its own Supabase JWT POST
--    directly to /rest/v1/ai_enrichment_calls with arbitrary token counts,
--    without ever calling Gemini — the ledger existed to make spend
--    trustworthy, and a client-writable insert defeats that. The edge
--    function now inserts with the service-role key (bypassing RLS), so no
--    client insert policy is needed at all.
-- 2. bookmark_id was `not null ... on delete cascade`, so permanently
--    deleting a bookmark silently erased its historical spend rows — the
--    opposite of what an append-only ledger is for. Made nullable with
--    `on delete set null`: the bookmark reference clears, the spend record
--    (and its user_id) survives.

drop policy if exists "Users can insert their ai_enrichment_calls" on public.ai_enrichment_calls;

alter table public.ai_enrichment_calls
  drop constraint if exists ai_enrichment_calls_bookmark_id_fkey,
  alter column bookmark_id drop not null;

alter table public.ai_enrichment_calls
  add constraint ai_enrichment_calls_bookmark_id_fkey
  foreign key (bookmark_id) references public.bookmarks(id) on delete set null;
