-- 0036: plan rebuilds happen in place (Codex P1s on PR #24).
--
-- 0035 kept a rebuilt plan's start date but still superseded the live row and inserted a
-- new one, so (1) completions recorded against the old plan id stopped counting for the
-- remaining gate reviews and the day-90 decision, and (2) a locked agenda that named the
-- old plan id could no longer be completed that day (apm_complete_plan_action refuses a
-- superseded plan). A referral, clearance or Drafting Room rebuild now UPDATES the live
-- row: same id, same 90 days, same gate reviews, decision and completions. Only a new
-- plan from intake/goals supersedes. Signature and grants are unchanged.

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

  -- A rebuild updates the live plan IN PLACE (0036, Codex P1s on #24): the plan id, its
  -- start/end, status, gate reviews and decision stay, so every completion already
  -- recorded against it keeps counting for the day-30/60/90 reviews, and a locked agenda
  -- that names this plan stays completable for the rest of the day.
  if p_source in ('referral','clearance','os_change') then
    update public.goal_plans set
      plan_key = p_plan->>'id',
      template_key = p_plan->'provenance'->>'templateKey',
      persona = p_plan->'persona'->>'key',
      foreground_pillar = p_plan->'foreground'->>'pillar',
      timezone = nullif(p_plan->>'timezone', ''),
      plan = p_plan,
      updated_at = now()
    where id = v_live.id
    returning * into v_row;
    perform private.apm_loop_audit(
      v_uid, 'goal_plan.rebuilt', 'goal_plan', v_row.id::text,
      jsonb_build_object('goalId', p_goal_id, 'templateKey', v_row.template_key, 'persona', v_row.persona, 'source', p_source,
                         'previousPlanKey', v_live.plan_key, 'referral', (p_plan->'safety'->>'referral')::boolean)
    );
    return to_jsonb(v_row);
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

revoke all on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function private.apm_service_save_goal_plan(uuid, uuid, jsonb, text) to service_role;
