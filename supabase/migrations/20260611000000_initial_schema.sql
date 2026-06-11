-- Initial Supabase schema for Stash cloud sync.
-- User-authored bookmark fields intentionally live on bookmarks while
-- generated metadata lives in ai_enrichments.

create extension if not exists pgcrypto;

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text,
  canonical_url text,
  url_hash text,
  title text,
  description text,
  notes text,
  source_app text,
  content_type text not null default 'unknown' check (content_type in ('url', 'article', 'image', 'video', 'text', 'unknown')),
  preview_image_url text,
  favicon_url text,
  site_name text,
  collection_id uuid references public.collections(id) on delete set null,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_saved_at timestamptz not null default now(),
  metadata_status text not null default 'pending' check (metadata_status in ('pending', 'complete', 'failed', 'skipped'))
);

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  source text not null default 'user' check (source in ('user', 'ai', 'system')),
  created_at timestamptz not null default now()
);

create table if not exists public.bookmark_tags (
  bookmark_id uuid not null references public.bookmarks(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  source text not null default 'user' check (source in ('user', 'ai', 'system')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  primary key (bookmark_id, tag_id)
);

create table if not exists public.ai_enrichments (
  id uuid primary key default gen_random_uuid(),
  bookmark_id uuid not null references public.bookmarks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  summary text,
  topics jsonb not null default '[]'::jsonb,
  suggested_tags jsonb not null default '[]'::jsonb,
  suggested_collection_id uuid references public.collections(id) on delete set null,
  model text,
  status text not null default 'pending' check (status in ('pending', 'complete', 'failed', 'stale')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bookmarks_user_url_hash_active_idx
  on public.bookmarks (user_id, url_hash)
  where url_hash is not null and is_archived = false;
create index if not exists bookmarks_user_created_at_idx on public.bookmarks (user_id, created_at desc);
create index if not exists bookmarks_user_updated_at_idx on public.bookmarks (user_id, updated_at desc);
create index if not exists bookmarks_user_is_archived_idx on public.bookmarks (user_id, is_archived);
create index if not exists bookmarks_user_collection_id_idx on public.bookmarks (user_id, collection_id);
create unique index if not exists tags_user_slug_idx on public.tags (user_id, slug);
create index if not exists bookmark_tags_tag_id_idx on public.bookmark_tags (tag_id);
create index if not exists ai_enrichments_bookmark_created_at_idx on public.ai_enrichments (bookmark_id, created_at desc);

alter table public.collections enable row level security;
alter table public.bookmarks enable row level security;
alter table public.tags enable row level security;
alter table public.bookmark_tags enable row level security;
alter table public.ai_enrichments enable row level security;

create policy "Users can read their collections"
  on public.collections for select
  using (auth.uid() = user_id);
create policy "Users can insert their collections"
  on public.collections for insert
  with check (auth.uid() = user_id);
create policy "Users can update their collections"
  on public.collections for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "Users can delete their collections"
  on public.collections for delete
  using (auth.uid() = user_id);

create policy "Users can read their bookmarks"
  on public.bookmarks for select
  using (auth.uid() = user_id);
create policy "Users can insert their bookmarks"
  on public.bookmarks for insert
  with check (
    auth.uid() = user_id
    and (
      collection_id is null
      or exists (
        select 1 from public.collections
        where collections.id = bookmarks.collection_id
          and collections.user_id = auth.uid()
      )
    )
  );
create policy "Users can update their bookmarks"
  on public.bookmarks for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      collection_id is null
      or exists (
        select 1 from public.collections
        where collections.id = bookmarks.collection_id
          and collections.user_id = auth.uid()
      )
    )
  );
create policy "Users can delete their bookmarks"
  on public.bookmarks for delete
  using (auth.uid() = user_id);

create policy "Users can read their tags"
  on public.tags for select
  using (auth.uid() = user_id);
create policy "Users can insert their tags"
  on public.tags for insert
  with check (auth.uid() = user_id);
create policy "Users can update their tags"
  on public.tags for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "Users can delete their tags"
  on public.tags for delete
  using (auth.uid() = user_id);

create policy "Users can read tags attached to their bookmarks"
  on public.bookmark_tags for select
  using (exists (
    select 1 from public.bookmarks
    where bookmarks.id = bookmark_tags.bookmark_id
      and bookmarks.user_id = auth.uid()
  ));
create policy "Users can attach owned tags to owned bookmarks"
  on public.bookmark_tags for insert
  with check (
    exists (
      select 1 from public.bookmarks
      where bookmarks.id = bookmark_tags.bookmark_id
        and bookmarks.user_id = auth.uid()
    )
    and exists (
      select 1 from public.tags
      where tags.id = bookmark_tags.tag_id
        and tags.user_id = auth.uid()
    )
  );
create policy "Users can update tags attached to their bookmarks"
  on public.bookmark_tags for update
  using (exists (
    select 1 from public.bookmarks
    where bookmarks.id = bookmark_tags.bookmark_id
      and bookmarks.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bookmarks
    where bookmarks.id = bookmark_tags.bookmark_id
      and bookmarks.user_id = auth.uid()
  ));
create policy "Users can remove tags from their bookmarks"
  on public.bookmark_tags for delete
  using (exists (
    select 1 from public.bookmarks
    where bookmarks.id = bookmark_tags.bookmark_id
      and bookmarks.user_id = auth.uid()
  ));

create policy "Users can read their AI enrichments"
  on public.ai_enrichments for select
  using (auth.uid() = user_id);
create policy "Users can insert their AI enrichments"
  on public.ai_enrichments for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.bookmarks
      where bookmarks.id = ai_enrichments.bookmark_id
        and bookmarks.user_id = auth.uid()
    )
    and (
      suggested_collection_id is null
      or exists (
        select 1 from public.collections
        where collections.id = ai_enrichments.suggested_collection_id
          and collections.user_id = auth.uid()
      )
    )
  );
create policy "Users can update their AI enrichments"
  on public.ai_enrichments for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      suggested_collection_id is null
      or exists (
        select 1 from public.collections
        where collections.id = ai_enrichments.suggested_collection_id
          and collections.user_id = auth.uid()
      )
    )
  );
create policy "Users can delete their AI enrichments"
  on public.ai_enrichments for delete
  using (auth.uid() = user_id);
