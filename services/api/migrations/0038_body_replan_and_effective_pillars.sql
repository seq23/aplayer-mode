-- 0038: body-safety replans cannot fail after the plan changed; rebuilds use the pillar
-- state in effect today (Codex on PR #24).
--
--  1. A referral/clearance rebuild after check-in replans today through a dedicated,
--     MANDATORY service path: no three-replan limit (and it never counts against it), and
--     only when the referral state really changed. Declared replans count only
--     non-mandatory entries.
--  2. Defence in depth: if a plan was rebuilt in place after today was locked, the locked
--     (server-derived) agenda stays completable, so a failed replan can never strand
--     today's actions.
--  3. Pending pillar rebuilds also return the pillar rows in effect today for pillars with
--     a later, not-yet-effective change, so a rebuild never embeds tomorrow's floor.

create or replace function private.apm_service_day_body_replan(p_user_id uuid, p_day date, p_source text, p_agenda jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_os public.personal_os;
  v_row public.day_records;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  if p_day is distinct from private.apm_local_today(v_uid) then
    raise exception 'loop_day_not_today' using errcode = '22023';
  end if;
  select * into v_os from public.personal_os p where p.user_id = v_uid;
  -- Only a real body-safety transition may use this path: a live referral, or a clearance.
  if p_source = 'referral' then
    if v_os.body_referral_at is null then raise exception 'loop_no_referral' using errcode = '55000'; end if;
  elsif p_source = 'clearance' then
    if v_os.body_referral_at is not null or v_os.clinician_cleared_at is null then raise exception 'loop_no_referral' using errcode = '55000'; end if;
  else
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
  -- Mandatory: never limited, never counted against the three declared replans.
  update public.day_records
     set agenda = p_agenda,
         day_state = p_agenda->>'state',
         replans = replans || jsonb_build_array(jsonb_build_object(
           'reason', case when p_source = 'referral' then 'safety' else 'permission' end,
           'detail', case when p_source = 'referral' then 'Body red flag: body coaching paused until clinician clearance.' else 'Clinician clearance recorded.' end,
           'mandatory', true, 'at', now())),
         updated_at = now()
   where id = v_row.id
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.replanned', 'day_record', v_row.id::text, jsonb_build_object('reason', p_source, 'mandatory', true));
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_service_day_replan(p_user_id uuid, p_day date, p_reason text, p_detail text, p_agenda jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_row public.day_records;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
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
  -- Mandatory body-safety replans (0038) never use up the three declared replans.
  if (select count(*) from jsonb_array_elements(v_row.replans) r where coalesce((r->>'mandatory')::boolean, false) = false) >= 3 then
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
  -- The stored plan, not the agenda JSON, is the source of truth for what can be done —
  -- except when the plan was rebuilt in place AFTER today was locked (0038): the locked,
  -- server-derived agenda is then the day's contract and its items stay completable
  -- (still checked below against the agenda itself).
  if p_action_key <> 'carry_forward' and not private.apm_loop_track_floor_allowed(v_uid, p_action_key)
     and not (p_action_key = any (private.apm_loop_allowed_actions(v_plan.plan, v_today)))
     and not (v_day.checked_in_at is not null and v_plan.updated_at > v_day.checked_in_at) then
    raise exception 'loop_not_on_agenda' using errcode = 'P0002';
  end if;
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

create or replace function private.apm_service_pending_pillar_rebuilds(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- `changes`: due and not yet rebuilt. `effective`: for every pillar that ALSO has a
  -- later change not yet in effect, the pillar row as it stands today (the `previous`
  -- of its earliest future change), so a rebuild never embeds tomorrow's floor.
  select jsonb_build_object(
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'pillar', r.proposed->>'name') order by r.applied_at, r.id)
      from public.os_change_requests r
      where r.user_id = p_user_id and r.field = 'pillar' and r.status = 'applied'
        and r.plans_rebuilt_at is null and r.effective_from <= private.apm_local_today(p_user_id)
    ), '[]'::jsonb),
    'effective', coalesce((
      select jsonb_object_agg(f.name, f.prev)
      from (
        select distinct on (r.proposed->>'name') r.proposed->>'name' as name, coalesce(r.previous, 'null'::jsonb) as prev
        from public.os_change_requests r
        where r.user_id = p_user_id and r.field = 'pillar' and r.status = 'applied'
          and r.effective_from > private.apm_local_today(p_user_id)
        order by r.proposed->>'name', r.applied_at, r.id
      ) f
    ), '{}'::jsonb)
  );
$$;

create or replace function public.apm_service_day_body_replan(p_user_id uuid, p_day date, p_source text, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_day_body_replan(p_user_id, p_day, p_source, p_agenda); $$;

revoke all on function private.apm_service_day_body_replan(uuid, date, text, jsonb) from public, anon, authenticated;
revoke all on function public.apm_service_day_body_replan(uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_day_body_replan(uuid, date, text, jsonb) to service_role;
grant execute on function public.apm_service_day_body_replan(uuid, date, text, jsonb) to service_role;
revoke all on function private.apm_service_day_replan(uuid, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_day_replan(uuid, date, text, text, jsonb) to service_role;
revoke all on function private.apm_complete_plan_action(uuid, text, text) from public, anon;
grant execute on function private.apm_complete_plan_action(uuid, text, text) to authenticated;
revoke all on function private.apm_service_pending_pillar_rebuilds(uuid) from public, anon, authenticated;
grant execute on function private.apm_service_pending_pillar_rebuilds(uuid) to service_role;
