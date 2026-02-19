create table if not exists public.ingestion_logs (
  id uuid primary key default gen_random_uuid(),
  repository_id text not null,
  agent_name text not null,
  step text not null,
  status text not null,
  input_summary jsonb not null default '{}'::jsonb,
  output_summary jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingestion_logs_repository_id
  on public.ingestion_logs (repository_id);

create index if not exists idx_ingestion_logs_created_at
  on public.ingestion_logs (created_at desc);
