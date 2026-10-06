create extension if not exists pgcrypto;

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  timezone text,
  current_season text,
  becoming text,
  updated_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  provenance_kind text not null check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null check (source_type in ('conversation','gmail','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  unique(user_id, name)
);
create index roles_user_id_idx on public.roles(user_id);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  outcome text,
  status text not null check (status in ('active','paused','completed','abandoned')),
  health text not null check (health in ('on_track','at_risk','stalled','unknown')),
  pillar text check (pillar is null or pillar in ('wealth','body','spirit','execution')),
  target_date date,
  priority integer not null default 1 check (priority > 0),
  provenance_kind text not null check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null check (source_type in ('conversation','gmail','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index goals_user_id_priority_idx on public.goals(user_id, priority);

create table public.next_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  goal_id uuid references public.goals(id) on delete cascade,
  commitment_id uuid,
  title text not null,
  status text not null check (status in ('open','scheduled','done','dismissed')),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index next_actions_user_id_status_idx on public.next_actions(user_id, status);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('user_completion','external','system')),
  summary text not null,
  source_type text not null check (source_type in ('conversation','gmail','calendar','manual','system')),
  source_ref text,
  related_goal_id uuid references public.goals(id) on delete set null,
  related_commitment_id uuid,
  related_action_id uuid references public.next_actions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index evidence_user_id_created_at_idx on public.evidence(user_id, created_at desc);

alter table public.user_profiles enable row level security;
alter table public.roles enable row level security;
alter table public.goals enable row level security;
alter table public.next_actions enable row level security;
alter table public.evidence enable row level security;

create policy "profiles_select_own" on public.user_profiles for select to authenticated using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.user_profiles for insert to authenticated with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.user_profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "profiles_delete_own" on public.user_profiles for delete to authenticated using (auth.uid() = user_id);

create policy "roles_select_own" on public.roles for select to authenticated using (auth.uid() = user_id);
create policy "roles_insert_own" on public.roles for insert to authenticated with check (auth.uid() = user_id);
create policy "roles_update_own" on public.roles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "roles_delete_own" on public.roles for delete to authenticated using (auth.uid() = user_id);

create policy "goals_select_own" on public.goals for select to authenticated using (auth.uid() = user_id);
create policy "goals_insert_own" on public.goals for insert to authenticated with check (auth.uid() = user_id);
create policy "goals_update_own" on public.goals for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "goals_delete_own" on public.goals for delete to authenticated using (auth.uid() = user_id);

create policy "next_actions_select_own" on public.next_actions for select to authenticated using (auth.uid() = user_id);
create policy "next_actions_insert_own" on public.next_actions for insert to authenticated with check (auth.uid() = user_id);
create policy "next_actions_update_own" on public.next_actions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "next_actions_delete_own" on public.next_actions for delete to authenticated using (auth.uid() = user_id);

create policy "evidence_select_own" on public.evidence for select to authenticated using (auth.uid() = user_id);
create policy "evidence_insert_own" on public.evidence for insert to authenticated with check (auth.uid() = user_id);
create policy "evidence_update_own" on public.evidence for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "evidence_delete_own" on public.evidence for delete to authenticated using (auth.uid() = user_id);

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_apm_profile
after insert on auth.users
for each row execute procedure public.handle_new_user_profile();
