-- 0103: Autopilot clears the calendar to the minimum day (paywall row "+ clears your calendar
-- to your minimum day", phase 4, 21 Nov 2026).
--
-- The quarter-hour Suite run has only the server key, while the standing claim (0018/0033)
-- reads the owner from auth.uid(). This adds one service-only entry point that names the
-- owner and the account, finds that owner's live rule for the class and runs the SAME
-- private claim, so every standing guard still applies in the database: Autopilot
-- entitlement, the level-5 permission, rule status and expiry, class activation, the master
-- pause, the rule's window, shift and caps, protected events, collisions and idempotent replay.
-- No rule for the class and account returns null, and the caller prepares an approval card.
-- Additive only: two new functions, and two replaced functions that keep their signatures.

create or replace function public.apm_service_autopilot_claim(
  p_user_id uuid, p_action_class text, p_connection_id uuid, p_idempotency_key text, p_payload jsonb, p_reason text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rule_id uuid;
begin
  if p_user_id is null or p_connection_id is null then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  select r.id into v_rule_id from public.autopilot_rules r
  where r.user_id = p_user_id and r.action_class = p_action_class and r.connection_id = p_connection_id
    and r.status <> 'revoked'
  order by r.created_at desc limit 1;
  if v_rule_id is null then return null; end if;
  -- The private claim reads the owner from auth.uid(); this transaction acts as that owner only.
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claims',
    (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
      || jsonb_build_object('sub', p_user_id::text))::text, true);
  return private.apm_autopilot_claim(v_rule_id, p_idempotency_key, p_payload, p_reason);
end;
$$;
revoke all on function public.apm_service_autopilot_claim(uuid, text, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.apm_service_autopilot_claim(uuid, text, uuid, text, jsonb, text) to service_role;

-- Today's card shows an Autopilot move by its action; Undo needs the execution behind it.
create or replace function public.apm_service_autopilot_execution_for_action(p_user_id uuid, p_action_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.autopilot_executions e where e.user_id = p_user_id and e.action_id = p_action_id;
$$;
revoke all on function public.apm_service_autopilot_execution_for_action(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_autopilot_execution_for_action(uuid, uuid) to service_role;

-- Undo target (0033) plus the time Autopilot moved the event TO, so Undo can confirm the
-- event is still exactly where Autopilot left it before it restores the original time.
create or replace function private.apm_autopilot_undo_target(p_execution_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_exec public.autopilot_executions;
  v_class public.autopilot_action_classes;
  v_action public.actions;
begin
  select * into v_exec from public.autopilot_executions e where e.id = p_execution_id and e.user_id = v_uid;
  if not found then
    raise exception 'autopilot_execution_not_found' using errcode = 'P0002';
  end if;
  select * into v_class from public.autopilot_action_classes c where c.class_key = v_exec.action_class;
  if not v_class.reversible then
    raise exception 'autopilot_cannot_undo' using errcode = '22023';
  end if;
  if v_exec.status <> 'verified' or v_exec.action_id is null then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;
  select * into v_action from public.actions a where a.id = v_exec.action_id and a.user_id = v_uid;
  if not found then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'executionId', v_exec.id,
    'actionClass', v_class.class_key,
    'domain', v_class.domain,
    'connectorKind', v_class.connector_kind,
    'undoMethod', v_class.undo_method,
    'externalRef', coalesce(v_exec.target_ref, v_exec.external_ref),
    'connectionId', coalesce(v_action.payload->'composed'->>'connectionId', v_action.payload->>'connectionId'),
    'originalStartsAt', v_exec.original_starts_at,
    'originalEndsAt', v_exec.original_ends_at,
    'movedStartsAt', v_exec.proposed_starts_at,
    'movedEndsAt', v_exec.proposed_ends_at
  );
end;
$$;
revoke all on function private.apm_autopilot_undo_target(uuid) from public, anon;
grant execute on function private.apm_autopilot_undo_target(uuid) to authenticated;

-- An Autopilot member whose only switch is the standing reschedule rule is a Suite run candidate too.
create or replace function public.apm_service_suite_proposal_candidates(p_slot integer)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[])
  from public.subscription_entitlements e
  where e.plan in ('life_os', 'autopilot') and e.status in ('active', 'trialing')
    and mod(mod(hashtext(e.user_id::text), 96) + 96, 96) = p_slot
    and exists (
      select 1 from public.permissions p where p.user_id = e.user_id and p.enabled and p.autonomy_level >= 3
      and (p.domain, p.action_type) in (('calendar','event_write'), ('email','send'), ('life_graph','plan_logistics'), ('calendar','calendar.reschedule'))
    );
$$;

-- A clear-day card she approved is undone like a calendar fix (same live check in the Worker).
create or replace function public.apm_service_record_suite_undo(p_user_id uuid, p_action_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.actions set status = 'cancelled', updated_at = now()
    where id = p_action_id and user_id = p_user_id and status = 'verified'
      and (idempotency_key like 'suite:calendar_fix:%' or idempotency_key like 'suite:clear_day:%');
  if not found then raise exception 'action_invalid_state'; end if;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id)
    values (p_user_id, 'action.undone', 'user', 'worker', 'action', p_action_id::text);
end;
$$;
revoke all on function public.apm_service_record_suite_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_record_suite_undo(uuid, uuid) to service_role;
