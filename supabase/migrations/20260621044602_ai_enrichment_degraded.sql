alter table public.ai_enrichments
  add column if not exists degraded boolean not null default false,
  add column if not exists degraded_reason text;
