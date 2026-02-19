create extension if not exists vector;

create table if not exists public.chat_session_memory (
  session_id text not null,
  repository_id text not null,
  entity_id uuid not null,
  weight integer not null default 1,
  last_used timestamptz not null default now(),
  primary key (session_id, repository_id, entity_id)
);

create index if not exists idx_chat_session_memory_repo_session
  on public.chat_session_memory (repository_id, session_id);

create table if not exists public.embeddings (
  repository_id text not null,
  entity_id uuid not null,
  embedding vector(1536),
  semantic_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (repository_id, entity_id)
);

create index if not exists idx_embeddings_repo
  on public.embeddings (repository_id);
