-- Library reset (issue #600): one server-side, set-wise wipe of every
-- user-owned library row, callable by the signed-in user (anonymous sessions
-- included — their cloud data is equally theirs). A bulk import gone wrong or a
-- sync test can leave hundreds of rows; deleting them client-side would mean
-- 500+ individual delete sync entries, so the client calls this single RPC and
-- then clears its local cache.
--
-- Deliberately RETAINED (explicit scope decision, per the issue):
--   - feedback_reports        — support history, user-visible in Sentry flows.
--   - ai_enrichment_calls     — server-only usage/billing ledger.
--   - ai_enrichment_rate_limit / chat rate-limit state — abuse control must
--     survive a reset, otherwise resetting becomes a quota-refresh loophole.
--   - anon-cleanup/audit tables — operational bookkeeping, not library data.
--
-- SECURITY DEFINER because several of these tables (pending_ai_enrichment,
-- and bookmark_tags rows whose parent bookmark is being deleted in the same
-- statement batch) have no client-facing DELETE policy — they are managed
-- server-side. The function therefore scopes every statement to auth.uid()
-- explicitly and refuses to run without one.

create or replace function public.reset_user_library()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  n_bookmark_tags bigint;
  n_pending bigint;
  n_enrichments bigint;
  n_bookmarks bigint;
  n_tags bigint;
  n_collections bigint;
  n_push_tokens bigint;
  n_api_keys bigint;
begin
  if uid is null then
    raise exception 'reset_user_library requires an authenticated user'
      using errcode = '42501';
  end if;

  -- Children first (FKs cascade anyway, but explicit deletes make the counts
  -- honest and the intent auditable).
  delete from public.bookmark_tags bt
    using public.bookmarks b
    where bt.bookmark_id = b.id and b.user_id = uid;
  get diagnostics n_bookmark_tags = row_count;

  delete from public.pending_ai_enrichment where user_id = uid;
  get diagnostics n_pending = row_count;

  delete from public.ai_enrichments where user_id = uid;
  get diagnostics n_enrichments = row_count;

  delete from public.bookmarks where user_id = uid;
  get diagnostics n_bookmarks = row_count;

  delete from public.tags where user_id = uid;
  get diagnostics n_tags = row_count;

  delete from public.collections where user_id = uid;
  get diagnostics n_collections = row_count;

  delete from public.push_tokens where user_id = uid;
  get diagnostics n_push_tokens = row_count;

  delete from public.api_keys where user_id = uid;
  get diagnostics n_api_keys = row_count;

  return jsonb_build_object(
    'bookmark_tags', n_bookmark_tags,
    'pending_ai_enrichment', n_pending,
    'ai_enrichments', n_enrichments,
    'bookmarks', n_bookmarks,
    'tags', n_tags,
    'collections', n_collections,
    'push_tokens', n_push_tokens,
    'api_keys', n_api_keys
  );
end;
$$;

-- Only signed-in users (and the service role) may call it; anon-key callers
-- with no session are refused at the grant, and again by the uid check above.
revoke all on function public.reset_user_library() from public;
revoke all on function public.reset_user_library() from anon;
grant execute on function public.reset_user_library() to authenticated;
grant execute on function public.reset_user_library() to service_role;
