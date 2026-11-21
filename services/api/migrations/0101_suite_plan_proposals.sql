create or replace function public.apm_service_suite_proposal_candidates(p_slot integer)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[])
  from public.subscription_entitlements e
  where e.plan in ('life_os', 'autopilot') and e.status in ('active', 'trialing')
    and mod(mod(hashtext(e.user_id::text), 96) + 96, 96) = p_slot
    and exists (
      select 1 from public.permissions p where p.user_id = e.user_id and p.enabled and p.autonomy_level >= 3
      and (p.domain, p.action_type) in (('calendar','event_write'), ('email','send'), ('life_graph','plan_logistics'))
    );
$$;

-- Internal effects, approval audit and verification commit together. Only the Worker can
-- call this, and it passes a ledger ID, never a client-supplied mutation.
create function public.apm_service_apply_suite_life_graph(p_user_id uuid, p_action_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  proposal public.actions;
  target_id uuid;
  starts timestamptz;
  ends timestamptz;
begin
  select * into proposal from public.actions where user_id = p_user_id and id = p_action_id for update;
  if not found or proposal.status <> 'prepared' or not proposal.requires_approval
    or proposal.domain <> 'life_graph' or proposal.idempotency_key not like 'suite:%'
  then raise exception 'action_invalid_state' using errcode = '55000'; end if;
  if not exists (
    select 1 from public.permissions p join public.subscription_entitlements e on e.user_id = p.user_id
    where p.user_id = p_user_id and p.id = proposal.permission_id and p.domain = 'life_graph'
      and p.action_type = 'plan_logistics' and p.enabled and p.autonomy_level >= 4
      and e.plan in ('life_os', 'autopilot') and e.status in ('active', 'trialing')
  ) then raise exception 'action_not_authorized:permission_required' using errcode = '42501'; end if;
  if coalesce((proposal.payload->>'expiresAt')::timestamptz <= now(), true)
  then raise exception 'action_proposal_stale' using errcode = '55000'; end if;
  perform private.apm_service_action_claim(p_user_id, p_action_id);
  if proposal.action_type = 'goal.checklist' and proposal.payload->>'suiteProposal' = 'goal_checklist' then
    insert into public.next_actions (id, user_id, goal_id, title, status)
    select proposal.id, g.user_id, g.id, proposal.payload->>'title', 'open'
    from public.goals g join public.goal_plans gp on gp.goal_id = g.id and gp.user_id = g.user_id
    where g.user_id = p_user_id and g.status = 'active' and g.id = (proposal.payload->>'goalId')::uuid
      and gp.id = (proposal.payload->>'planId')::uuid and gp.status = 'active'
      and not exists (
        select 1 from public.plan_action_completions c where c.user_id = p_user_id and c.plan_id = gp.id
          and c.day = (proposal.payload->>'day')::date and c.action_key = proposal.payload->>'actionKey'
      )
    returning id into target_id;
  elsif proposal.action_type = 'life_admin.defer' and proposal.payload->>'suiteProposal' in ('hard_day','missed_day') then
    starts := (proposal.payload->>'startsAt')::timestamptz;
    ends := (proposal.payload->>'endsAt')::timestamptz;
    -- Serialize these approved moves for this owner so two independent decisions
    -- cannot write into the same opening.
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
    update public.life_admin_items i set starts_at = starts, ends_at = ends, updated_at = now()
    where i.user_id = p_user_id and i.id = (proposal.payload->>'itemId')::uuid
      and i.updated_at = (proposal.payload->>'expectedUpdatedAt')::timestamptz
      and i.starts_at = (proposal.payload->>'originalStartsAt')::timestamptz
      and i.kind in ('shopping','meal_plan') and i.status in ('open','planned','scheduled') and i.importance <= 3
      and i.details->'flexibleSchedule' = 'true'::jsonb and i.provenance_kind = 'stated' and i.source_type = 'manual'
      and i.due_at is null and i.amount_minor is null and i.currency is null and i.person_id is null and i.recurrence = '{}'::jsonb
      and starts > greatest(i.starts_at, now())
      and (ends - starts) is not distinct from (i.ends_at - i.starts_at)
      and not exists (
        select 1 from public.life_admin_items j where j.user_id = p_user_id and j.id <> i.id
          and j.status in ('open','planned','scheduled') and j.starts_at < coalesce(ends, starts + interval '30 minutes')
          and coalesce(j.ends_at, j.starts_at + interval '30 minutes') > starts
      )
    returning i.id into target_id;
  else
    raise exception 'action_invalid_state' using errcode = '55000';
  end if;
  if target_id is null then raise exception 'action_proposal_stale' using errcode = '55000'; end if;
  return private.apm_service_action_result(p_user_id, p_action_id, 'verified', 'apm', target_id::text, null);
end;
$$;

revoke all on function public.apm_service_apply_suite_life_graph(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_apply_suite_life_graph(uuid, uuid) to service_role;
