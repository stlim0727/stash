-- Append-only ledger of individual AI-enrichment calls, one row per attempt.
-- ai_enrichments is upserted on_conflict=bookmark_id (one row per bookmark,
-- overwritten on every re-run), so its token columns only ever reflect the
-- most recent call — a manual "Refresh AI suggestions" silently drops the
-- prior call's spend. This table exists purely so a user/day/model query can
-- sum real cumulative token spend without that loss.

create table if not exists public.ai_enrichment_calls (
  id uuid primary key default gen_random_uuid(),
  bookmark_id uuid not null references public.bookmarks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text,
  prompt_tokens integer,
  output_tokens integer,
  total_tokens integer,
  degraded boolean not null default false,
  degraded_reason text,
  created_at timestamptz not null default now()
);

create index if not exists ai_enrichment_calls_user_created_at_idx
  on public.ai_enrichment_calls (user_id, created_at desc);

alter table public.ai_enrichment_calls enable row level security;

drop policy if exists "Users can read their ai_enrichment_calls" on public.ai_enrichment_calls;
drop policy if exists "Users can insert their ai_enrichment_calls" on public.ai_enrichment_calls;

create policy "Users can read their ai_enrichment_calls"
  on public.ai_enrichment_calls for select
  using (auth.uid() = user_id);
create policy "Users can insert their ai_enrichment_calls"
  on public.ai_enrichment_calls for insert
  with check (auth.uid() = user_id);
