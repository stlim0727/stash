-- Realign the feedback-bridge dispatch trigger to read its URL + shared secret
-- from Vault (mirrors dispatch_ai_enrichment) instead of embedding the secret in
-- the function body, and make dispatch best-effort so a pg_net/Vault hiccup can
-- never abort the report write.

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
