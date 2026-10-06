-- A Player Mode platform expansion
-- Adds the durable primitives required for Calendar Fabric, Email/Commitments,
-- Actions/Autonomy, proactive notifications, analytics, billing, data rights,
-- and future Household OS. Private raw source content is intentionally minimized.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references public.goals(id) on delete set null,
  title text not null,
  objective text,
  status text not null default 'active' check (status in ('active','paused','complete','parked')),
  foreground boolean not null default false,
  review_gate_days integer check (review_gate_days is null or review_gate_days in (30,60,90)),
  review_gate_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_status_idx on public.projects(user_id, status);
create unique index projects_one_foreground_idx on public.projects(user_id) where foreground and status = 'active';

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null references public.goals(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open','complete','missed','parked')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index milestones_user_due_idx on public.milestones(user_id, due_at);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  relationship text,
  email text,
  phone text,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index people_user_name_idx on public.people(user_id, name);

create table public.commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  goal_id uuid references public.goals(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,
  title text not null,
  owner text not null default 'user' check (owner in ('user','other')),
  status text not null default 'captured' check (status in ('captured','understood','prioritized','scheduled','executed','verified','closed','dismissed','corrected','deferred')),
  due_at timestamptz,
  provenance_kind text not null default 'observed' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision not null default 1 check (confidence >= 0 and confidence <= 1),
  user_corrected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index commitments_user_status_due_idx on public.commitments(user_id, status, due_at);
create index commitments_source_ref_idx on public.commitments(user_id, source_type, source_ref);

alter table public.next_actions
  add constraint next_actions_project_fk foreign key (project_id) references public.projects(id) on delete set null,
  add constraint next_actions_commitment_fk foreign key (commitment_id) references public.commitments(id) on delete set null;

alter table public.evidence
  add constraint evidence_commitment_fk foreign key (related_commitment_id) references public.commitments(id) on delete set null;

create table public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  pillar text check (pillar is null or pillar in ('wealth','body','spirit','execution')),
  target_frequency_per_week integer check (target_frequency_per_week is null or target_frequency_per_week between 1 and 14),
  preferred_window jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  minimum_version text,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index routines_user_active_idx on public.routines(user_id, active);

create table public.preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, key)
);

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  description text not null,
  rule_type text not null default 'boundary' check (rule_type in ('boundary','scheduling','continuity','governance','permission','custom')),
  config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','outlook','calendar','manual','system')),
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, key)
);

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('device','google','microsoft','apple_caldav')),
  kind text not null check (kind in ('calendar','email')),
  account_label text,
  external_account_id text,
  status text not null default 'connected' check (status in ('connected','needs_reauth','error','disconnected')),
  scopes text[] not null default '{}',
  encrypted_credentials text,
  credential_iv text,
  credential_version integer not null default 1,
  sync_cursor text,
  last_sync_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider, kind, external_account_id)
);
create index integration_connections_user_idx on public.integration_connections(user_id, kind, status);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  provider text not null,
  external_event_id text not null,
  calendar_external_id text,
  title text not null default '',
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text,
  all_day boolean not null default false,
  availability text not null default 'busy' check (availability in ('free','busy','tentative','out_of_office')),
  recurrence jsonb not null default '{}'::jsonb,
  organizer jsonb not null default '{}'::jsonb,
  attendees jsonb not null default '[]'::jsonb,
  source_version text,
  deleted boolean not null default false,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, provider, external_event_id)
);
create index calendar_events_user_time_idx on public.calendar_events(user_id, starts_at, ends_at) where not deleted;

create table public.message_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  external_message_id text not null,
  external_thread_id text,
  signal_type text not null check (signal_type in ('commitment','request','follow_up','waiting_for','deadline','meeting','cancellation','completion','person')),
  summary text not null,
  due_at timestamptz,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  related_commitment_id uuid references public.commitments(id) on delete set null,
  user_corrected_at timestamptz,
  observed_at timestamptz not null default now(),
  unique(user_id, provider, external_message_id, signal_type, summary)
);
create index message_signals_user_due_idx on public.message_signals(user_id, due_at);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  action_type text not null,
  autonomy_level integer not null default 0 check (autonomy_level between 0 and 5),
  constraints jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  granted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(user_id, domain, action_type)
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  action_type text not null,
  status text not null default 'proposed' check (status in ('proposed','prepared','approved','executing','executed','verified','closed','failed','cancelled')),
  payload jsonb not null default '{}'::jsonb,
  reason text not null,
  permission_id uuid references public.permissions(id) on delete set null,
  idempotency_key text not null,
  requires_approval boolean not null default true,
  approved_at timestamptz,
  executed_at timestamptz,
  verified_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, idempotency_key)
);
create index actions_user_status_idx on public.actions(user_id, status, created_at desc);

