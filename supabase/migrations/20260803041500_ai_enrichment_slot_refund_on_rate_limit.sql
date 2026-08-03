-- STASH bli9833 incident (2026-08-03): a multi-hour Gemini outage drove
-- bli9833's per-user quota to both caps (30/30 hourly, 500/500 daily) with
-- almost nothing to show for it, because request_ai_enrichment_slot(_for)
-- spends a slot at CLAIM time -- before the provider call even runs -- and
-- there was no way to give it back. processEnrichmentRow's batch-worker
-- retry path already documented this as a known caveat ("no refund RPC, so a
-- long provider outage does burn slots on retries"); this migration is that
-- refund RPC.
--
-- Deliberately narrow: only ever called by the edge function for
-- degradedReason === 'rate_limited' (a provider-side/shared-capacity
-- rejection, not the user's fault and not specific to their bookmark) --
-- never for provider_error/timeout, which are real concluded attempts and
-- keep their charge. Removes exactly the most recently inserted row for that
-- user, matching one claim exactly (never more, even under concurrent
-- refunds for the same user, since each targets a fresh `order by created_at
-- desc limit 1`).

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

  delete from public.ai_enrichment_requests
   where id = (
     select id from public.ai_enrichment_requests
      where user_id = p_user_id
      order by created_at desc
      limit 1
   );
end;
$$;

-- service_role only -- never reachable by a client role, same pattern as
-- request_ai_enrichment_slot_for (20260731180000_ai_enrichment_slot_for_500.sql).
revoke all on function public.refund_ai_enrichment_slot_for(uuid) from public;
grant execute on function public.refund_ai_enrichment_slot_for(uuid) to service_role;
