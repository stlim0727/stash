-- Collection management RPCs (PR #881):
-- Provide transactional, atomic operations for deleting collections (with
-- member uncategorization or trashing) and merging collections into a target.
--
-- Running these operations in a single Postgres transaction prevents race
-- conditions where concurrent bookmark additions/moves between separate
-- PATCH and DELETE statements would get uncategorized by `ON DELETE SET NULL`.

create or replace function public.delete_user_collections(
  collection_ids uuid[],
  delete_action text default 'uncategorize'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_now timestamptz := now();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if collection_ids is null or array_length(collection_ids, 1) is null then
    return;
  end if;

  -- Lock target collections to serialize concurrent modifications
  perform 1 from public.collections
  where user_id = uid and id = any(collection_ids)
  for update;

  if delete_action = 'trash' then
    update public.bookmarks
    set collection_id = null,
        deleted_at = coalesce(deleted_at, v_now),
        updated_at = v_now
    where user_id = uid and collection_id = any(collection_ids);
  else
    update public.bookmarks
    set collection_id = null,
        updated_at = v_now
    where user_id = uid and collection_id = any(collection_ids);
  end if;

  delete from public.collections
  where user_id = uid and id = any(collection_ids);
end;
$$;

revoke all on function public.delete_user_collections(uuid[], text) from public;
revoke all on function public.delete_user_collections(uuid[], text) from anon;
grant execute on function public.delete_user_collections(uuid[], text) to authenticated;
grant execute on function public.delete_user_collections(uuid[], text) to service_role;

create or replace function public.merge_user_collections(
  source_collection_ids uuid[],
  target_collection_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_now timestamptz := now();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if source_collection_ids is null or array_length(source_collection_ids, 1) is null then
    return;
  end if;

  -- Verify target collection belongs to user
  if not exists (
    select 1 from public.collections
    where user_id = uid and id = target_collection_id
  ) then
    raise exception 'Target collection not found or not owned by caller';
  end if;

  -- Lock source collections to serialize concurrent modifications
  perform 1 from public.collections
  where user_id = uid and id = any(source_collection_ids)
  for update;

  update public.bookmarks
  set collection_id = target_collection_id,
      updated_at = v_now
  where user_id = uid and collection_id = any(source_collection_ids);

  delete from public.collections
  where user_id = uid and id = any(source_collection_ids) and id <> target_collection_id;
end;
$$;

revoke all on function public.merge_user_collections(uuid[], uuid) from public;
revoke all on function public.merge_user_collections(uuid[], uuid) from anon;
grant execute on function public.merge_user_collections(uuid[], uuid) to authenticated;
grant execute on function public.merge_user_collections(uuid[], uuid) to service_role;