create table public.action_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null references public.actions(id) on delete cascade,
  attempt integer not null,
  status text not null check (status in ('started','succeeded','failed')),
  provider text,
  external_ref text,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(action_id, attempt)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null,
  actor_type text not null check (actor_type in ('user','system','connector','ai')),
  actor_ref text,
  object_type text,
  object_id text,
  data_class text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_user_created_idx on public.audit_events(user_id, created_at desc);

create table public.model_routes (
  route_id text primary key,
  model_id text not null,
  provider_id text not null,
  status text not null check (status in ('candidate','approved','restricted','disabled')),
  cost_class text not null check (cost_class in ('zero','low','standard','premium')),
  capabilities text[] not null default '{}',
  data_classes_allowed text[] not null default '{}',
  training_allowed boolean not null default false,
  retention text not null check (retention in ('zero','limited','provider_standard','unknown')),
  approved_for_highly_sensitive boolean not null default false,
  quality_score double precision not null default 0,
  reliability_score double precision not null default 0,
  latency_score double precision not null default 0,
  policy_notes text,
  last_policy_reviewed_at timestamptz not null,
  last_eval_run_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  route_id text references public.model_routes(route_id) on delete set null,
  task_type text not null,
  data_class text not null,
  success boolean not null,
  input_tokens integer,
  output_tokens integer,
  cost_microusd bigint not null default 0,
  latency_ms integer,
  fallback_count integer not null default 0,
  error_code text,
  created_at timestamptz not null default now()
);
create index ai_usage_user_created_idx on public.ai_usage_events(user_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  device_id text,
  platform text check (platform is null or platform in ('ios','android','web')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, expo_push_token)
);

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default true,
  quiet_hours jsonb not null default '{}'::jsonb,
  lock_screen_detail text not null default 'minimal' check (lock_screen_detail in ('minimal','normal')),
  minimum_severity text not null default 'medium' check (minimum_severity in ('low','medium','high','critical')),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  radar_item_id uuid,
  title text not null,
  body text not null,
  deep_link text,
  dedupe_key text not null,
  status text not null default 'queued' check (status in ('queued','sent','opened','suppressed','failed')),
  suppression_reason text,
  sent_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, dedupe_key)
);

create table public.day_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  mode text not null,
  verdict text check (verdict is null or verdict in ('full_day','mvd','miss')),
  completed_action_ids uuid[] not null default '{}',
  note text,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, day)
);

create table public.coaching_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null,
  status text not null default 'open' check (status in ('open','closed')),
  turn_count integer not null default 0,
  friction_summary text,
  closure_directive text,
  started_at timestamptz not null default now(),
  closed_at timestamptz
);

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index analytics_events_name_created_idx on public.analytics_events(event_name, created_at desc);

