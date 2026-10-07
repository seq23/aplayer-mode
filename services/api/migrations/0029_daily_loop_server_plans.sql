-- 0029: plans and evidence are server-derived too (seventh Codex pass on PR #14).
--
--  1. Goal plans are written only by the Worker, which generates them with the
--     deterministic engine: apm_save_goal_plan / apm_create_goal become service-role
--     only (apm_service_save_goal_plan / apm_service_create_goal). A client can no longer
--     store an easier plan that the agenda would then faithfully follow.
--  2. Evidence is governed: direct inserts/updates/deletes on public.evidence are revoked
--     (only the governed completion functions write it), the legacy next-action
--     completion becomes SECURITY DEFINER, and verdict evidence counts only completions
--     of today's locked agenda — next-action items included in a Full Day.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

drop policy if exists "evidence_insert_own" on public.evidence;
drop policy if exists "evidence_update_own" on public.evidence;
drop policy if exists "evidence_delete_own" on public.evidence;
revoke insert, update, delete, truncate, references, trigger on table public.evidence from authenticated;
revoke all on table public.evidence from anon;
grant select on table public.evidence to authenticated;

-- A next action printed on the agenda counts as done today only with governed evidence.
create or replace function private.apm_loop_next_action_done(p_user_id uuid, p_day date, p_action_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.evidence e
     where e.user_id = p_user_id and e.kind = 'user_completion' and e.related_action_id::text = p_action_id
       and (e.created_at at time zone private.apm_user_timezone(p_user_id))::date = p_day);
$$;

create or replace function private.apm_service_save_goal_plan(p_user_id uuid, p_goal_id uuid, p_plan jsonb, p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_previous uuid;
  v_row public.goal_plans;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
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


create or replace function private.apm_service_create_goal(p_user_id uuid, p_goal jsonb, p_plan jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_key text;
  v_title text := btrim(coalesce(p_goal->>'title', ''));
  v_pillar text := nullif(p_goal->>'pillar', '');
  v_target date;
  v_goal public.goals;
  v_plan jsonb;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
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
  v_plan := private.apm_service_save_goal_plan(v_uid, v_goal.id, p_plan, 'goals');
  return jsonb_build_object('goal', to_jsonb(v_goal), 'plan', v_plan);
end;
$$;


create or replace function private.apm_complete_next_action(p_action_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
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
    -- Only an action printed on today's locked agenda (an MVD holds the backlog).
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_day.agenda->'dailyStack', '[]'::jsonb)) e
       where e->>'nextActionId' = p_action_id::text
    ) and coalesce(v_day.agenda->'firstHour'->'priority'->>'nextActionId', '') <> p_action_id::text then
      raise exception 'loop_not_on_agenda' using errcode = 'P0002';
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


create or replace function private.apm_loop_has_evidence(p_user_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Only governed completion evidence of today's locked agenda counts.
  select exists (select 1 from public.plan_action_completions c where c.user_id = p_user_id and c.day = p_day)
      or exists (
        select 1 from public.day_records d, jsonb_array_elements(coalesce(d.agenda->'dailyStack', '[]'::jsonb)) e
         where d.user_id = p_user_id and d.day = p_day and e ? 'nextActionId'
           and private.apm_loop_next_action_done(p_user_id, p_day, e->>'nextActionId'));
$$;

create or replace function private.apm_loop_max_verdict(p_user_id uuid, p_day date)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_agenda jsonb;
  v_total integer := 0;
  v_done integer := 0;
begin
  select d.agenda into v_agenda from public.day_records d where d.user_id = p_user_id and d.day = p_day;
  if v_agenda is not null then
    select count(*), count(*) filter (where
             (item ? 'planId' and exists (
               select 1 from public.plan_action_completions c
                where c.user_id = p_user_id and c.day = p_day and c.plan_id::text = item->>'planId' and c.action_key = item->>'actionKey'))
          or (item ? 'nextActionId' and private.apm_loop_next_action_done(p_user_id, p_day, item->>'nextActionId')))
      into v_total, v_done
      from (
        select v_agenda->'firstHour'->'priority' as item
        union all
        select e from jsonb_array_elements(coalesce(v_agenda->'dailyStack', '[]'::jsonb)) e
      ) items
     where item is not null and jsonb_typeof(item) = 'object' and ((item ? 'planId' and item ? 'actionKey') or item ? 'nextActionId');
  end if;
  -- A recovery agenda (mood ≤ 2, missed yesterday, Recovery Mode) is an MVD day by rule.
  if v_total > 0 and v_done = v_total then
    return case when v_agenda->>'mode' = 'recovery' then 'mvd' else 'full_day' end;
  end if;
  if v_done > 0 or private.apm_loop_has_evidence(p_user_id, p_day) then return 'mvd'; end if;
  return 'miss';
end;
$$;


drop function if exists public.apm_complete_next_action(uuid);
create or replace function public.apm_complete_next_action(p_action_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_complete_next_action(p_action_id); $$;

create or replace function public.apm_service_save_goal_plan(p_user_id uuid, p_goal_id uuid, p_plan jsonb, p_source text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_save_goal_plan(p_user_id, p_goal_id, p_plan, p_source); $$;
create or replace function public.apm_service_create_goal(p_user_id uuid, p_goal jsonb, p_plan jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_create_goal(p_user_id, p_goal, p_plan); $$;

-- Client-supplied plans are no longer accepted.
revoke all on function public.apm_save_goal_plan(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.apm_create_goal(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_save_goal_plan(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.apm_create_goal(jsonb, jsonb) from public, anon, authenticated;

revoke all on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.apm_service_create_goal(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.apm_service_save_goal_plan(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.apm_service_create_goal(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) to service_role;
grant execute on function private.apm_service_create_goal(uuid, jsonb, jsonb) to service_role;
grant execute on function public.apm_service_save_goal_plan(uuid, uuid, jsonb, text) to service_role;
grant execute on function public.apm_service_create_goal(uuid, jsonb, jsonb) to service_role;

revoke all on function private.apm_complete_next_action(uuid) from public, anon;
grant execute on function private.apm_complete_next_action(uuid) to authenticated;
revoke all on function public.apm_complete_next_action(uuid) from public, anon;
grant execute on function public.apm_complete_next_action(uuid) to authenticated;
revoke all on function private.apm_loop_next_action_done(uuid, date, text) from public, anon;
grant execute on function private.apm_loop_next_action_done(uuid, date, text) to authenticated, service_role;
grant execute on function private.apm_loop_has_evidence(uuid, date) to service_role;
grant execute on function private.apm_loop_max_verdict(uuid, date) to service_role;
grant execute on function private.apm_loop_check_plan(jsonb) to service_role;
grant execute on function private.apm_loop_week_one_locked(uuid) to service_role;
