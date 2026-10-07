-- 0021: persisted goal → 30/60/90 plans and the BHPC daily loop.
--
--  A. `family` becomes a first-class pillar (BHPC Part VII names Family as a
--     permanent pillar; parent+ plans protect a daily family floor).
--  B. goal_plans: one deterministic plan per goal (packages/planning output,
--     stored verbatim), with the 30/60 gate reviews and the forced day-90
--     Promote / Maintain / Park decision.
--  C. plan_action_completions: evidence that a supplied plan action was done on a
--     local day. Completing requires the morning check-in (the opening step) and
--     the action to be on that day's agenda.
--  D. day_records gains the morning check-in (mood → Mood Gate), the day state
--     (Never Miss Twice), the frozen agenda (No Mid-Day Negotiation) and declared
--     replans. Direct writes to day_records are revoked; every write is a governed
--     function that computes the user's LOCAL day, so a prior day can never be
--     reopened (No Catch-Up) and the server clock's UTC date is never used.
--
-- Pattern (as 0017/0018): owner + entitlement reads; writes only through
-- SECURITY DEFINER bodies in `private` (search_path = '') behind thin SECURITY
-- INVOKER wrappers in `public`; every write audits in the same transaction; the
-- data-rights export reads through an owner-only function with no entitlement gate.

-- ---------------------------------------------------------------- A. family pillar
alter table public.goals drop constraint if exists goals_pillar_check;
alter table public.goals add constraint goals_pillar_check
  check (pillar is null or pillar in ('wealth','body','spirit','execution','family'));
alter table public.pillar_settings drop constraint if exists pillar_settings_name_check;
alter table public.pillar_settings add constraint pillar_settings_name_check
  check (name in ('wealth','body','spirit','execution','family'));
alter table public.routines drop constraint if exists routines_pillar_check;
alter table public.routines add constraint routines_pillar_check
  check (pillar is null or pillar in ('wealth','body','spirit','execution','family'));

alter table public.goals add constraint goals_user_id_id_unique unique (user_id, id);

-- ---------------------------------------------------------------- shared guards
create or replace function private.apm_has_core_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscription_entitlements se
     where se.user_id = p_user_id
       and se.status in ('active','trialing')
       and se.plan in ('beta','chief_of_staff','life_os','autopilot')
  );
$$;

create or replace function private.apm_loop_require_access()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'loop_unauthenticated' using errcode = '42501';
  end if;
  if not private.apm_has_core_access(v_uid) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- The user's local calendar day. An unknown or missing timezone falls back to UTC.
create or replace function private.apm_local_today(p_user_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  select up.timezone into v_tz from public.user_profiles up where up.user_id = p_user_id;
  if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = v_tz) then
    v_tz := 'UTC';
  end if;
  return (now() at time zone v_tz)::date;
end;
$$;

