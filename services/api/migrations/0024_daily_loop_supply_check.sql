-- 0024: daily-loop hardening, third Codex pass on PR #14.
--
--  1. Agendas and completions are checked against what the plan can supply ON THAT DAY
--     (setup day, weekly cadence of the current gate, floors, the day-90 decision, the
--     post-plan cadence) — the same key selection as packages/planning
--     supplyDailyActions, so an off-schedule action (e.g. the day-90 decision on day 1)
--     can never be locked in or completed.
--  2. The Mood Gate (mood ≤ 2 → recovery agenda) and Never Miss Twice (a missed
--     yesterday is never a normal day) are enforced at check-in.
--  3. A closed day stays closed, and a Full Day / MVD needs completion evidence from
--     today; a Miss is always allowed.

create or replace function private.apm_user_timezone(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select up.timezone from public.user_profiles up
                    where up.user_id = p_user_id
                      and exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = up.timezone)), 'UTC');
$$;

create or replace function private.apm_loop_allowed_actions(p_plan jsonb, p_day date)
returns text[]
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_start date := (p_plan->>'startDate')::date;
  v_index integer := p_day - (p_plan->>'startDate')::date + 1;
  v_weekday integer := extract(dow from p_day)::integer;
  v_keys text[];
  v_gate jsonb;
  v_setup text;
begin
  select coalesce(array_agg(f), '{}') into v_keys from jsonb_array_elements_text(p_plan->'floors') f;
  if v_index < 1 then
    v_keys := v_keys || coalesce(p_plan->'setup'->0->>'actionKey', '');
    select s->>'actionKey' into v_setup from jsonb_array_elements(p_plan->'gates'->0->'weeklyCadence') s
     where (s->>'weekday')::integer = extract(dow from v_start)::integer;
    return v_keys || coalesce(v_setup, '');
  end if;
  if v_index >= 90 then
    v_keys := v_keys || coalesce(p_plan->'decision'->>'actionKey', '');
    v_gate := p_plan->'gates'->2;
  else
    select g into v_gate from jsonb_array_elements(p_plan->'gates') g
     where v_index between (g->>'startDay')::integer and (g->>'endDay')::integer;
    select s->>'actionKey' into v_setup from jsonb_array_elements(p_plan->'setup') s where (s->>'day')::integer = v_index;
    if v_setup is not null then v_keys := v_keys || v_setup; end if;
  end if;
  select s->>'actionKey' into v_setup from jsonb_array_elements(coalesce(v_gate->'weeklyCadence', '[]'::jsonb)) s
   where (s->>'weekday')::integer = v_weekday;
  return v_keys || coalesce(v_setup, '');
end;
$$;

-- Same rule as packages/planning deriveDayState.
create or replace function private.apm_loop_missed_yesterday(p_user_id uuid, p_day date)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first date;
  v_verdict text;
  v_closed boolean;
begin
  select min(gp.start_date) into v_first from public.goal_plans gp where gp.user_id = p_user_id and gp.status <> 'superseded';
  if v_first is null or p_day - 1 < v_first then
    return false;
  end if;
  select d.verdict, d.verdict is not null into v_verdict, v_closed from public.day_records d where d.user_id = p_user_id and d.day = p_day - 1;
  if v_verdict = 'miss' then return true; end if;
  if coalesce(v_closed, false) then return false; end if;
  return not exists (select 1 from public.plan_action_completions c where c.user_id = p_user_id and c.day = p_day - 1);
end;
$$;

create or replace function private.apm_loop_has_evidence(p_user_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.plan_action_completions c where c.user_id = p_user_id and c.day = p_day)
      or exists (select 1 from public.evidence e
                  where e.user_id = p_user_id and e.kind = 'user_completion'
                    and (e.created_at at time zone private.apm_user_timezone(p_user_id))::date = p_day);
$$;

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
    if not (v_item->>'kind' = 'carry_forward' and v_item->>'actionKey' = 'carry_forward')
       and not (coalesce(v_item->>'actionKey', '') = any (private.apm_loop_allowed_actions(v_plan, (p_agenda->>'date')::date))) then
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
  -- The Mood Gate and Never Miss Twice are enforced here too, not only in the app.
  if (p_mood <= 2 or p_state <> 'normal') and p_agenda->>'mode' <> 'recovery' then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  if p_state = 'normal' and private.apm_loop_missed_yesterday(v_uid, p_day) then
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
  if p_action_key <> 'carry_forward' and not (p_action_key = any (private.apm_loop_allowed_actions(v_plan.plan, v_today))) then
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
  -- Evidence before verdict: once the daily loop runs, a Full Day or an MVD needs the
  -- check-in (the opening step). Without it, the day can still be closed as a Miss.
  if p_verdict <> 'miss' and not private.apm_loop_day_opened(v_uid, v_today) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  if exists (select 1 from public.day_records d where d.user_id = v_uid and d.day = v_today and d.closed_at is not null) then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  -- Evidence before verdict: a win needs completion evidence from today.
  if p_verdict <> 'miss' and not private.apm_loop_has_evidence(v_uid, v_today) then
    raise exception 'loop_verdict_needs_evidence' using errcode = '55000';
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


revoke all on function private.apm_user_timezone(uuid) from public, anon;
revoke all on function private.apm_loop_allowed_actions(jsonb, date) from public, anon;
revoke all on function private.apm_loop_missed_yesterday(uuid, date) from public, anon;
revoke all on function private.apm_loop_has_evidence(uuid, date) from public, anon;
grant execute on function private.apm_user_timezone(uuid) to authenticated;
grant execute on function private.apm_loop_allowed_actions(jsonb, date) to authenticated;
grant execute on function private.apm_loop_missed_yesterday(uuid, date) to authenticated;
grant execute on function private.apm_loop_has_evidence(uuid, date) to authenticated;
