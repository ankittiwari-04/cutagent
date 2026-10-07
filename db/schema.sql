create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  status text not null default 'uploaded',
  analysis jsonb,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists timelines (
  project_id uuid not null references projects(id) on delete cascade,
  version int not null,
  data jsonb not null,
  prompt text,
  created_at timestamptz not null default now(),
  primary key (project_id, version)
);
