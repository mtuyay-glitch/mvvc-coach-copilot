-- Enable extensions
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- Basic RBAC: teams + membership
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id uuid references teams(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('head_coach','assistant_coach','director','read_only')),
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- Season context and narrative rules as chunks (markdown is fine)
create table if not exists knowledge_chunks (
  id bigserial primary key,
  team_id uuid references teams(id) on delete cascade,
  season text not null check (season in ('fall','spring','summer')),
  title text not null,
  content text not null,
  tags text[] not null default '{}',
  tsv tsvector generated always as (
    to_tsvector('english', unaccent(coalesce(title,'') || ' ' || coalesce(content,'')))
  ) stored,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin(tsv);
create index if not exists knowledge_chunks_team_season_idx on knowledge_chunks(team_id, season);

-- Precomputed metrics (the AI should not compute from raw CSV in MVP)
create table if not exists player_metrics (
  id bigserial primary key,
  team_id uuid references teams(id) on delete cascade,
  season text not null check (season in ('fall','spring','summer')),
  player_name text not null,
  metric_key text not null,
  metric_value numeric,
  metric_text text,
  source text not null default 'precomputed',
  created_at timestamptz not null default now()
);

create index if not exists player_metrics_lookup_idx
  on player_metrics(team_id, season, player_name, metric_key);

-- Row-level security suggestions:
-- For MVP, you can leave RLS off and rely on server-side service role in API route.
-- For production, enable RLS and add policies restricting by team_members.
