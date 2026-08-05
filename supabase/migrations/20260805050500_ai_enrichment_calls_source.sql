-- Tag each ai_enrichment_calls row with which path made it.
--
-- Investigating a stuck/quota-exhausted backlog (bli9833, ~500/day requests
-- consumed) turned up a batch of bookmarks with 14-49 recorded calls each --
-- far beyond any single path's own retry cap (client: 6, batch worker: 5
-- attempts) -- but there was no way to tell whether those repeated calls came
-- from the client's direct dispatch, the server-side dispatch_ai_enrichment
-- trigger, or the pending_ai_enrichment overflow worker: all three write to
-- this same ledger with no distinguishing field, so root-causing required
-- inferring from timestamps alone. This column makes that direct.
--
-- Nullable/no backfill: historical rows keep source = null (unknown path),
-- every new row from the edge function fills it going forward.

alter table public.ai_enrichment_calls
  add column if not exists source text
    check (source is null or source in ('client_direct', 'server_trigger', 'batch_worker'));
