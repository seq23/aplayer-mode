-- 0022: daily-loop hardening (Codex review of PR #14).
--
--  1. Four pillars stay LOCKED (docs/20-APM-METHODOLOGY-ENGINE-V1.md: Wealth, Body,
--     Spirit, Execution). 0021 had widened goals / pillar_settings / routines to a
--     fifth `family` pillar; that is reverted. `family` remains a PLAN pillar only (the
--     Home Front protected floor of a parent+ plan), as goal_plans and the plan engine use it.
--  2. The stored plan is the source of truth: a check-in, a replan or a printed agenda
--     may only reference the caller's live plans and actions that exist in them, and
--     completion re-checks the action against the stored plan.
--  3. A parked plan never takes the foreground; parking pauses the goal.
--  4. The legacy next-action completion RPC honours the opening step once the daily
--     loop is running (a live goal plan exists): no execution before the check-in, and
--     nothing after the day is closed.

-- ---------------------------------------------------------------- 1. four pillars
insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
select g.user_id, 'goal.pillar_cleared', 'system', 'migration:0022', 'goal', g.id::text, jsonb_build_object('pillar', g.pillar)
  from public.goals g where g.pillar = 'family';
update public.goals set pillar = null, updated_at = now() where pillar = 'family';
update public.routines set pillar = null, updated_at = now() where pillar = 'family';
delete from public.pillar_settings where name = 'family';

alter table public.goals drop constraint if exists goals_pillar_check;
alter table public.goals add constraint goals_pillar_check
  check (pillar is null or pillar in ('wealth','body','spirit','execution'));
alter table public.pillar_settings drop constraint if exists pillar_settings_name_check;
alter table public.pillar_settings add constraint pillar_settings_name_check
  check (name in ('wealth','body','spirit','execution'));
alter table public.routines drop constraint if exists routines_pillar_check;
alter table public.routines add constraint routines_pillar_check
  check (pillar is null or pillar in ('wealth','body','spirit','execution'));

-- 0021's apm_create_goal accepted `family` as a goal pillar; the table check now refuses it.

-- ---------------------------------------------------------------- 2. agenda items vs stored plans
create or replace function private.apm_loop_check_agenda_items(p_user_id uuid, p_agenda jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_plan jsonb;
begin
  for v_item in
    select item from (
      select p_agenda->'firstHour'->'priority' as item
      union all
      select e from jsonb_array_elements(p_agenda->'dailyStack') e
    ) items
    where item is not null and jsonb_typeof(item) = 'object' and item ? 'planId'
  loop
    select gp.plan into v_plan
      from public.goal_plans gp
     where gp.user_id = p_user_id and gp.status <> 'superseded' and gp.id::text = v_item->>'planId';
    if v_plan is null then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
    if not (v_plan->'actions' ? coalesce(v_item->>'actionKey', ''))
       and not (v_item->>'kind' = 'carry_forward' and v_item->>'actionKey' = 'carry_forward') then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
  end loop;
end;
$$;

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
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
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
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
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
  -- The stored plan, not the agenda JSON, is the source of truth for what can be done.
  if not (v_plan.plan->'actions' ? p_action_key) and p_action_key <> 'carry_forward' then
    raise exception 'loop_not_on_agenda' using errcode = 'P0002';
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

-- ---------------------------------------------------------------- 3. parked plans
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
  -- A parked plan never takes the foreground (BHPC Part VII: parking is an allocation choice).
  if exists (select 1 from public.goal_plans gp where gp.goal_id = p_goal_id and gp.user_id = v_uid and gp.status <> 'superseded' and gp.decision = 'park') then
    raise exception 'loop_goal_parked' using errcode = '55000';
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
    update public.goals set status = 'paused', updated_at = now() where user_id = v_uid and id = v_plan.goal_id;
    update public.personal_os set foreground_goal_id = null, updated_at = now() where user_id = v_uid and foreground_goal_id = v_plan.goal_id;
  end if;
  perform private.apm_loop_audit(v_uid, 'goal_plan.decided', 'goal_plan', p_plan_id::text,
    jsonb_build_object('decision', p_decision, 'recommended', v_recommended));
  return to_jsonb(v_plan);
end;
$$;


-- ---------------------------------------------------------------- 4. legacy next-action completion
create or replace function public.apm_complete_next_action(p_action_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_action public.next_actions%rowtype;
  v_evidence public.evidence%rowtype;
  v_day public.day_records%rowtype;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  select * into v_action
    from public.next_actions
   where id = p_action_id and user_id = v_user_id
   for update;

  if not found then
    return null;
  end if;

  -- Once the daily loop runs, execution starts after the opening step and stops at the close.
  if exists (select 1 from public.goal_plans gp where gp.user_id = v_user_id and gp.status <> 'superseded') then
    select * into v_day from public.day_records d where d.user_id = v_user_id and d.day = private.apm_local_today(v_user_id);
    if v_day.id is null or v_day.checked_in_at is null then
      raise exception 'loop_opening_step_required' using errcode = '55000';
    end if;
    if v_day.closed_at is not null then
      raise exception 'loop_day_closed' using errcode = '55000';
    end if;
  end if;

  update public.next_actions
     set status = 'done', updated_at = now()
   where id = p_action_id and user_id = v_user_id
   returning * into v_action;

  insert into public.evidence (
    user_id, kind, summary, source_type, related_goal_id, related_action_id
  ) values (
    v_user_id, 'user_completion', 'User marked complete: ' || v_action.title,
    'manual', v_action.goal_id, v_action.id
  ) returning * into v_evidence;

  return jsonb_build_object(
    'action', to_jsonb(v_action),
    'evidence', to_jsonb(v_evidence)
  );
end;
$$;
revoke all on function public.apm_complete_next_action(uuid) from public, anon;
grant execute on function public.apm_complete_next_action(uuid) to authenticated;

revoke all on function private.apm_loop_check_agenda_items(uuid, jsonb) from public, anon;
grant execute on function private.apm_loop_check_agenda_items(uuid, jsonb) to authenticated;
