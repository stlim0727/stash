alter table public.ai_enrichments
  add column if not exists prompt_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists total_tokens integer;
