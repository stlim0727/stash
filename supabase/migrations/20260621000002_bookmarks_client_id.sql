-- Idempotency key for bookmark creates.
--
-- Create dedupe previously keyed only on `url_hash`, which is null for text
-- notes (rows with no URL). A text note's `create` therefore had no idempotency
-- key, so an interrupted upload that retried — or an orphan-reconciliation
-- re-enqueue — inserted a duplicate row. `client_id` is a stable, device-
-- generated id resent unchanged on every retry; the partial unique index makes
-- a retried insert conflict (409) instead of creating a twin, and the API
-- resolves that conflict back to the original row as a duplicate save.
alter table public.bookmarks
  add column if not exists client_id uuid;

-- Unique per user. Intentionally NOT filtered on is_archived (unlike the
-- active-URL index): a capture id is a one-time identity, so it must resolve to
-- its original row even after archiving rather than allow a second insert.
create unique index if not exists bookmarks_user_client_id_idx
  on public.bookmarks (user_id, client_id)
  where client_id is not null;
