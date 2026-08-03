-- Decouple metadata-fetch state from automatic-AI-dispatch intent (#671).
--
-- dispatch_ai_enrichment() (20260621000000_ai_enrich_server_trigger.sql) has
-- so far inferred "should this bookmark get automatic AI?" from
-- metadata_status alone: it skips only 'pending', so 'complete', 'failed', and
-- 'skipped' all dispatch identically. That conflates two different questions —
-- "has metadata fetch settled?" and "should AI run automatically?" — and a
-- Keepory JSON restore (or any bulk import) needs to answer them differently:
-- metadata may already be complete (restored from the backup) while automatic
-- AI should still be suppressed, since the backup may already carry its own
-- enrichment snapshot.
--
-- This migration adds the explicit intent column and makes the trigger honor
-- it. Backward-compatible: the column defaults to 'auto', so every existing
-- row and every client that doesn't yet send this field keeps today's
-- behavior unchanged. Only a client explicit about 'skip' (a future restore/
-- import path) opts out of the automatic dispatch; manual "Suggest with AI"
-- is a separate, explicit action untouched by this trigger.

alter table public.bookmarks
  add column if not exists enrichment_policy text not null default 'auto'
    check (enrichment_policy in ('auto', 'skip'));

create or replace function public.dispatch_ai_enrichment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
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

    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ai-enrich-secret', v_secret
      ),
      body := jsonb_build_object(
        'bookmark_id', new.id,
        'user_id', new.user_id
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
