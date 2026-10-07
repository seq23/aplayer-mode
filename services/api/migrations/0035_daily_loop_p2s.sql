-- 0035: daily-loop P2s, fixed at source.
--
--  a. next_actions are no longer owner-writable. A user could INSERT/UPDATE their own rows
--     directly (e.g. set status = 'done'), and private.apm_loop_next_action_done counts that
--     as completion evidence for the verdict. The insert/update/delete policies and grants
--     are dropped; the two intake RPCs (SECURITY INVOKER) seed through a definer writer, and
--     completion stays private.apm_complete_next_action (0029).
--  b. Phase Bridge pacing is enforced in the database, not only in the app: completing the
--     First Hour priority needs the First Hour to have begun, a Daily Stack item needs the
--     stack to be open (phase = 'executing'), and 'executing' can only follow 'first_hour'.
--  c/d. A plan rebuild — body referral, clinician clearance, or a Drafting Room pillar-floor
--     change — must keep the live plan's start date (and its gate reviews); the 90 days
--     never restart. The Worker regenerates with the original start; the database refuses
--     anything else (loop_plan_restart_refused).

-- ---------------------------------------------------------------- a. next_actions RPC-only
drop policy if exists "next_actions_insert_own" on public.next_actions;
drop policy if exists "next_actions_update_own" on public.next_actions;
drop policy if exists "next_actions_delete_own" on public.next_actions;
revoke insert, update, delete, truncate, references, trigger on table public.next_actions from anon, authenticated;

create or replace function private.apm_seed_next_action(p_goal_id uuid, p_title text, p_replace boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 500
     or not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid) then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if coalesce(p_replace, false) then
    update public.next_actions set status = 'dismissed', updated_at = now()
     where user_id = v_uid and goal_id = p_goal_id and status = 'open';
  end if;
  -- A seed is always an OPEN action: completion is only ever the governed RPC.
  insert into public.next_actions (user_id, goal_id, title, status, estimated_minutes)
  values (v_uid, p_goal_id, btrim(p_title), 'open', 45)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.apm_seed_next_action(uuid, text, boolean) from public, anon;
grant execute on function private.apm_seed_next_action(uuid, text, boolean) to authenticated;

