begin;

create table if not exists app_users (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_profiles (
  user_id text primary key references app_users(id) on delete cascade,
  display_name text not null default '',
  timezone text,
  current_season text,
  becoming text,
  updated_at timestamptz not null default now()
);

create table if not exists roles (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  provenance_kind text not null,
  source_type text not null,
  source_ref text,
  confidence double precision,
  created_at timestamptz not null default now(),
  unique(user_id, name)
);
create index if not exists roles_user_id_idx on roles(user_id);

create table if not exists goals (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  title text not null,
  outcome text,
  status text not null,
  health text not null,
  pillar text,
  target_date date,
  priority integer not null default 1,
  provenance_kind text not null,
  source_type text not null,
  source_ref text,
  confidence double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists goals_user_id_priority_idx on goals(user_id, priority);

create table if not exists next_actions (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  project_id text,
  goal_id text references goals(id) on delete cascade,
  commitment_id text,
  title text not null,
  status text not null,
  estimated_minutes integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists next_actions_user_id_status_idx on next_actions(user_id, status);

create table if not exists evidence (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  kind text not null,
  summary text not null,
  source_type text not null,
  source_ref text,
  related_goal_id text references goals(id) on delete set null,
  related_commitment_id text,
  related_action_id text references next_actions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists evidence_user_id_created_at_idx on evidence(user_id, created_at desc);

commit;
