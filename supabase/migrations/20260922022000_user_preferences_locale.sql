-- Store per-user language preference and include it in server-side AI enrichment dispatch.
--
-- Background:
-- User language preferences previously lived only on device (pref.locale in local
-- storage). When a bookmark or memo was synced, the database trigger
-- `dispatch_ai_enrichment` fired without a locale, causing the `ai-enrich` edge
-- function to fall back to English by default.
--
-- This migration:
-- 1. Creates `public.user_preferences` with owner-scoped RLS to store user preferences
--    including `locale` ('en' | 'ko').
-- 2. Updates `dispatch_ai_enrichment()` to check `public.user_preferences` (falling back
--    to `auth.users.raw_user_meta_data->>'locale'`) and pass `locale` in the
--    `net.http_post` payload to `ai-enrich`.

create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists "Users can read their own preferences" on public.user_preferences;
create policy "Users can read their own preferences"
  on public.user_preferences for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own preferences" on public.user_preferences;
create policy "Users can insert their own preferences"
  on public.user_preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own preferences" on public.user_preferences;
create policy "Users can update their own preferences"
  on public.user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Update dispatch_ai_enrichment() to read locale from user_preferences or auth.users
create or replace function public.dispatch_ai_enrichment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
  v_locale text;
  v_pref_updated_at timestamptz;
  v_meta_locale text;
  v_meta_updated_at timestamptz;
begin
  -- Skip archived rows, ones whose metadata is still being fetched (the model
  -- would only see the bare URL), and rows whose owner explicitly opted this
  -- bookmark out of automatic AI (e.g. a restore that already has its own
  -- enrichment snapshot, or an import that shouldn't spend AI quota by
  -- default). Mirrors the client gate (fire on any settled status:
  -- complete/failed/skipped) plus the new explicit-intent gate.
  if new.is_archived or new.metadata_status = 'pending' or new.enrichment_policy = 'skip' then
    return new;
  end if;

  -- On UPDATE, only react to an actual metadata_status transition. Bookmark
  -- edits and the sync watermark touch other columns constantly; without this
  -- every such write would re-evaluate (and the existing-enrichment query would
  -- run) for no reason.
  if tg_op = 'UPDATE' and old.metadata_status is not distinct from new.metadata_status then
    return new;
  end if;

  -- Already has (or is getting) suggestions: nothing to do. This is the dedupe
  -- seam with the client path.
  if exists (select 1 from public.ai_enrichments where bookmark_id = new.id) then
    return new;
  end if;

  -- Best-effort dispatch. A missing config (operator hasn't set up the
  -- server-trigger secret yet) or any pg_net/Vault error must never abort the
  -- bookmark write — capture is sacred.
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'ai_enrich_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'ai_enrich_secret';

    if v_url is null or v_secret is null then
      return new;
    end if;

    -- Look up user's preferred locale from user_preferences and auth.users raw_user_meta_data,
    -- preferring whichever was updated more recently.
    select locale, updated_at into v_locale, v_pref_updated_at
      from public.user_preferences where user_id = new.user_id;

    select raw_user_meta_data->>'locale', (raw_user_meta_data->>'locale_updated_at')::timestamptz
      into v_meta_locale, v_meta_updated_at
      from auth.users where id = new.user_id;

    if v_meta_locale is not null and (v_locale is null or v_pref_updated_at is null or v_meta_updated_at > v_pref_updated_at) then
      v_locale := v_meta_locale;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ai-enrich-secret', v_secret
      ),
      body := jsonb_build_object(
        'bookmark_id', new.id,
        'user_id', new.user_id,
        'locale', v_locale
      )
    );
  exception
    when others then
      -- Swallow: enrichment is fire-and-forget; the client backstop and the next
      -- metadata change still get another chance.
      null;
  end;

  return new;
end;
$$;
