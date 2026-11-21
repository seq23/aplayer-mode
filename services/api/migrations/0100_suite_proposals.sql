-- Reuse the action ledger, its atomic approval claim, and the calendar flexibility marks.
create function public.apm_service_suite_proposal_candidates(p_slot integer)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[])
  from public.subscription_entitlements e
  where e.plan in ('life_os', 'autopilot') and e.status in ('active', 'trialing')
    and mod(mod(hashtext(e.user_id::text), 96) + 96, 96) = p_slot
    and exists (
      select 1 from public.permissions p where p.user_id = e.user_id and p.enabled and p.autonomy_level >= 3
      and (p.domain, p.action_type) in (('calendar','event_write'), ('email','send'))
    );
$$;
revoke all on function public.apm_service_suite_proposal_candidates(integer) from public, anon, authenticated;
grant execute on function public.apm_service_suite_proposal_candidates(integer) to service_role;

create function public.apm_service_suite_flexible_events(p_user_id uuid, p_eligible_only boolean)
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(ce.id), '{}'::uuid[])
  from public.calendar_events ce
  join public.autopilot_flexible_events f
    on f.user_id = ce.user_id and f.provider = ce.provider and f.external_event_id = ce.external_event_id
  where ce.user_id = p_user_id and not ce.deleted and ce.ends_at > now()
    and (not p_eligible_only or not private.apm_autopilot_event_protected(p_user_id, ce, '{}'::jsonb));
$$;
revoke all on function public.apm_service_suite_flexible_events(uuid, boolean) from public, anon, authenticated;
grant execute on function public.apm_service_suite_flexible_events(uuid, boolean) to service_role;

create function public.apm_service_reject_suite_proposal(p_user_id uuid, p_action_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.actions set status = 'cancelled', updated_at = now()
  where user_id = p_user_id and id = p_action_id and idempotency_key like 'suite:%'
    and status in ('prepared', 'approved') and requires_approval;
  if not found then raise exception 'action_invalid_state' using errcode = '55000'; end if;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, 'action.rejected', 'user', 'app', 'action', p_action_id::text, '{}'::jsonb);
end;
$$;
revoke all on function public.apm_service_reject_suite_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_reject_suite_proposal(uuid, uuid) to service_role;

alter table public.content_reports drop constraint content_reports_kind_check;
alter table public.content_reports add constraint content_reports_kind_check check (kind in ('plan_item','radar_item','action_proposal'));

create or replace function private.apm_report_content(p_kind text, p_ref text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('plan_item','radar_item','action_proposal') then
    raise exception 'report_invalid_kind' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('harmful','wrong','inappropriate','other') then
    raise exception 'report_invalid_reason' using errcode = '22023';
  end if;
  if p_ref is null or char_length(p_ref) not between 1 and 200 or p_ref ~ '[\x01-\x1f\x7f]' then
    raise exception 'report_invalid_ref' using errcode = '22023';
  end if;
  if p_kind = 'action_proposal' and not exists (
    select 1 from public.actions a where a.user_id = v_user and a.id::text = p_ref and a.idempotency_key like 'suite:%'
  ) then raise exception 'report_invalid_ref' using errcode = '22023'; end if;
  select r.id into v_existing from public.content_reports r where r.user_id = v_user and r.kind = p_kind and r.ref = p_ref;
  if v_existing is not null then return jsonb_build_object('reportId', v_existing, 'replayed', true); end if;
  insert into public.content_reports (user_id, kind, ref, reason) values (v_user, p_kind, p_ref, p_reason)
  returning id into v_id;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (v_user, 'content.reported', 'user', 'app', 'content_report', v_id::text,
          jsonb_build_object('kind', p_kind, 'ref', p_ref, 'reason', p_reason));
  return jsonb_build_object('reportId', v_id, 'replayed', false);
end;
$$;

create or replace function private.apm_autopilot_set_event_flexible(p_event_id uuid, p_flexible boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_ev public.calendar_events;
begin
  if p_flexible is null then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_flexible then
    if not exists (
      select 1 from public.subscription_entitlements e where e.user_id = v_uid
        and e.plan in ('life_os', 'autopilot') and e.status in ('active','trialing')
    ) then raise exception 'autopilot_required' using errcode = '42501'; end if;
  end if;
  select * into v_ev from public.calendar_events ce where ce.id = p_event_id and ce.user_id = v_uid;
  if not found then
    raise exception 'autopilot_event_not_found' using errcode = 'P0002';
  end if;
  if p_flexible then
    insert into public.autopilot_flexible_events (user_id, provider, external_event_id)
    values (v_uid, v_ev.provider, v_ev.external_event_id)
    on conflict do nothing;
  else
    delete from public.autopilot_flexible_events f
    where f.user_id = v_uid and f.provider = v_ev.provider and f.external_event_id = v_ev.external_event_id;
  end if;
  perform private.apm_autopilot_audit(v_uid, 'autopilot.event_flexibility_set', 'calendar_event', v_ev.id,
    jsonb_build_object('flexible', p_flexible));
  return jsonb_build_object('eventId', v_ev.id, 'flexible', p_flexible);
end;
$$;
