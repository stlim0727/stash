-- Realign the active-URL uniqueness with the trash model.
-- The partial unique index that dedupes a user's bookmarks by canonical url_hash
-- predated soft-delete and only excluded archived rows (is_archived = false). It
-- was never updated when deleted_at (trash) shipped, so a trashed row still
-- occupied the unique slot for its url_hash. Redefine "active" the same way the
-- app's inbox filter does: is_archived = false AND deleted_at is null.
drop index if exists public.bookmarks_user_url_hash_active_idx;

create unique index if not exists bookmarks_user_url_hash_active_idx
  on public.bookmarks (user_id, url_hash)
  where url_hash is not null and is_archived = false and deleted_at is null;
