create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table public.api_keys enable row level security;

drop policy if exists "Users can manage their own API keys" on public.api_keys;

create policy "Users can manage their own API keys"
  on public.api_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists api_keys_user_id_idx on public.api_keys(user_id);
create index if not exists api_keys_key_hash_idx on public.api_keys(key_hash);
