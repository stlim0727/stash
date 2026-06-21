-- Suggest a collection even when the user has no matching folder yet.
-- ai-enrich resolves the model's collection-name hint to an existing collection
-- (suggested_collection_id). Previously, when nothing matched, the hint was
-- dropped — so users with few/no collections only ever saw suggested tags.
-- This column carries the proposed NAME through when no existing collection
-- fits, so the app can offer to create it and file the bookmark in. Nullable
-- and absent from old rows ⇒ "no new-collection suggestion", which the app
-- mapper already treats as null.
alter table public.ai_enrichments
  add column if not exists suggested_collection_name text;
