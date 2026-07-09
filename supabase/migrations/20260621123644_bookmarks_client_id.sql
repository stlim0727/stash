alter table public.bookmarks
  add column if not exists client_id uuid;

create unique index if not exists bookmarks_user_client_id_idx
  on public.bookmarks (user_id, client_id)
  where client_id is not null;
