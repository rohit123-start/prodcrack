alter table if exists public.repository_entities
add column if not exists content text;

comment on column public.repository_entities.content is
'Full source file content persisted for API entities during API-flow ingestion.';
