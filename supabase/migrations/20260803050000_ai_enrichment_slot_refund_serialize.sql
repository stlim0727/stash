-- Codex review (PR #669): refund_ai_enrichment_slot_for had no advisory lock,
-- unlike _ai_enrichment_slot/request_ai_enrichment_slot_for. When a batch-
-- worker wave refunds several rows for the SAME user concurrently (each row
-- is processed in parallel within a wave -- see processEnrichmentRow's
-- Promise.all call site), each refund's SELECT can resolve to the same
-- "latest row" before any of them commits its DELETE: the first actually
-- deletes it, and every other concurrent call's DELETE then matches zero
-- rows (its subquery already picked a since-deleted id). A four-row wave of
-- rate_limited retries for one user could therefore refund only one slot
-- instead of four, silently keeping the user's quota lower than intended
-- during the exact provider outage this fix exists to protect against.
--
-- Fix: take the same per-user pg_advisory_xact_lock the claim-side functions
-- already use, so concurrent refunds for one user serialize -- each one, once
-- it gets the lock, sees the previous refund's committed delete and picks the
-- next-most-recent remaining row instead of racing on the same one.

create or replace function public.refund_ai_enrichment_slot_for(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  delete from public.ai_enrichment_requests
   where id = (
     select id from public.ai_enrichment_requests
      where user_id = p_user_id
      order by created_at desc
      limit 1
   );
end;
$$;
