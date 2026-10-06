-- Phase B — Life OS domains.
-- Individual-user mental-load state only. Household remains separately disabled.
-- Life OS data is readable/writable only for active/trialing Life OS or Autopilot entitlements.

create or replace function private.apm_has_life_os_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.subscription_entitlements se
    where se.user_id = p_user_id
      and se.status in ('active','trialing')
      and se.plan in ('life_os','autopilot')
  );
$$;

revoke all on function private.apm_has_life_os_access(uuid) from public, anon;
grant execute on function private.apm_has_life_os_access(uuid) to authenticated;

create table public.life_relationships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  birthday date,
  next_contact_at timestamptz,
  cadence_days integer check (cadence_days is null or cadence_days between 1 and 3650),
  notes text check (notes is null or char_length(notes) <= 4000),
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, person_id)
);

create index life_relationships_user_next_contact_idx
  on public.life_relationships(user_id, next_contact_at);

create table public.life_admin_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  kind text not null check (kind in (
    'appointment','trip','bill','subscription','meal_plan','shopping',
    'health_routine','recurring_obligation','family_obligation'
  )),
  title text not null check (char_length(title) between 1 and 500),
  status text not null default 'open' check (status in ('open','planned','scheduled','completed','paused','cancelled')),
  importance smallint not null default 3 check (importance between 1 and 5),
  due_at timestamptz,
  starts_at timestamptz,
  ends_at timestamptz,
  recurrence jsonb not null default '{}'::jsonb,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  details jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at >= starts_at)
);

create index life_admin_items_user_status_due_idx
  on public.life_admin_items(user_id, status, due_at);
create index life_admin_items_user_kind_idx
  on public.life_admin_items(user_id, kind);

alter table public.life_relationships enable row level security;
alter table public.life_admin_items enable row level security;

create policy life_relationships_select_life_os
  on public.life_relationships for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_relationships_insert_life_os
  on public.life_relationships for insert to authenticated
  with check ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_relationships_update_life_os
  on public.life_relationships for update to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())))
  with check ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_relationships_delete_life_os
  on public.life_relationships for delete to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));

create policy life_admin_items_select_life_os
  on public.life_admin_items for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_admin_items_insert_life_os
  on public.life_admin_items for insert to authenticated
  with check ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_admin_items_update_life_os
  on public.life_admin_items for update to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())))
  with check ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
create policy life_admin_items_delete_life_os
  on public.life_admin_items for delete to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));
