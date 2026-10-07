-- 0027: daily-loop hardening, sixth Codex pass on PR #14.
--
--  1. A recovery agenda (mood ≤ 2, missed yesterday, Recovery Mode) closes as an MVD at
--     most: completing its one action is the win, and it is recorded as an MVD.
--  2. A submitted agenda must name the canonical foreground: when a plan is running the
--     agenda cannot be planless, and the declared foreground goal's plan is the foreground.
--  3. 30/60 gate reviews, like the day-90 decision, happen after the opening step.

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
    select count(*), count(*) filter (where exists (
             select 1 from public.plan_action_completions c
              where c.user_id = p_user_id and c.day = p_day and c.plan_id::text = item->>'planId' and c.action_key = item->>'actionKey'))
      into v_total, v_done
      from (
        select v_agenda->'firstHour'->'priority' as item
        union all
        select e from jsonb_array_elements(coalesce(v_agenda->'dailyStack', '[]'::jsonb)) e
      ) items
     where item is not null and jsonb_typeof(item) = 'object' and item ? 'planId' and item ? 'actionKey';
  end if;
  -- A recovery agenda (mood ≤ 2, missed yesterday, Recovery Mode) is an MVD day by rule.
  if v_total > 0 and v_done = v_total then
    return case when v_agenda->>'mode' = 'recovery' then 'mvd' else 'full_day' end;
  end if;
  if v_done > 0 or private.apm_loop_has_evidence(p_user_id, p_day) then return 'mvd'; end if;
  return 'miss';
end;
$$;


create or replace function private.apm_loop_check_required_floors(p_user_id uuid, p_agenda jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan_id text := p_agenda->'foregroundPriority'->>'planId';
  v_priority jsonb := p_agenda->'firstHour'->'priority';
  v_plan jsonb;
  v_floor text;
  v_satisfied jsonb;
begin
  if v_plan_id is null then
    -- A planless agenda is only valid when no plan is running.
    if exists (select 1 from public.goal_plans gp join public.goals g on g.id = gp.goal_id and g.status = 'active'
                where gp.user_id = p_user_id and gp.status <> 'superseded' and gp.decision is distinct from 'park') then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
    return;
  end if;
  -- The foreground is the declared foreground goal's plan when it is running.
  if exists (
    select 1 from public.personal_os p
      join public.goal_plans gp on gp.goal_id = p.foreground_goal_id and gp.status <> 'superseded' and gp.decision is distinct from 'park'
      join public.goals g on g.id = gp.goal_id and g.status = 'active'
     where p.user_id = p_user_id and gp.id::text <> v_plan_id
  ) then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  select gp.plan into v_plan from public.goal_plans gp
   where gp.user_id = p_user_id and gp.status <> 'superseded' and gp.id::text = v_plan_id;
  if v_plan is null or v_priority is null or jsonb_typeof(v_priority) <> 'object' or v_priority->>'planId' is distinct from v_plan_id then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  if p_agenda->>'mode' = 'recovery' then
    return; -- MVD is one action by rule.
  end if;
  v_satisfied := coalesce(v_plan->'actions'->(v_priority->>'actionKey')->'satisfiesFloors', '[]'::jsonb);
  for v_floor in select jsonb_array_elements_text(v_plan->'floors') loop
    continue when v_floor = v_priority->>'actionKey' or v_satisfied ? v_floor;
    if not exists (
      select 1 from jsonb_array_elements(coalesce(p_agenda->'dailyStack', '[]'::jsonb)) e
       where e->>'planId' = v_plan_id and e->>'actionKey' = v_floor
    ) then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
  end loop;
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
  if not exists (select 1 from public.day_records d where d.user_id = v_uid and d.day = private.apm_local_today(v_uid) and d.checked_in_at is not null) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
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

