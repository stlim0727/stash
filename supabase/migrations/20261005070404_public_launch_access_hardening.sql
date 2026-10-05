-- API key management uses the authenticated Edge Function and service role.
-- A client must not mint its own hash or reverse a server-side revocation.
drop policy if exists "Users can manage their own API keys" on public.api_keys;
revoke all on public.api_keys from public, anon, authenticated;
grant select, insert, update, delete on public.api_keys to service_role;

-- Preserve user-path AI upserts but enforce the same parent ownership as INSERT.
drop policy if exists "Users can update their AI enrichments" on public.ai_enrichments;
create policy "Users can update their AI enrichments"
  on public.ai_enrichments for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.bookmarks b
      where b.id = ai_enrichments.bookmark_id and b.user_id = auth.uid()
    )
    and (
      suggested_collection_id is null
      or exists (
        select 1 from public.collections c
        where c.id = ai_enrichments.suggested_collection_id and c.user_id = auth.uid()
      )
    )
  );

-- Serialize claims across workers. The lock is transaction-scoped, including
-- a caller that holds an explicit transaction open. Preserve round-robin order.
create or replace function public.claim_pending_ai_enrichment_batch(p_limit int default 40)
returns setof public.pending_ai_enrichment
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('keepory:ai-queue-claim', 0));
  return query
    with ranked as (
      select id, row_number() over (partition by user_id order by created_at, id) as rn
      from public.pending_ai_enrichment
      where status = 'pending'
         or (status = 'processing' and updated_at < now() - interval '10 minutes')
    ), selected as (
      select id from ranked order by rn, id
      limit least(greatest(coalesce(p_limit, 0), 0), 40)
    )
    update public.pending_ai_enrichment p
    set status = 'processing', updated_at = now()
    from selected s
    where p.id = s.id
      and (p.status = 'pending' or (p.status = 'processing' and p.updated_at < now() - interval '10 minutes'))
    returning p.*;
end;
$$;
revoke all on function public.claim_pending_ai_enrichment_batch(int) from public, anon, authenticated;
grant execute on function public.claim_pending_ai_enrichment_batch(int) to service_role;