create or replace function private.apm_loop_audit(
  p_user_id uuid,
  p_event_type text,
  p_object_type text,
  p_object_id text,
  p_metadata jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (p_user_id, p_event_type, 'user', p_object_type, p_object_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Week 1 (BHPC Part XIII): do not add projects, do not customise.
create or replace function private.apm_loop_week_one_locked(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.personal_os p
     where p.user_id = p_user_id
       and private.apm_local_today(p_user_id) < p.stabilization_started_at + 7
  );
$$;

-- ---------------------------------------------------------------- B. goal_plans
create table public.goal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid not null,
  plan_key text not null check (char_length(plan_key) between 1 and 120),
  template_key text not null check (char_length(template_key) between 1 and 120),
  persona text not null check (persona in ('weight_loss','wealth_building','founder','operator_promotion','parent_plus','generic')),
  foreground_pillar text not null check (foreground_pillar in ('wealth','body','spirit','execution','family')),
  start_date date not null,
  end_date date not null,
  timezone text check (timezone is null or char_length(timezone) between 1 and 120),
  plan jsonb not null,
  status text not null default 'active' check (status in ('active','decided','superseded')),
  decision text check (decision is null or decision in ('promote','maintain','park')),
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 3 and 500),
  decided_at timestamptz,
  gate_reviews jsonb not null default '{}'::jsonb check (jsonb_typeof(gate_reviews) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goal_plans_ninety_days check (end_date = start_date + 89),
  constraint goal_plans_decision_state check ((status = 'decided') = (decision is not null) or status = 'superseded'),
  constraint goal_plans_user_goal_fk foreign key (user_id, goal_id) references public.goals(user_id, id) on delete cascade,
  constraint goal_plans_user_id_id_unique unique (user_id, id)
);
create unique index goal_plans_one_live_plan_per_goal on public.goal_plans(goal_id) where status <> 'superseded';
create index goal_plans_user_status_idx on public.goal_plans(user_id, status);

-- ---------------------------------------------------------------- C. completions
create table public.plan_action_completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null,
  day date not null,
  action_key text not null check (char_length(action_key) between 1 and 120),
  instance_id text not null check (char_length(instance_id) between 1 and 300),
  scope text not null check (scope in ('standard','mvd')),
  role text not null check (role in ('foreground','floor')),
  note text check (note is null or char_length(note) <= 500),
  evidence_id uuid references public.evidence(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint plan_action_completions_user_plan_fk foreign key (user_id, plan_id) references public.goal_plans(user_id, id) on delete cascade,
  unique (plan_id, day, action_key)
);
create index plan_action_completions_user_day_idx on public.plan_action_completions(user_id, day desc);
create index plan_action_completions_evidence_idx on public.plan_action_completions(evidence_id);

-- ---------------------------------------------------------------- D. day_records
alter table public.day_records
  add column mood smallint check (mood is null or mood between 1 and 10),
  add column day_state text check (day_state is null or day_state in ('normal','recovery','missed_yesterday')),
  add column agenda jsonb check (agenda is null or jsonb_typeof(agenda) = 'object'),
  add column agenda_status text check (agenda_status is null or agenda_status in ('printed','locked')),
  add column checked_in_at timestamptz,
  add column replans jsonb not null default '[]'::jsonb check (jsonb_typeof(replans) = 'array');

drop policy if exists day_records_insert_own on public.day_records;
drop policy if exists day_records_update_own on public.day_records;
drop policy if exists day_records_delete_own on public.day_records;
revoke all on table public.day_records from anon;
revoke insert, update, delete, truncate, references, trigger on table public.day_records from authenticated;
grant select on table public.day_records to authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.goal_plans enable row level security;
alter table public.plan_action_completions enable row level security;
create policy goal_plans_select_entitled on public.goal_plans for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_core_access((select auth.uid())));
create policy plan_action_completions_select_entitled on public.plan_action_completions for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_core_access((select auth.uid())));
revoke all on table public.goal_plans from anon;
revoke all on table public.plan_action_completions from anon;
revoke insert, update, delete, truncate, references, trigger on table public.goal_plans from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.plan_action_completions from authenticated;
grant select on table public.goal_plans to authenticated;
grant select on table public.plan_action_completions to authenticated;

-- ---------------------------------------------------------------- plan validation
-- Structural check of the engine output. The plan engine (packages/planning) is the
-- authority on content; the database refuses anything that is not shaped like it.
create or replace function private.apm_loop_check_plan(p_plan jsonb)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_key text;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_plan::text) > 262144 then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if coalesce(p_plan->>'version', '') <> '1'
     or coalesce(p_plan->'provenance'->>'source', '') <> 'deterministic_template'
     or char_length(coalesce(p_plan->>'id', '')) not between 1 and 120
     or char_length(coalesce(p_plan->'provenance'->>'templateKey', '')) not between 1 and 120
     or coalesce(p_plan->'persona'->>'key', '') not in ('weight_loss','wealth_building','founder','operator_promotion','parent_plus','generic')
     or coalesce(p_plan->'foreground'->>'pillar', '') not in ('wealth','body','spirit','execution','family')
     or jsonb_typeof(p_plan->'gates') <> 'array' or jsonb_array_length(p_plan->'gates') <> 3
     or jsonb_typeof(p_plan->'actions') <> 'object'
     or jsonb_typeof(p_plan->'floors') <> 'array'
     or jsonb_typeof(p_plan->'setup') <> 'array'
     or jsonb_typeof(p_plan->'safety') <> 'object'
     or jsonb_typeof(p_plan->'safety'->'referral') <> 'boolean'
  then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  begin
    v_start := (p_plan->>'startDate')::date;
    v_end := (p_plan->>'endDate')::date;
  exception when others then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end;
  if v_end <> v_start + 89 then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if not (p_plan->'actions' ? coalesce(p_plan->'decision'->>'actionKey', '')) then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  for v_key in select jsonb_array_elements_text(p_plan->'floors') loop
    if not (p_plan->'actions' ? v_key) then
      raise exception 'loop_invalid_plan' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function private.apm_save_goal_plan(p_goal_id uuid, p_plan jsonb, p_source text default 'goals')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_previous uuid;
  v_row public.goal_plans;
