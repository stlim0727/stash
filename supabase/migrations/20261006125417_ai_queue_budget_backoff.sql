-- Additive: old clients enqueue without this nullable server scheduling field.
alter table public.pending_ai_enrichment
  add column if not exists retry_not_before timestamptz;

create or replace function public.claim_pending_ai_enrichment_batch(p_limit int default 40)
returns setof public.pending_ai_enrichment
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('keepory:ai-queue-claim', 0));
  return query
    with ranked as (
      select id, row_number() over (partition by user_id order by created_at, id) as rn
      from public.pending_ai_enrichment
      where (retry_not_before is null or retry_not_before <= now())
        and (status = 'pending'
         or (status = 'processing' and updated_at < now() - interval '10 minutes'))
    ), selected as (
      select id from ranked order by rn, id
      limit least(greatest(coalesce(p_limit, 0), 0), 40)
    )
    update public.pending_ai_enrichment p
    set status = 'processing', updated_at = now(), retry_not_before = null
    from selected s
    where p.id = s.id
      and (p.retry_not_before is null or p.retry_not_before <= now())
      and (p.status = 'pending' or (p.status = 'processing' and p.updated_at < now() - interval '10 minutes'))
    returning p.*;
end;
$$;
revoke all on function public.claim_pending_ai_enrichment_batch(int) from public, anon, authenticated;
grant execute on function public.claim_pending_ai_enrichment_batch(int) to service_role;
