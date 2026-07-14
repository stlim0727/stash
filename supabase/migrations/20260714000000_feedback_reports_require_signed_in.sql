-- Anonymous sessions could submit in-app feedback reports with no identity
-- attached, making the form an open channel for spam/link content. Require a
-- real (non-anonymous) account to insert.

drop policy if exists "Users can insert their feedback reports" on public.feedback_reports;

create policy "Users can insert their feedback reports"
  on public.feedback_reports for insert
  with check (
    auth.uid() = user_id
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );
