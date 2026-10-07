-- 0046: REPRINT is not a renegotiation (backend review, 7 Oct 2026: engine P1-2).
-- A reprinted agenda must (1) still carry every floor the plan requires (the same check
-- as check-in/print/replan), (2) keep every protected floor the locked agenda carried
-- (plan and Track floors; a floor may only be rescoped to its MVD), and (3) keep the
-- foreground action (No Mid-Day Negotiation): only its scope may change.
create or replace function private.apm_service_day_reprint(p_user_id uuid, p_day date, p_agenda jsonb)
returns jsonb
language plpgsql
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
  if p_day is distinct from private.apm_local_today(v_uid) then raise exception 'loop_day_not_today' using errcode = '22023'; end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
  perform private.apm_loop_check_required_floors(v_uid, p_agenda);
  select * into v_row from public.day_records d where d.user_id = v_uid and d.day = p_day for update;
  if v_row.id is null or v_row.agenda_status is distinct from 'locked' then raise exception 'loop_day_not_locked' using errcode = '55000'; end if;
  if v_row.closed_at is not null then raise exception 'loop_day_closed' using errcode = '55000'; end if;
  if v_row.reprint_count >= 5 then raise exception 'loop_reprint_limit' using errcode = '55000'; end if;
  if (p_agenda->>'mode') is distinct from (v_row.agenda->>'mode') or (p_agenda->>'state') is distinct from (v_row.agenda->>'state') then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  -- The foreground stands: same plan, same action.
  if (p_agenda #>> '{firstHour,priority,planId}') is distinct from (v_row.agenda #>> '{firstHour,priority,planId}')
     or (p_agenda #>> '{firstHour,priority,actionKey}') is distinct from (v_row.agenda #>> '{firstHour,priority,actionKey}') then
    raise exception 'loop_no_midday_negotiation' using errcode = '55000';
  end if;
  -- Every protected floor the locked agenda carried is still there.
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_row.agenda->'dailyStack', '[]'::jsonb)) locked
     where locked->>'kind' in ('plan_floor','track_floor')
       and not exists (
         select 1 from jsonb_array_elements(coalesce(p_agenda->'dailyStack', '[]'::jsonb)) reprinted
          where reprinted->>'kind' = locked->>'kind'
            and reprinted->>'actionKey' is not distinct from locked->>'actionKey'
            and reprinted->>'planId' is not distinct from locked->>'planId')
  ) then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  update public.day_records set agenda = p_agenda, reprint_count = reprint_count + 1, updated_at = now() where id = v_row.id returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'agenda.reprinted', 'day_record', v_row.id::text, jsonb_build_object('count', v_row.reprint_count));
  return to_jsonb(v_row);
end;
$$;