create or replace function public.apm_save_onboarding(
  p_display_name text,
  p_roles text[],
  p_primary_goal text,
  p_current_season text default null,
  p_becoming text default null,
  p_pillar text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid := gen_random_uuid();
  v_role text;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  insert into public.user_profiles (user_id, display_name, current_season, becoming, updated_at)
  values (v_user_id, p_display_name, p_current_season, p_becoming, now())
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  foreach v_role in array p_roles loop
    insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
    values (v_user_id, v_role, true, 'stated', 'manual', 1);
  end loop;

  update public.goals
     set priority = priority + 1,
         updated_at = now()
   where user_id = v_user_id;

  insert into public.goals (
    id, user_id, title, status, health, pillar, priority,
    provenance_kind, source_type, confidence
  ) values (
    v_goal_id, v_user_id, p_primary_goal, 'active', 'unknown', p_pillar, 1,
    'stated', 'manual', 1
  );

  -- next_actions are RPC-only (0035): the seed goes through the governed writer.
  perform private.apm_seed_next_action(v_goal_id, 'Spend 45 focused minutes advancing: ' || p_primary_goal, false);
end;
$$;

create or replace function public.apm_save_methodology_intake(p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid;
  v_role text;
  v_track_key text;
  v_track_name text;
  v_pillar text;
  v_primary_goal text := nullif(trim(p_payload->>'primary_goal'), '');
  v_first_action text := nullif(trim(p_payload->>'first_next_action'), '');
  v_active_mode text := coalesce(nullif(p_payload->>'active_mode', ''), 'standard');
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;
  if v_primary_goal is null then
    raise exception 'primary_goal_required';
  end if;
  if v_active_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;

  insert into public.user_profiles (user_id, display_name, timezone, current_season, becoming, updated_at)
  values (
    v_user_id,
    coalesce(p_payload->>'display_name', ''),
    nullif(p_payload->>'timezone', ''),
    nullif(p_payload->>'current_season', ''),
    nullif(p_payload->>'becoming', ''),
    now()
  )
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    timezone = excluded.timezone,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  for v_role in select jsonb_array_elements_text(coalesce(p_payload->'roles', '[]'::jsonb))
  loop
    if trim(v_role) <> '' then
      insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
      values (v_user_id, trim(v_role), true, 'stated', 'manual', 1)
      on conflict (user_id, name) do update set active = true;
    end if;
  end loop;

  select id into v_goal_id
    from public.goals
   where user_id = v_user_id and status = 'active' and priority = 1
   order by updated_at desc
   limit 1;

  if v_goal_id is null then
    v_goal_id := gen_random_uuid();
    update public.goals
       set priority = priority + 1, updated_at = now()
     where user_id = v_user_id;

    insert into public.goals (
      id, user_id, title, outcome, status, health, pillar, target_date, priority,
      provenance_kind, source_type, confidence
    ) values (
      v_goal_id,
      v_user_id,
      v_primary_goal,
      nullif(p_payload->>'goal_outcome', ''),
      'active',
      'unknown',
      nullif(p_payload->>'pillar', ''),
      nullif(p_payload->>'goal_target_date', '')::date,
      1,
      'stated',
      'manual',
      1
    );
  else
    update public.goals
       set title = v_primary_goal,
           outcome = nullif(p_payload->>'goal_outcome', ''),
           pillar = nullif(p_payload->>'pillar', ''),
           target_date = nullif(p_payload->>'goal_target_date', '')::date,
           updated_at = now()
     where id = v_goal_id and user_id = v_user_id;
  end if;

  -- next_actions are RPC-only (0035): seeds go through the governed writer.
  if v_first_action is not null then
    perform private.apm_seed_next_action(v_goal_id, v_first_action, true);
  elsif not exists (
    select 1 from public.next_actions
     where user_id = v_user_id and goal_id = v_goal_id and status = 'open'
  ) then
    perform private.apm_seed_next_action(v_goal_id, 'Spend 45 focused minutes advancing: ' || v_primary_goal, false);
  end if;

  insert into public.personal_os (
    user_id, north_star, core_values, non_negotiables, failure_patterns,
    body_context, work_money_context, mind_spirit_learning_context,
    weekly_cadence, coaching_style, accountability, active_mode, foreground_goal_id,
    installed_at, updated_at
  ) values (
    v_user_id,
    nullif(p_payload->>'north_star', ''),
    coalesce(p_payload->'values', '[]'::jsonb),
    coalesce(p_payload->'non_negotiables', '[]'::jsonb),
    coalesce(p_payload->'failure_patterns', '[]'::jsonb),
    nullif(p_payload->>'body_context', ''),
    nullif(p_payload->>'work_money_context', ''),
    nullif(p_payload->>'mind_spirit_learning_context', ''),
    coalesce(p_payload->'weekly_cadence', '{"heavyDays":[],"lightDays":[]}'::jsonb),
    coalesce(p_payload->'coaching_style', '{"firmness":"direct"}'::jsonb),
    coalesce(p_payload->'accountability', '{"dayStart":"guided"}'::jsonb),
    v_active_mode,
    v_goal_id,
    now(),
    now()
  )
  on conflict (user_id) do update set
    north_star = excluded.north_star,
    core_values = excluded.core_values,
    non_negotiables = excluded.non_negotiables,
    failure_patterns = excluded.failure_patterns,
    body_context = excluded.body_context,
    work_money_context = excluded.work_money_context,
    mind_spirit_learning_context = excluded.mind_spirit_learning_context,
    weekly_cadence = excluded.weekly_cadence,
    coaching_style = excluded.coaching_style,
    accountability = excluded.accountability,
    active_mode = excluded.active_mode,
    foreground_goal_id = excluded.foreground_goal_id,
    updated_at = now();

  delete from public.pillar_settings where user_id = v_user_id;
  foreach v_pillar in array array['wealth','body','spirit','execution']
  loop
    insert into public.pillar_settings (user_id, name, active, critical, minimum_floor)
    values (
      v_user_id,
      v_pillar,
      true,
      exists (
        select 1
          from jsonb_array_elements_text(coalesce(p_payload->'critical_pillars', '[]'::jsonb)) as cp(value)
         where cp.value = v_pillar
      ),
      nullif(p_payload->'minimum_floors'->>v_pillar, '')
    );
  end loop;

  delete from public.tracks where user_id = v_user_id;
  for v_track_key in select jsonb_array_elements_text(coalesce(p_payload->'track_keys', '[]'::jsonb))
  loop
    v_track_name := case v_track_key
      when 'billionaire_mindset' then 'Billionaire Mindset'
      when 'operator_discipline' then 'Operator Discipline'
      when 'strategic_patience' then 'Strategic Patience'
      when 'manifestation_mastery' then 'Manifestation Mastery'
      when 'investor_ai_leverage' then 'Investor + AI Leverage'
      else null
    end;
    if v_track_name is not null then
      insert into public.tracks (user_id, key, name, active, foreground, provenance_kind, source_type, confidence)
      values (v_user_id, v_track_key, v_track_name, true, false, 'stated', 'manual', 1);
    end if;
  end loop;

  delete from public.operating_modes where user_id = v_user_id;
  insert into public.operating_modes (user_id, key, name, active, provenance_kind, source_type, confidence)
  values
    (v_user_id, 'standard', 'Standard', v_active_mode = 'standard', 'system', 'system', 1),
    (v_user_id, 'recovery', 'Recovery', v_active_mode = 'recovery', 'system', 'system', 1),
    (v_user_id, 'high_pressure', 'High-Pressure Coaching', v_active_mode = 'high_pressure', 'system', 'system', 1),
    (v_user_id, 'executive_review', 'Executive Review', v_active_mode = 'executive_review', 'system', 'system', 1);
end;
$$;

-- ---------------------------------------------------------------- b. Phase Bridge
create or replace function private.apm_loop_require_phase(p_day public.day_records, p_first_hour boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_day.phase is null then
    raise exception 'loop_first_hour_not_started' using errcode = '55000';
  end if;
  if not coalesce(p_first_hour, false) and p_day.phase <> 'executing' then
    raise exception 'loop_stack_not_open' using errcode = '55000';
  end if;
end;
$$;
revoke all on function private.apm_loop_require_phase(public.day_records, boolean) from public, anon;
grant execute on function private.apm_loop_require_phase(public.day_records, boolean) to authenticated, service_role;

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
  if p_action_key <> 'carry_forward' and not private.apm_loop_track_floor_allowed(v_uid, p_action_key)
     and not (p_action_key = any (private.apm_loop_allowed_actions(v_plan.plan, v_today))) then
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
  -- Phase Bridge pacing, server-side (0035): the First Hour starts on the user's word,
  -- and the Daily Stack opens only after it.
  perform private.apm_loop_require_phase(v_day, v_day.agenda->'firstHour'->'priority' = v_item);

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
    -- Phase Bridge pacing, server-side (0035).
    perform private.apm_loop_require_phase(v_day,
      coalesce(v_day.agenda->'firstHour'->'priority'->>'nextActionId', '') = p_action_id::text);
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

create or replace function private.apm_set_day_phase(p_phase text)
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
  if coalesce(p_phase, '') not in ('first_hour','executing') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
  -- Phase Bridge (0035): the Daily Stack opens only after the First Hour has begun.
  if p_phase = 'executing' and not exists (
    select 1 from public.day_records d
     where d.user_id = v_uid and d.day = private.apm_local_today(v_uid) and d.phase in ('first_hour','executing')
  ) then
    raise exception 'loop_first_hour_not_started' using errcode = '55000';
  end if;
  update public.day_records d
     set phase = case when d.phase = 'executing' then 'executing' else p_phase end, updated_at = now()
   where d.user_id = v_uid and d.day = private.apm_local_today(v_uid) and d.checked_in_at is not null and d.closed_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'loop_opening_step_required' using errcode = '55000'; end if;
  perform private.apm_loop_audit(v_uid, 'day.phase', 'day_record', v_row.id::text, jsonb_build_object('phase', v_row.phase));
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------- c/d. rebuilds never restart the 90 days
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
  v_live public.goal_plans;
  v_row public.goal_plans;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  if p_source not in ('intake','goals','backfill','clearance','referral','os_change') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_plan(p_plan);
  -- Body red-flag pause (Body Foundation): until clinician clearance is recorded, a body
  -- plan must carry the referral stop.
  if p_plan->'persona'->>'foregroundPersona' = 'weight_loss'
     and coalesce((p_plan->'safety'->>'referral')::boolean, false) = false
     and exists (select 1 from public.personal_os p where p.user_id = v_uid and p.body_referral_at is not null) then
    raise exception 'loop_body_referral_active' using errcode = '55000';
  end if;
  if p_goal_id is null or not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid) then
    raise exception 'loop_goal_not_found' using errcode = 'P0002';
  end if;

  -- A rebuild (referral, clearance, a Drafting Room change) reshapes the plan; it never
  -- restarts its 90 days (0035). It must keep the live plan's start date, and it keeps
  -- the gate reviews already recorded. Only a new plan from intake/goals may start fresh.
  select * into v_live from public.goal_plans gp
   where gp.user_id = v_uid and gp.goal_id = p_goal_id and gp.status <> 'superseded'
   order by gp.created_at desc limit 1;
  if p_source in ('referral','clearance','os_change')
     and (v_live.id is null or (p_plan->>'startDate')::date is distinct from v_live.start_date) then
    raise exception 'loop_plan_restart_refused' using errcode = '55000';
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
  if p_source in ('referral','clearance','os_change') then
    update public.goal_plans set gate_reviews = v_live.gate_reviews where id = v_row.id returning * into v_row;
  end if;

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

-- CREATE OR REPLACE keeps each function's ACL; re-asserted for the reviewer.
revoke all on function private.apm_complete_plan_action(uuid, text, text) from public, anon;
grant execute on function private.apm_complete_plan_action(uuid, text, text) to authenticated;
revoke all on function private.apm_complete_next_action(uuid) from public, anon;
grant execute on function private.apm_complete_next_action(uuid) to authenticated;
revoke all on function private.apm_set_day_phase(text) from public, anon;
grant execute on function private.apm_set_day_phase(text) to authenticated;
revoke all on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) to service_role;
