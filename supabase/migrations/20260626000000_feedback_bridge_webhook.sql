-- Forward new feedback_reports rows to the feedback-bridge edge function.
--
-- The mobile app only ever writes a row to feedback_reports; this trigger fires
-- on INSERT and calls the feedback-bridge edge function via pg_net, which then
-- delivers the report to the external sink (Sentry by default) server-side. See
-- supabase/functions/feedback-bridge for the function and its ReportSink seam.
--
-- This is the database-webhook half of that flow. It deliberately mirrors
-- dispatch_ai_enrichment (20260621000000_ai_enrich_server_trigger.sql): pg_net
-- for async HTTP, and the URL + shared secret read from Vault rather than baked
-- into this file, so no secret ever lands in the repo.
--
-- Operator setup (out-of-band, like the ai_enrich_* secrets) — set BOTH the
-- Vault secrets the trigger reads and the matching edge-function env var:
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/feedback-bridge', 'feedback_bridge_url');
--   select vault.create_secret('<random-shared-secret>', 'feedback_bridge_secret');
--   -- and, on the edge function: FEEDBACK_BRIDGE_SECRET=<same random-shared-secret>, SENTRY_DSN=<dsn>
-- Until feedback_bridge_url is set the trigger is a no-op; until the secret
-- matches the function env the function rejects the webhook (401). Reports are
-- always persisted regardless — forwarding is best-effort.

-- pg_net: async, non-blocking HTTP from Postgres. http_post enqueues the request
-- and a background worker delivers it, so the trigger returns immediately and
-- the user's transaction is not held open on the network.
create extension if not exists pg_net;

create or replace function public.notify_feedback_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  -- Best-effort dispatch. A missing config (operator hasn't set up the Vault
  -- secrets yet) or any pg_net/Vault error must never abort the report write.
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'feedback_bridge_url';
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'feedback_bridge_secret';

    if v_url is null then
      return new;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-feedback-bridge-secret', coalesce(v_secret, '')
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'feedback_reports',
        'schema', 'public',
        'record', to_jsonb(new)
      ),
      timeout_milliseconds := 5000
    );
  exception
    when others then
      -- Swallow: forwarding is fire-and-forget; the report is already persisted.
      null;
  end;

  return new;
end;
$$;

drop trigger if exists on_feedback_report_created on public.feedback_reports;
create trigger on_feedback_report_created
  after insert on public.feedback_reports
  for each row execute function public.notify_feedback_bridge();
