-- Nullable fields preserve existing rendering: legacy memo bodies use Markdown,
-- personal notes use plain text. New clients explicitly select their format.
-- Additive only: existing bookmark ownership policies still cover both columns.
alter table public.bookmarks
  add column if not exists description_format text
    check (description_format in ('plain', 'markdown')),
  add column if not exists notes_format text
    check (notes_format in ('plain', 'markdown'));

comment on column public.bookmarks.description_format is
  'URL-less memo body format; NULL preserves legacy Markdown rendering.';
comment on column public.bookmarks.notes_format is
  'User-authored notes format; NULL preserves legacy plain text rendering.';
