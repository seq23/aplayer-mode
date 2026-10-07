-- 0025: daily-loop hardening, fourth Codex pass on PR #14.
--
--  1. A Full Day needs every action on today's locked agenda done; one completion
--     supports an MVD, none supports only a Miss. The verdict never claims more than
--     the evidence (private.apm_loop_max_verdict).
--  2. A setup day supplies only its setup action (no weekly-cadence action on top),
--     exactly as packages/planning supplyDailyActions.
--  3. Parked plans and paused goals never make a day "missed".

-- 'full_day' when every plan-backed item on the locked agenda has a completion today,
-- 'mvd' when at least one does (or any completion evidence exists), 'miss' otherwise.
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
  if v_total > 0 and v_done = v_total then return 'full_day'; end if;
  if v_done > 0 or private.apm_loop_has_evidence(p_user_id, p_day) then return 'mvd'; end if;
  return 'miss';
end;
$$;
revoke all on function private.apm_loop_max_verdict(uuid, date) from public, anon;
grant execute on function private.apm_loop_max_verdict(uuid, date) to authenticated;

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
    -- A setup day supplies the setup action INSTEAD of the weekly cadence (as supplyDailyActions).
    if v_setup is not null then return v_keys || v_setup; end if;
  end if;
  select s->>'actionKey' into v_setup from jsonb_array_elements(coalesce(v_gate->'weeklyCadence', '[]'::jsonb)) s
   where (s->>'weekday')::integer = v_weekday;
  return v_keys || coalesce(v_setup, '');
end;
$$;


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
  -- Only plans that are still running count (a parked plan supplies nothing to miss).
  select min(gp.start_date) into v_first from public.goal_plans gp
    join public.goals g on g.id = gp.goal_id and g.status = 'active'
   where gp.user_id = p_user_id and gp.status <> 'superseded' and gp.decision is distinct from 'park';
  if v_first is null or p_day - 1 < v_first then
    return false;
  end if;
  select d.verdict, d.verdict is not null into v_verdict, v_closed from public.day_records d where d.user_id = p_user_id and d.day = p_day - 1;
  if v_verdict = 'miss' then return true; end if;
  if coalesce(v_closed, false) then return false; end if;
  return not exists (select 1 from public.plan_action_completions c where c.user_id = p_user_id and c.day = p_day - 1);
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
  -- The verdict can never claim more than the locked agenda's evidence supports.
  if p_verdict = 'full_day' and private.apm_loop_max_verdict(v_uid, v_today) <> 'full_day' then
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