create table public.subscription_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'beta' check (plan in ('beta','chief_of_staff','life_os','autopilot','household')),
  status text not null default 'active' check (status in ('active','trialing','past_due','cancelled','expired')),
  provider text,
  external_customer_id text,
  external_entitlement_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.data_rights_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null check (job_type in ('export','delete')),
  status text not null default 'requested' check (status in ('requested','processing','complete','failed','cancelled')),
  artifact_ref text,
  failure_code text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.households (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','adult','caregiver','member')),
  status text not null default 'active' check (status in ('active','left','removed')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table public.household_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('commitment','responsibility','event','goal','note')),
  title text not null,
  details jsonb not null default '{}'::jsonb,
  assigned_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open','complete','cancelled')),
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Own-row RLS for single-user data.
do $$
declare t text;
begin
  foreach t in array array[
    'projects','milestones','people','commitments','routines','preferences','rules',
    'integration_connections','calendar_events','message_signals','permissions','actions',
    'action_attempts','push_subscriptions','notifications','day_records','coaching_sessions',
    'data_rights_jobs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)', t || '_delete_own', t);
  end loop;
end $$;

alter table public.notification_preferences enable row level security;
create policy notification_preferences_select_own on public.notification_preferences for select to authenticated using (auth.uid() = user_id);
create policy notification_preferences_insert_own on public.notification_preferences for insert to authenticated with check (auth.uid() = user_id);
create policy notification_preferences_update_own on public.notification_preferences for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy notification_preferences_delete_own on public.notification_preferences for delete to authenticated using (auth.uid() = user_id);

alter table public.subscription_entitlements enable row level security;
create policy subscription_entitlements_select_own on public.subscription_entitlements for select to authenticated using (auth.uid() = user_id);

alter table public.audit_events enable row level security;
create policy audit_events_select_own on public.audit_events for select to authenticated using (auth.uid() = user_id);
create policy audit_events_insert_own on public.audit_events for insert to authenticated with check (auth.uid() = user_id);

alter table public.ai_usage_events enable row level security;
create policy ai_usage_select_own on public.ai_usage_events for select to authenticated using (auth.uid() = user_id);
create policy ai_usage_insert_own on public.ai_usage_events for insert to authenticated with check (auth.uid() = user_id);

alter table public.analytics_events enable row level security;
create policy analytics_events_select_own on public.analytics_events for select to authenticated using (auth.uid() = user_id);
create policy analytics_events_insert_own on public.analytics_events for insert to authenticated with check (auth.uid() = user_id);

alter table public.model_routes enable row level security;
create policy model_routes_authenticated_read on public.model_routes for select to authenticated using (true);

-- Household membership helper avoids recursive RLS checks.
create or replace function public.apm_is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = auth.uid()
      and hm.status = 'active'
  );
$$;
revoke all on function public.apm_is_household_member(uuid) from public;
grant execute on function public.apm_is_household_member(uuid) to authenticated;

alter table public.households enable row level security;
create policy households_member_read on public.households for select to authenticated using (created_by = auth.uid() or public.apm_is_household_member(id));
create policy households_owner_insert on public.households for insert to authenticated with check (created_by = auth.uid());
create policy households_owner_update on public.households for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy households_owner_delete on public.households for delete to authenticated using (created_by = auth.uid());

alter table public.household_members enable row level security;
create policy household_members_member_read on public.household_members for select to authenticated using (user_id = auth.uid() or public.apm_is_household_member(household_id));
create policy household_members_owner_insert on public.household_members for insert to authenticated with check (
  user_id = auth.uid() or exists (select 1 from public.households h where h.id = household_id and h.created_by = auth.uid())
);
create policy household_members_owner_update on public.household_members for update to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.households h where h.id = household_id and h.created_by = auth.uid())
);
create policy household_members_owner_delete on public.household_members for delete to authenticated using (
  user_id = auth.uid() or exists (select 1 from public.households h where h.id = household_id and h.created_by = auth.uid())
);

alter table public.household_items enable row level security;
create policy household_items_member_read on public.household_items for select to authenticated using (public.apm_is_household_member(household_id));
create policy household_items_member_insert on public.household_items for insert to authenticated with check (created_by = auth.uid() and public.apm_is_household_member(household_id));
create policy household_items_member_update on public.household_items for update to authenticated using (public.apm_is_household_member(household_id)) with check (public.apm_is_household_member(household_id));
create policy household_items_member_delete on public.household_items for delete to authenticated using (created_by = auth.uid() or exists (select 1 from public.households h where h.id = household_id and h.created_by = auth.uid()));

-- New-user defaults that make Trust Center and plan state inspectable immediately.
create or replace function public.apm_initialize_user_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_preferences(user_id) values (new.id) on conflict do nothing;
  insert into public.subscription_entitlements(user_id, plan, status) values (new.id, 'beta', 'active') on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.apm_initialize_user_defaults() from public, anon, authenticated;

create trigger on_auth_user_created_apm_defaults
after insert on auth.users
for each row execute procedure public.apm_initialize_user_defaults();

-- Backfill safe defaults for existing users.
insert into public.notification_preferences(user_id)
select id from auth.users on conflict do nothing;
insert into public.subscription_entitlements(user_id, plan, status)
select id, 'beta', 'active' from auth.users on conflict do nothing;
