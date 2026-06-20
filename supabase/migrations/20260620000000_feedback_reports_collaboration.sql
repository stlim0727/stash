-- Feedback collaboration: attachments, lifecycle status, and a tester-visible
-- developer reply / resolution, plus a link to the internal issue thread.
--
-- Visibility model (mirrors apps/mobile/src/domain/feedback.ts):
--   * Testers can READ their own rows and INSERT new ones, but a trigger forces
--     every privileged field to a safe value on insert and there is no UPDATE
--     policy for them — so status, developer_reply, resolution, and external_ref
--     are only ever written by the developer side (service role / the
--     feedback-bridge function). Internal discussion can never be set or edited
--     by a reporter.
--   * `external_ref` links to the internal GitHub issue where developers and
--     agents (Claude/Codex) collaborate; it is never projected to testers.

alter table public.feedback_reports
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'open',
  add column if not exists developer_reply text,
  add column if not exists resolution text,
  add column if not exists external_ref text,
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
    new.external_ref := null;
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
