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

create table if not exists exports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  timeline_version int not null,
  status text not null default 'queued',   -- queued | running | done | failed
  total_chunks int not null,
  output_path text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- one row per chunk: progress is a count of 'done' rows, so a retried chunk can never double-count
create table if not exists export_chunks (
  export_id uuid not null references exports(id) on delete cascade,
  idx int not null,
  status text not null default 'pending',
  finished_at timestamptz,
  primary key (export_id, idx)
);