begin
  if p_source not in ('intake','goals','backfill','clearance') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_plan(p_plan);
  if p_goal_id is null or not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid) then
    raise exception 'loop_goal_not_found' using errcode = 'P0002';
  end if;

  update public.goal_plans
     set status = 'superseded', updated_at = now()
   where user_id = v_uid and goal_id = p_goal_id and status <> 'superseded'
  returning id into v_previous;

  insert into public.goal_plans (
    user_id, goal_id, plan_key, template_key, persona, foreground_pillar,
    start_date, end_date, timezone, plan
  ) values (
    v_uid, p_goal_id, p_plan->>'id', p_plan->'provenance'->>'templateKey', p_plan->'persona'->>'key',
    p_plan->'foreground'->>'pillar', (p_plan->>'startDate')::date, (p_plan->>'endDate')::date,
    nullif(p_plan->>'timezone', ''), p_plan
  )
  returning * into v_row;

  perform private.apm_loop_audit(
    v_uid,
    case when v_previous is null then 'goal_plan.created' else 'goal_plan.replaced' end,
    'goal_plan', v_row.id::text,
    jsonb_build_object('goalId', p_goal_id, 'templateKey', v_row.template_key, 'persona', v_row.persona,
                       'source', p_source, 'replaced', v_previous, 'referral', (p_plan->'safety'->>'referral')::boolean)
  );
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_create_goal(p_goal jsonb, p_plan jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_key text;
  v_title text := btrim(coalesce(p_goal->>'title', ''));
  v_pillar text := nullif(p_goal->>'pillar', '');
  v_target date;
  v_goal public.goals;
  v_plan jsonb;
begin
  if p_goal is null or jsonb_typeof(p_goal) <> 'object' then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_goal) loop
    if v_key not in ('title','outcome','pillar','targetDate') then
      raise exception 'loop_field_not_allowed' using errcode = '22023';
    end if;
  end loop;
  if char_length(v_title) not between 3 and 300 or char_length(coalesce(p_goal->>'outcome', '')) > 800 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if v_pillar is not null and v_pillar not in ('wealth','body','spirit','execution','family') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  begin
    v_target := nullif(p_goal->>'targetDate', '')::date;
  exception when others then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end;
  if private.apm_loop_week_one_locked(v_uid) then
    raise exception 'loop_week_one_lock' using errcode = '55000';
  end if;

  insert into public.goals (user_id, title, outcome, status, health, pillar, target_date, priority, provenance_kind, source_type, confidence)
  values (
    v_uid, v_title, nullif(btrim(coalesce(p_goal->>'outcome', '')), ''), 'active', 'unknown', v_pillar, v_target,
    coalesce((select max(g.priority) from public.goals g where g.user_id = v_uid and g.status = 'active'), 0) + 1,
    'stated', 'manual', 1
  )
  returning * into v_goal;

  perform private.apm_loop_audit(v_uid, 'goal.created', 'goal', v_goal.id::text, jsonb_build_object('pillar', v_pillar, 'priority', v_goal.priority));
  v_plan := private.apm_save_goal_plan(v_goal.id, p_plan, 'goals');
  return jsonb_build_object('goal', to_jsonb(v_goal), 'plan', v_plan);
