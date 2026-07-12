-- Carry the AI's proposed collection NAME through when no existing collection
-- matched its hint, so the app can offer to create it. Nullable; absent on old
-- rows means "no new-collection suggestion".
alter table public.ai_enrichments
  add column if not exists suggested_collection_name text;
