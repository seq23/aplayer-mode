-- 0039: the mandatory body-safety replan is idempotent per transition (Codex P2 on #24).
--
-- 0038 only checked that a referral existed, so a repeated red flag on an already-active
-- referral appended another uncapped replan each time. A mandatory replan now records its
-- source and runs at most once per referral (or clearance) transition; a repeat is a
-- no-op that returns the day unchanged. Signature and grants are unchanged.

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
  -- Idempotent per transition (0039): the same referral (or clearance) replans today at
  -- most once; a repeated red flag on an active referral changes nothing.
  if exists (
    select 1 from jsonb_array_elements(v_row.replans) r
    where coalesce((r->>'mandatory')::boolean, false) and r->>'source' = p_source
      and (r->>'at')::timestamptz >= case when p_source = 'referral' then v_os.body_referral_at else v_os.clinician_cleared_at end
  ) then
    return to_jsonb(v_row);
  end if;
  -- Mandatory: never limited, never counted against the three declared replans.
  update public.day_records
     set agenda = p_agenda,
         day_state = p_agenda->>'state',
         replans = replans || jsonb_build_array(jsonb_build_object(
           'reason', case when p_source = 'referral' then 'safety' else 'permission' end,
           'detail', case when p_source = 'referral' then 'Body red flag: body coaching paused until clinician clearance.' else 'Clinician clearance recorded.' end,
           'mandatory', true, 'source', p_source, 'at', now())),
         updated_at = now()
   where id = v_row.id
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.replanned', 'day_record', v_row.id::text, jsonb_build_object('reason', p_source, 'mandatory', true));
  return to_jsonb(v_row);
end;
$$;

revoke all on function private.apm_service_day_body_replan(uuid, date, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_day_body_replan(uuid, date, text, jsonb) to service_role;
