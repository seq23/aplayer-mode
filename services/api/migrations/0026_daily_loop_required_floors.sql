-- 0026: daily-loop hardening, fifth Codex pass on PR #14.
--
--  1. A locked agenda must contain what the deterministic supply requires: the priority
--     comes from the foreground plan, and on a standard day every floor of that plan not
--     already satisfied by the priority action is on the stack. A Full Day can no longer
--     be manufactured by omitting required floors from a submitted agenda.
--  2. The day-90 decision (Park pauses the goal) happens after the opening step.

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
    return;
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
revoke all on function private.apm_loop_check_required_floors(uuid, jsonb) from public, anon;
grant execute on function private.apm_loop_check_required_floors(uuid, jsonb) to authenticated;

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
  -- The Mood Gate and Never Miss Twice are enforced here too, not only in the app.
  if (p_mood <= 2 or p_state <> 'normal') and p_agenda->>'mode' <> 'recovery' then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  if p_state = 'normal' and private.apm_loop_missed_yesterday(v_uid, p_day) then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  perform private.apm_loop_check_required_floors(v_uid, p_agenda);

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
  perform private.apm_loop_check_required_floors(v_uid, p_agenda);
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
  -- The forced decision is execution: it happens after the opening step.
  if not exists (select 1 from public.day_records d where d.user_id = v_uid and d.day = private.apm_local_today(v_uid) and d.checked_in_at is not null) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
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

