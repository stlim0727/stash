-- Forward new feedback_reports rows to the feedback-bridge edge function.
-- The project never had Supabase Database Webhooks enabled (no
-- supabase_functions schema), so we wire the trigger directly via pg_net.
--
-- Historical note: the already-applied remote migration contained a hardcoded
-- webhook secret here. The secret is intentionally not restored to source
-- control; the next migration replaces this function with Vault-backed config.

create extension if not exists pg_net;

create or replace function public.notify_feedback_bridge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://stzutoejnhzxzhjsjtsi.supabase.co/functions/v1/feedback-bridge',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'feedback_reports',
      'schema', 'public',
      'record', to_jsonb(new)
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-feedback-bridge-secret', 'REDACTED_REPLACED_BY_20260626041057'
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists on_feedback_report_created on public.feedback_reports;
create trigger on_feedback_report_created
  after insert on public.feedback_reports
  for each row execute function public.notify_feedback_bridge();
