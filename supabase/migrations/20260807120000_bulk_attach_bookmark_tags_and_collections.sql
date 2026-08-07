-- Batch tag/collection attach RPC (issue #713, Sentry STASH-5F/5G/5D): a bulk
-- JSON import creates bookmarks in chunks already (BULK_CREATE_SYNC_CHUNK_SIZE,
-- sync/sync-bookmarks.ts), but the follow-up "attach this bookmark's tags and
-- imported folder" step used to issue one HTTP round trip per (bookmark, tag)
-- pair / per bookmark-collection assignment — 3,000+ sequential calls for a
-- 1,000-bookmark import with ~3 tags each. This function does the same work
-- for a whole chunk of ALREADY-CREATED bookmarks in one transaction: resolve-
-- or-create each tag, resolve-or-create the (at most one) collection per
-- bookmark, and link everything. Bookmark creation itself is untouched — this
-- only replaces the fan-out of `addTags`/`updateBookmark`/`createCollection`
-- calls that followed it.
--
-- SECURITY DEFINER because bulk-writing `tags`/`bookmark_tags`/`collections`/
-- `bookmarks.collection_id` for a caller-supplied list of bookmark ids in one
-- statement batch needs to bypass RLS's per-row policy evaluation; the
-- function instead scopes every statement to auth.uid() explicitly and (unlike
-- reset_user_library) verifies row-by-row that each bookmark_id actually
-- belongs to the caller, silently skipping any that don't rather than
-- erroring the whole batch (a stale/foreign id in one chunk must not sink the
-- other 49 bookmarks in it).
--
-- Slugs are NOT recomputed here: the client's slugify() (domain/tag-normalize.ts)
-- is a unicode-aware regex (`\p{L}\p{N}`) and the input payload already carries
-- the {name, slug} pairs the client computed with it (mirrors how ensureTag()
-- is called today for the single-op path) — reimplementing that regex in
-- plpgsql would risk a subtle mismatch with what the client already sends.
--
-- `collections.name` has no unique constraint (see the initial schema migration
-- comment); this replicates the client's existing select-then-insert-if-missing
-- pattern (syncPendingImportCollections, store/bookmarks.tsx) inside one
-- transaction — two rows in the same batch requesting the same new collection
-- name naturally converge via read-your-own-writes, since plpgsql statements in
-- the same function invocation run in the same transaction.
--
-- `bookmarks.collection_id` is only ever set when it is currently NULL (an
-- import re-run or a concurrent manual move must not clobber an existing
-- assignment) — done atomically in the UPDATE's own WHERE clause, not a
-- separate check-then-act. `updated_at` is bumped to match when (and only
-- when) the collection actually gets attached, mirroring what a normal
-- `PATCH .../bookmarks` (api/bookmarks.ts updateBookmark) already does for
-- every field write.

create or replace function public.bulk_attach_bookmark_tags_and_collections(items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_now timestamptz := now();
  item jsonb;
  v_bookmark_id uuid;
  v_owns boolean;
  v_tag jsonb;
  v_tag_row record;
  v_tags_result jsonb;
  v_collection_name text;
  v_collection record;
  v_collection_result jsonb;
  v_collection_attached boolean;
  v_bookmark_updated_at timestamptz;
  result jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'bulk_attach_bookmark_tags_and_collections requires an authenticated user'
      using errcode = '42501';
  end if;

  for item in select * from jsonb_array_elements(coalesce(items, '[]'::jsonb))
  loop
    v_bookmark_id := (item->>'bookmark_id')::uuid;

    -- Ownership check: SECURITY DEFINER bypasses RLS, so this is the only
    -- thing standing between a caller-supplied id and another user's row.
    -- Skip silently rather than erroring the whole batch.
    select exists (
      select 1 from public.bookmarks b
      where b.id = v_bookmark_id and b.user_id = uid
    ) into v_owns;
    if not v_owns then
      continue;
    end if;

    -- Reset per-item locals; plpgsql declarations persist across loop
    -- iterations, so a later item with no collection_name must not inherit
    -- the previous item's resolved collection.
    v_collection_result := null;
    v_collection_attached := false;
    v_bookmark_updated_at := null;
    v_tags_result := '[]'::jsonb;

    for v_tag in select * from jsonb_array_elements(coalesce(item->'tags', '[]'::jsonb))
    loop
      insert into public.tags (user_id, name, slug, source, created_at)
      values (
        uid,
        v_tag->>'name',
        v_tag->>'slug',
        coalesce(v_tag->>'source', 'user'),
        v_now
      )
      -- DO UPDATE (not DO NOTHING) so RETURNING always yields the row,
      -- whether just-inserted or already existing (tags_user_slug_idx).
      on conflict (user_id, slug) do update set slug = excluded.slug
      returning id, name, slug, source, created_at into v_tag_row;

      insert into public.bookmark_tags (bookmark_id, tag_id, source, confidence, created_at)
      values (v_bookmark_id, v_tag_row.id, coalesce(v_tag->>'source', 'user'), null, v_now)
      on conflict (bookmark_id, tag_id) do nothing;

      v_tags_result := v_tags_result || jsonb_build_object(
        'id', v_tag_row.id,
        'user_id', uid,
        'name', v_tag_row.name,
        'slug', v_tag_row.slug,
        'source', v_tag_row.source,
        'created_at', v_tag_row.created_at
      );
    end loop;

    v_collection_name := nullif(trim(coalesce(item->>'collection_name', '')), '');
    if v_collection_name is not null then
      -- Case-insensitive match on trimmed name, scoped to this user — mirrors
      -- the client's normalizeTag() comparison. No unique index exists, so
      -- pick a deterministic winner (oldest) if duplicates already exist.
      select * into v_collection
        from public.collections c
        where c.user_id = uid
          and lower(trim(c.name)) = lower(v_collection_name)
        order by c.created_at asc
        limit 1;

      if not found then
        insert into public.collections (user_id, name, created_at, updated_at)
        values (uid, v_collection_name, v_now, v_now)
        returning * into v_collection;
      end if;

      update public.bookmarks
        set collection_id = v_collection.id, updated_at = v_now
        where id = v_bookmark_id and user_id = uid and collection_id is null
        returning updated_at into v_bookmark_updated_at;

      v_collection_attached := v_bookmark_updated_at is not null;
      v_collection_result := jsonb_build_object(
        'id', v_collection.id,
        'user_id', v_collection.user_id,
        'name', v_collection.name,
        'description', v_collection.description,
        'created_at', v_collection.created_at,
        'updated_at', v_collection.updated_at
      );
    end if;

    result := result || jsonb_build_object(
      'bookmark_id', v_bookmark_id,
      'tags', v_tags_result,
      'collection', v_collection_result,
      'collection_attached', v_collection_attached,
      'bookmark_updated_at', v_bookmark_updated_at
    );
  end loop;

  return result;
end;
$$;

revoke all on function public.bulk_attach_bookmark_tags_and_collections(jsonb) from public;
revoke all on function public.bulk_attach_bookmark_tags_and_collections(jsonb) from anon;
grant execute on function public.bulk_attach_bookmark_tags_and_collections(jsonb) to authenticated;
grant execute on function public.bulk_attach_bookmark_tags_and_collections(jsonb) to service_role;