end;
$$;

-- The Arbitration Engine's choice is a recommendation; the user declares the foreground.
create or replace function private.apm_set_foreground_goal(p_goal_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_previous uuid;
begin
  if not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid and g.status = 'active') then
    raise exception 'loop_goal_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.personal_os p where p.user_id = v_uid) then
    raise exception 'loop_personal_os_missing' using errcode = 'P0002';
  end if;
  select p.foreground_goal_id into v_previous from public.personal_os p where p.user_id = v_uid;
  if v_previous is not distinct from p_goal_id then
    return jsonb_build_object('foregroundGoalId', p_goal_id, 'changed', false);
  end if;
  if private.apm_loop_week_one_locked(v_uid) then
    raise exception 'loop_week_one_lock' using errcode = '55000';
  end if;
  update public.personal_os set foreground_goal_id = p_goal_id, updated_at = now() where user_id = v_uid;
  update public.projects set foreground = (goal_id = p_goal_id), updated_at = now() where user_id = v_uid and status = 'active';
  perform private.apm_loop_audit(v_uid, 'foreground.changed', 'goal', p_goal_id::text, jsonb_build_object('from', v_previous, 'to', p_goal_id));
  return jsonb_build_object('foregroundGoalId', p_goal_id, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------- day loop writes
create or replace function private.apm_loop_check_agenda(p_agenda jsonb, p_day date)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_agenda is null or jsonb_typeof(p_agenda) <> 'object'
     or coalesce(p_agenda->>'version', '') <> '1'
     or coalesce(p_agenda->>'date', '') <> p_day::text
     or coalesce(p_agenda->>'state', '') not in ('normal','recovery','missed_yesterday')
     or coalesce(p_agenda->>'mode', '') not in ('standard','recovery')
     or jsonb_typeof(p_agenda->'dailyStack') <> 'array'
     or jsonb_typeof(p_agenda->'firstHour') <> 'object'
     or pg_catalog.octet_length(p_agenda::text) > 65536
  then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
end;
$$;

-- Morning check-in = the opening step. Locks the agenda for the day; the mood is
-- recorded once (it cannot be renegotiated mid-day).
create or replace function private.apm_day_check_in(p_day date, p_mood integer, p_state text, p_agenda jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.day_records;
begin
  if p_day is distinct from private.apm_local_today(v_uid) then
    raise exception 'loop_day_not_today' using errcode = '22023';
  end if;
  if p_mood is null or p_mood not between 1 and 10 or p_state not in ('normal','recovery','missed_yesterday') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  if (p_agenda->>'state') <> p_state then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;

  insert into public.day_records (user_id, day, mode, mood, day_state, agenda, agenda_status, checked_in_at, updated_at)
  values (v_uid, p_day, coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
          p_mood, p_state, p_agenda, 'locked', now(), now())
  on conflict (user_id, day) do update
     set mood = excluded.mood, day_state = excluded.day_state, agenda = excluded.agenda,
         agenda_status = 'locked', checked_in_at = excluded.checked_in_at, updated_at = now()
   where public.day_records.checked_in_at is null and public.day_records.closed_at is null
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.day_records d where d.user_id = v_uid and d.day = p_day;
    return jsonb_build_object('day', to_jsonb(v_row), 'replayed', true);
  end if;
  perform private.apm_loop_audit(v_uid, 'day.checked_in', 'day_record', v_row.id::text,
    jsonb_build_object('state', p_state, 'mvd', p_mood <= 2 or p_state <> 'normal'));
  return jsonb_build_object('day', to_jsonb(v_row), 'replayed', false);
end;
$$;

-- Law 4: only a declared external change, safety issue or permission change reopens the day.
create or replace function private.apm_day_replan(p_day date, p_reason text, p_detail text, p_agenda jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.day_records;
begin
  if p_day is distinct from private.apm_local_today(v_uid) then
    raise exception 'loop_day_not_today' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('external_change','safety','permission') then
    raise exception 'loop_no_midday_negotiation' using errcode = '55000';
  end if;
  if char_length(coalesce(p_detail, '')) > 300 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  select * into v_row from public.day_records d where d.user_id = v_uid and d.day = p_day for update;
  if v_row.id is null or v_row.agenda_status is distinct from 'locked' then
    raise exception 'loop_day_not_locked' using errcode = '55000';
  end if;
  if v_row.closed_at is not null then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  if jsonb_array_length(v_row.replans) >= 3 then
    raise exception 'loop_replan_limit' using errcode = '55000';
  end if;
  update public.day_records
     set agenda = p_agenda,
         day_state = p_agenda->>'state',
         replans = replans || jsonb_build_array(jsonb_build_object('reason', p_reason, 'detail', nullif(btrim(coalesce(p_detail, '')), ''), 'at', now())),
         updated_at = now()
   where id = v_row.id
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.replanned', 'day_record', v_row.id::text, jsonb_build_object('reason', p_reason));
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_complete_plan_action(p_plan_id uuid, p_action_key text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_plan public.goal_plans;
  v_day public.day_records;
  v_item jsonb;
  v_row public.plan_action_completions;
  v_evidence uuid;
begin
  if char_length(coalesce(p_note, '')) > 500 or char_length(coalesce(p_action_key, '')) not between 1 and 120 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  select * into v_plan from public.goal_plans gp where gp.id = p_plan_id and gp.user_id = v_uid and gp.status <> 'superseded';
  if v_plan.id is null then
    raise exception 'loop_plan_not_found' using errcode = 'P0002';
  end if;
  select * into v_day from public.day_records d where d.user_id = v_uid and d.day = v_today;
  if v_day.id is null or v_day.checked_in_at is null then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  if v_day.closed_at is not null then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  select item into v_item
    from (
      select v_day.agenda->'firstHour'->'priority' as item
      union all
      select e from jsonb_array_elements(v_day.agenda->'dailyStack') e
    ) items
   where item->>'planId' = p_plan_id::text and item->>'actionKey' = p_action_key
   limit 1;
  if v_item is null then
    raise exception 'loop_not_on_agenda' using errcode = 'P0002';
  end if;

  insert into public.plan_action_completions (user_id, plan_id, day, action_key, instance_id, scope, role, note)
  values (
    v_uid, p_plan_id, v_today, p_action_key,
    v_plan.plan_key || ':' || v_today::text || ':' || p_action_key,
    case when v_item->>'scope' = 'mvd' then 'mvd' else 'standard' end,
    case when v_item->>'kind' = 'plan_action' then 'foreground' else 'floor' end,
    nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (plan_id, day, action_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.plan_action_completions c where c.plan_id = p_plan_id and c.day = v_today and c.action_key = p_action_key;
    return jsonb_build_object('completion', to_jsonb(v_row), 'replayed', true);
  end if;

  insert into public.evidence (user_id, kind, summary, source_type, source_ref, related_goal_id)
  values (v_uid, 'user_completion', left('Completed: ' || coalesce(v_item->>'title', p_action_key), 500), 'manual',
          'plan:' || p_plan_id::text || ':' || v_today::text || ':' || p_action_key, v_plan.goal_id)
  returning id into v_evidence;
  update public.plan_action_completions set evidence_id = v_evidence where id = v_row.id returning * into v_row;
  update public.day_records set completed_action_ids = array_append(completed_action_ids, v_row.id), updated_at = now() where id = v_day.id;

  perform private.apm_loop_audit(v_uid, 'plan_action.completed', 'goal_plan', p_plan_id::text,
    jsonb_build_object('actionKey', p_action_key, 'day', v_today, 'scope', v_row.scope, 'role', v_row.role));
  return jsonb_build_object('completion', to_jsonb(v_row), 'replayed', false);
end;
$$;

-- Same formula as packages/planning reviewGateVerdict / reviewPlanGate.
create or replace function private.apm_loop_gate_verdict(p_completed_days integer, p_window integer, p_evidence integer, p_aligned boolean)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when not p_aligned then 'park'
    when round(least(greatest(p_completed_days, 0), p_window)::numeric / p_window * 100) / 10 >= 7 and p_evidence > 0 then 'promote'
    when round(least(greatest(p_completed_days, 0), p_window)::numeric / p_window * 100) / 10 >= 3 or p_evidence > 0 then 'maintain'
    else 'park'
  end;
$$;

create or replace function private.apm_review_plan_gate(p_plan_id uuid, p_gate text, p_still_aligned boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_plan public.goal_plans;
  v_gate jsonb;
  v_start date;
  v_end date;
  v_days integer;
  v_count integer;
  v_review jsonb;
begin
  if p_gate not in ('foundation','build') or p_still_aligned is null then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  select * into v_plan from public.goal_plans gp where gp.id = p_plan_id and gp.user_id = v_uid and gp.status <> 'superseded' for update;
  if v_plan.id is null then
    raise exception 'loop_plan_not_found' using errcode = 'P0002';
  end if;
  if v_plan.gate_reviews ? p_gate then
    return to_jsonb(v_plan);
  end if;
  select g into v_gate from jsonb_array_elements(v_plan.plan->'gates') g where g->>'key' = p_gate;
  v_start := (v_gate->>'startDate')::date;
  v_end := (v_gate->>'endDate')::date;
  if private.apm_local_today(v_uid) < v_end then
    raise exception 'loop_gate_not_reached' using errcode = '55000';
  end if;
  select count(distinct c.day), count(*) into v_days, v_count
    from public.plan_action_completions c where c.plan_id = p_plan_id and c.day between v_start and v_end;
  v_review := jsonb_build_object(
    'verdict', private.apm_loop_gate_verdict(v_days, v_end - v_start + 1, v_count, p_still_aligned),
    'stillAligned', p_still_aligned, 'completedDays', v_days, 'evidenceCount', v_count, 'reviewedAt', now());
  update public.goal_plans set gate_reviews = gate_reviews || jsonb_build_object(p_gate, v_review), updated_at = now()
   where id = p_plan_id returning * into v_plan;
  perform private.apm_loop_audit(v_uid, 'goal_plan.gate_reviewed', 'goal_plan', p_plan_id::text,
    jsonb_build_object('gate', p_gate, 'verdict', v_review->>'verdict'));
  return to_jsonb(v_plan);
end;
$$;

-- Day 90: the forced Promote / Maintain / Park decision. Parking is a valid outcome.
create or replace function private.apm_decide_goal_plan(p_plan_id uuid, p_decision text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_plan public.goal_plans;
  v_days integer;
  v_count integer;
  v_recommended text;
begin
  if p_decision not in ('promote','maintain','park') or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  select * into v_plan from public.goal_plans gp where gp.id = p_plan_id and gp.user_id = v_uid and gp.status <> 'superseded' for update;
  if v_plan.id is null then
    raise exception 'loop_plan_not_found' using errcode = 'P0002';
  end if;
  if v_plan.status = 'decided' then
    raise exception 'loop_already_decided' using errcode = '55000';
  end if;
  if private.apm_local_today(v_uid) < v_plan.end_date then
    raise exception 'loop_decision_not_due' using errcode = '55000';
  end if;
  select count(distinct c.day), count(*) into v_days, v_count
    from public.plan_action_completions c where c.plan_id = p_plan_id and c.day between v_plan.start_date and v_plan.end_date;
  v_recommended := private.apm_loop_gate_verdict(v_days, 90, v_count, true);
  update public.goal_plans
     set status = 'decided', decision = p_decision, decision_reason = btrim(p_reason), decided_at = now(),
         gate_reviews = gate_reviews || jsonb_build_object('establish', jsonb_build_object(
           'verdict', p_decision, 'recommended', v_recommended, 'stillAligned', p_decision <> 'park',
           'completedDays', v_days, 'evidenceCount', v_count, 'reviewedAt', now())),
         updated_at = now()
   where id = p_plan_id
  returning * into v_plan;
  if p_decision = 'park' then
    update public.projects set status = 'parked', foreground = false, updated_at = now() where user_id = v_uid and goal_id = v_plan.goal_id;
    update public.personal_os set foreground_goal_id = null, updated_at = now() where user_id = v_uid and foreground_goal_id = v_plan.goal_id;
  end if;
  perform private.apm_loop_audit(v_uid, 'goal_plan.decided', 'goal_plan', p_plan_id::text,
    jsonb_build_object('decision', p_decision, 'recommended', v_recommended));
  return to_jsonb(v_plan);
end;
$$;

-- Closing the day: always the user's LOCAL today (prior days are closed forever).
drop function if exists public.apm_close_day(text, text);
create or replace function private.apm_close_day(p_verdict text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_row public.day_records;
begin
  if p_verdict not in ('full_day','mvd','miss') or char_length(coalesce(p_note, '')) > 1000 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  insert into public.day_records (user_id, day, mode, verdict, completed_action_ids, note, closed_at, updated_at)
  values (
    v_uid, v_today,
    coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
    p_verdict,
    coalesce((select array_agg(c.id) from public.plan_action_completions c where c.user_id = v_uid and c.day = v_today), '{}'),
    nullif(btrim(coalesce(p_note, '')), ''),
    now(), now()
  )
  on conflict (user_id, day) do update set
    verdict = excluded.verdict,
    completed_action_ids = excluded.completed_action_ids,
    note = excluded.note,
    closed_at = excluded.closed_at,
    updated_at = now()
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.closed', 'day_record', v_row.id::text, jsonb_build_object('verdict', p_verdict, 'day', v_today));
  return to_jsonb(v_row);
end;
$$;

-- Owner-only data-rights export (no entitlement gate: a downgraded user still gets their data).
create or replace function private.apm_daily_loop_data_rights_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'loop_unauthenticated' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'goalPlans', coalesce((select jsonb_agg(to_jsonb(gp) order by gp.created_at) from public.goal_plans gp where gp.user_id = v_uid), '[]'::jsonb),
    'planActionCompletions', coalesce((select jsonb_agg(to_jsonb(c) order by c.day, c.created_at) from public.plan_action_completions c where c.user_id = v_uid), '[]'::jsonb),
    'dayRecords', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from public.day_records d where d.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------- public RPC surface
create or replace function public.apm_save_goal_plan(p_goal_id uuid, p_plan jsonb, p_source text default 'goals')
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_save_goal_plan(p_goal_id, p_plan, p_source); $$;
create or replace function public.apm_create_goal(p_goal jsonb, p_plan jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_create_goal(p_goal, p_plan); $$;
create or replace function public.apm_set_foreground_goal(p_goal_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_set_foreground_goal(p_goal_id); $$;
create or replace function public.apm_day_check_in(p_day date, p_mood integer, p_state text, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_day_check_in(p_day, p_mood, p_state, p_agenda); $$;
create or replace function public.apm_day_replan(p_day date, p_reason text, p_detail text, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_day_replan(p_day, p_reason, p_detail, p_agenda); $$;
create or replace function public.apm_complete_plan_action(p_plan_id uuid, p_action_key text, p_note text default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_complete_plan_action(p_plan_id, p_action_key, p_note); $$;
create or replace function public.apm_review_plan_gate(p_plan_id uuid, p_gate text, p_still_aligned boolean)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_review_plan_gate(p_plan_id, p_gate, p_still_aligned); $$;
create or replace function public.apm_decide_goal_plan(p_plan_id uuid, p_decision text, p_reason text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_decide_goal_plan(p_plan_id, p_decision, p_reason); $$;
create or replace function public.apm_close_day(p_verdict text, p_note text default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_close_day(p_verdict, p_note); $$;
create or replace function public.apm_daily_loop_data_rights_export()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_daily_loop_data_rights_export(); $$;

-- ---------------------------------------------------------------- grants
revoke all on function private.apm_has_core_access(uuid) from public, anon;
revoke all on function private.apm_loop_require_access() from public, anon;
revoke all on function private.apm_local_today(uuid) from public, anon;
revoke all on function private.apm_loop_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_loop_week_one_locked(uuid) from public, anon;
revoke all on function private.apm_loop_check_plan(jsonb) from public, anon;
revoke all on function private.apm_loop_check_agenda(jsonb, date) from public, anon;
revoke all on function private.apm_loop_gate_verdict(integer, integer, integer, boolean) from public, anon;
revoke all on function private.apm_save_goal_plan(uuid, jsonb, text) from public, anon;
revoke all on function private.apm_create_goal(jsonb, jsonb) from public, anon;
revoke all on function private.apm_set_foreground_goal(uuid) from public, anon;
revoke all on function private.apm_day_check_in(date, integer, text, jsonb) from public, anon;
revoke all on function private.apm_day_replan(date, text, text, jsonb) from public, anon;
revoke all on function private.apm_complete_plan_action(uuid, text, text) from public, anon;
revoke all on function private.apm_review_plan_gate(uuid, text, boolean) from public, anon;
revoke all on function private.apm_decide_goal_plan(uuid, text, text) from public, anon;
revoke all on function private.apm_close_day(text, text) from public, anon;
revoke all on function private.apm_daily_loop_data_rights_export() from public, anon;

grant execute on function private.apm_has_core_access(uuid) to authenticated;
grant execute on function private.apm_loop_require_access() to authenticated;
grant execute on function private.apm_local_today(uuid) to authenticated;
grant execute on function private.apm_loop_week_one_locked(uuid) to authenticated;
grant execute on function private.apm_loop_check_plan(jsonb) to authenticated;
grant execute on function private.apm_loop_check_agenda(jsonb, date) to authenticated;
grant execute on function private.apm_loop_gate_verdict(integer, integer, integer, boolean) to authenticated;
grant execute on function private.apm_save_goal_plan(uuid, jsonb, text) to authenticated;
grant execute on function private.apm_create_goal(jsonb, jsonb) to authenticated;
grant execute on function private.apm_set_foreground_goal(uuid) to authenticated;
grant execute on function private.apm_day_check_in(date, integer, text, jsonb) to authenticated;
grant execute on function private.apm_day_replan(date, text, text, jsonb) to authenticated;
grant execute on function private.apm_complete_plan_action(uuid, text, text) to authenticated;
grant execute on function private.apm_review_plan_gate(uuid, text, boolean) to authenticated;
grant execute on function private.apm_decide_goal_plan(uuid, text, text) to authenticated;
grant execute on function private.apm_close_day(text, text) to authenticated;
grant execute on function private.apm_daily_loop_data_rights_export() to authenticated;

revoke all on function public.apm_save_goal_plan(uuid, jsonb, text) from public, anon;
revoke all on function public.apm_create_goal(jsonb, jsonb) from public, anon;
revoke all on function public.apm_set_foreground_goal(uuid) from public, anon;
revoke all on function public.apm_day_check_in(date, integer, text, jsonb) from public, anon;
revoke all on function public.apm_day_replan(date, text, text, jsonb) from public, anon;
revoke all on function public.apm_complete_plan_action(uuid, text, text) from public, anon;
revoke all on function public.apm_review_plan_gate(uuid, text, boolean) from public, anon;
revoke all on function public.apm_decide_goal_plan(uuid, text, text) from public, anon;
revoke all on function public.apm_close_day(text, text) from public, anon;
revoke all on function public.apm_daily_loop_data_rights_export() from public, anon;

grant execute on function public.apm_save_goal_plan(uuid, jsonb, text) to authenticated;
grant execute on function public.apm_create_goal(jsonb, jsonb) to authenticated;
grant execute on function public.apm_set_foreground_goal(uuid) to authenticated;
grant execute on function public.apm_day_check_in(date, integer, text, jsonb) to authenticated;
grant execute on function public.apm_day_replan(date, text, text, jsonb) to authenticated;
grant execute on function public.apm_complete_plan_action(uuid, text, text) to authenticated;
grant execute on function public.apm_review_plan_gate(uuid, text, boolean) to authenticated;
grant execute on function public.apm_decide_goal_plan(uuid, text, text) to authenticated;
grant execute on function public.apm_close_day(text, text) to authenticated;
grant execute on function public.apm_daily_loop_data_rights_export() to authenticated;
