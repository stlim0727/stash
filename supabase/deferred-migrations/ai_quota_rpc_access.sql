-- Public-launch blocker discovered by live advisors after the approved rollout.
-- Review and generate a formal migration before applying; not auto-deployed.
-- These RPCs accept arbitrary user IDs and are used only by the trusted server.
-- SECURITY DEFINER owner calls from request_ai_enrichment_slot() keep working.
revoke all on function public._ai_enrichment_slot(uuid, boolean) from public, anon, authenticated;
revoke all on function public.request_ai_enrichment_slot_for(uuid) from public, anon, authenticated;
revoke all on function public.refund_ai_enrichment_slot_for(uuid) from public, anon, authenticated;
grant execute on function public._ai_enrichment_slot(uuid, boolean) to service_role;
grant execute on function public.request_ai_enrichment_slot_for(uuid) to service_role;
grant execute on function public.refund_ai_enrichment_slot_for(uuid) to service_role;
