-- In-app feedback / issue reports.
-- Diagnostic context is captured client-side and redacted by default: it never
-- contains user-authored bookmark content (URLs, titles, notes).

create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  app_version text,
  platform text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_reports_user_created_at_idx
  on public.feedback_reports (user_id, created_at desc);

alter table public.feedback_reports enable row level security;

create policy "Users can read their feedback reports"
  on public.feedback_reports for select
  using (auth.uid() = user_id);
create policy "Users can insert their feedback reports"
  on public.feedback_reports for insert
  with check (auth.uid() = user_id);
