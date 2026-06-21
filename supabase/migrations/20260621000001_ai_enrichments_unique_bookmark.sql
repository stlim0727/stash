-- Enforce one ai_enrichments row per bookmark.
--
-- The edge function has always kept a "single live row per bookmark" by
-- convention (query the latest, patch it, else insert), but nothing in the
-- schema enforced it: ai_enrichments had only a NON-unique (bookmark_id,
-- created_at) index. With two enrichment triggers now able to fire as a
-- bookmark's metadata settles — the in-app auto-trigger and the server-side
-- dispatch_ai_enrichment — a narrow race could let both pass the "already
-- enriched?" preflight and each INSERT, leaving two rows for one bookmark.
--
-- This makes the invariant a real constraint so the function's upsert
-- (ON CONFLICT bookmark_id → update in place) collapses that race to a single
-- row. (The rate-limit slot can still be spent twice in the race window, but
-- that is bounded and capped by the per-user limiter; duplicate *rows* are the
-- artifact worth preventing.)

-- Collapse any pre-existing duplicates first, newest-wins — matching the
-- function's `order by created_at desc limit 1` read — so the unique constraint
-- can be added without error. Ties (same created_at) break by id.
delete from public.ai_enrichments a
  using public.ai_enrichments b
 where a.bookmark_id = b.bookmark_id
   and (a.created_at < b.created_at
        or (a.created_at = b.created_at and a.id < b.id));

alter table public.ai_enrichments
  add constraint ai_enrichments_bookmark_id_key unique (bookmark_id);

-- The old composite index is now redundant with the unique index above (there
-- is at most one row per bookmark), but harmless; left in place to keep this
-- migration additive.
