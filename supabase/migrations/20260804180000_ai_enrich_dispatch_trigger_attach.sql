-- Attach the ai_enrich_dispatch trigger to public.bookmarks (#671 follow-up).
--
-- dispatch_ai_enrichment() has existed since 20260803215821_bookmarks_enrichment_policy.sql
-- (originally authored, but never applied to this project, back in
-- 20260621000000_ai_enrich_server_trigger.sql), but nothing was ever wired up
-- to call it: an audit of every applied migration's statements
-- (supabase_migrations.schema_migrations) turned up zero occurrences of
-- `create trigger ai_enrich_dispatch` — the original migration's trigger
-- statement silently never ran against this project. Server-side automatic AI
-- dispatch has therefore never fired in production; all real enrichment has
-- come from the client's direct call and the ai-enrichment-overflow-worker
-- cron backstop, both unaffected by this gap.
--
-- This migration closes it by attaching the trigger for real. `drop trigger if
-- exists` first makes this idempotent/re-runnable. This is a real behavior
-- change (server-side AI spend now fires automatically for every non-'skip'
-- bookmark) rather than a pure bug fix, applied on explicit project-owner
-- approval. Verified end-to-end live: an 'auto' bookmark produced a real
-- ai_enrichments row via Gemini, and a 'skip' bookmark produced none.

drop trigger if exists ai_enrich_dispatch on public.bookmarks;

create trigger ai_enrich_dispatch
  after insert or update on public.bookmarks
  for each row
  execute function public.dispatch_ai_enrichment();
