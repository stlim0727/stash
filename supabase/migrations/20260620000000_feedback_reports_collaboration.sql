-- Feedback collaboration: attachments, lifecycle status, and a tester-visible
-- developer reply / resolution. Internal-only data lives in a separate table.
--
-- Visibility model (mirrors apps/mobile/src/domain/feedback.ts):
--   * `feedback_reports` holds only fields a reporter is allowed to see. Testers
--     can READ their own rows and INSERT new ones, but a trigger forces every
--     privileged field to a safe value on insert and there is no UPDATE policy
--     for them — so status, developer_reply, and resolution are only ever
--     written by the developer side (service role / the feedback-bridge
--     function).
--   * Internal-only data (the link to the GitHub issue where developers and
--     agents collaborate) lives in `feedback_report_internal`, which has RLS
--     enabled and NO policies — so anon/authenticated roles cannot read it
--     through PostgREST at all, while the service role bypasses RLS. RLS is
--     row-level, not column-level, so keeping internals in a column of a
--     reporter-readable table would leak them to a direct REST query even
--     though the client projection omits the field.

alter table public.feedback_reports
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'open',
  add column if not exists developer_reply text,
  add column if not exists resolution text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.feedback_reports
  drop constraint if exists feedback_reports_status_check;
alter table public.feedback_reports
  add constraint feedback_reports_status_check
  check (status in ('open', 'triaged', 'in_progress', 'resolved', 'closed'));

-- Force privileged fields to safe values on any insert performed in a request
-- that carries an end-user JWT (i.e. RLS is active). Service-role / SQL inserts
-- (the developer side) bypass RLS and are left untouched, so the bridge can set
-- status/replies. `current_setting('role')` is not reliable across poolers, so
-- we key on the presence of an authenticated uid instead.
create or replace function public.feedback_reports_guard_insert()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.status := 'open';
    new.developer_reply := null;
    new.resolution := null;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists feedback_reports_guard_insert on public.feedback_reports;
create trigger feedback_reports_guard_insert
  before insert on public.feedback_reports
  for each row execute function public.feedback_reports_guard_insert();

-- Keep updated_at fresh on developer-side edits so the app can surface "what
-- changed" ordering.
create or replace function public.feedback_reports_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists feedback_reports_touch_updated_at on public.feedback_reports;
create trigger feedback_reports_touch_updated_at
  before update on public.feedback_reports
  for each row execute function public.feedback_reports_touch_updated_at();

-- Private bucket for tester-supplied attachments (screenshots, short videos).
insert into storage.buckets (id, name, public)
values ('feedback-attachments', 'feedback-attachments', false)
on conflict (id) do nothing;

-- Owner-scoped Storage RLS: the first path segment is the user id, so a tester
-- can only read/write objects under their own prefix.
create policy "Feedback attachments are readable by their owner"
  on storage.objects for select
  using (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Feedback attachments are writable by their owner"
  on storage.objects for insert
  with check (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Internal-only side table. Holds the link to the GitHub issue (and any future
-- internal metadata) where developers and agents collaborate. RLS is enabled
-- with NO policies, so anon/authenticated roles get zero rows through PostgREST;
-- only the service role (which bypasses RLS) — i.e. the feedback-bridge function
-- and developer tooling — can read or write it. This keeps internals out of any
-- reporter-readable row.
create table if not exists public.feedback_report_internal (
  report_id uuid primary key references public.feedback_reports(id) on delete cascade,
  external_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.feedback_report_internal enable row level security;
