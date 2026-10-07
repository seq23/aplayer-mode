-- 0034: calendar.reschedule shift bound is exact (Codex P1 on PR #23).
--
-- 0033 compared the absolute shift in seconds against maxShiftDays * 86400 + 86399,
-- so a rule with maxShiftDays = 0 could move a 23:00 meeting to 22:00 the next day and
-- a 7-day rule allowed almost 8. The bound now compares LOCAL dates in the rule's
-- timezone: 0 = same day only, N = at most N calendar days earlier or later. Only this
-- function changes; signature and grants are unchanged (CREATE OR REPLACE keeps the
-- ACL; re-asserted below).

create or replace function private.apm_autopilot_prepare_calendar_reschedule(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ev public.calendar_events;
  v_starts timestamptz;
  v_ends timestamptz;
  v_day date;
  v_others integer;
begin
  perform private.apm_autopilot_check_keys(p_payload, array['eventId','startsAt','endsAt'], array['eventId','startsAt','endsAt'], 'autopilot_invalid_payload');
  begin
    v_starts := (p_payload->>'startsAt')::timestamptz;
    v_ends := (p_payload->>'endsAt')::timestamptz;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  v_ev := private.apm_autopilot_target_event(p_user_id, p_c, p_payload, 'calendar.reschedule');
  -- Only the user's own meetings (organiser) or solo blocks may be moved.
  v_others := case when jsonb_typeof(v_ev.attendees) = 'array'
    then (select count(*) from jsonb_array_elements(v_ev.attendees) a where coalesce(a->>'self', 'false') <> 'true') else 0 end;
  if v_others > 0 and coalesce(v_ev.organizer->>'self', 'false') <> 'true' then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  -- maxShiftDays counts LOCAL calendar days in the rule's timezone, exactly:
  -- 0 = same day only, N = at most N days earlier or later (Codex P1 on #23:
  -- the 0033 seconds bound granted almost a whole extra day).
  if v_ends - v_starts <> v_ev.ends_at - v_ev.starts_at
     or abs((v_starts at time zone (p_c->>'timezone'))::date - (v_ev.starts_at at time zone (p_c->>'timezone'))::date) > (p_c->>'maxShiftDays')::integer
     or v_starts = v_ev.starts_at then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_day := private.apm_autopilot_slot_in_window(p_c, v_starts, v_ends);
  if private.apm_autopilot_slot_busy(p_user_id, v_starts, v_ends, v_ev.id) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  return jsonb_build_object('localDay', v_day, 'startsAt', v_starts, 'endsAt', v_ends,
    'targetRef', v_ev.external_event_id, 'originalStartsAt', v_ev.starts_at, 'originalEndsAt', v_ev.ends_at,
    'connectionId', v_ev.connection_id,
    'composed', jsonb_build_object('externalEventId', v_ev.external_event_id, 'title', v_ev.title,
      'startsAt', v_starts, 'endsAt', v_ends, 'originalStartsAt', v_ev.starts_at, 'originalEndsAt', v_ev.ends_at));
end;
$$;

revoke all on function private.apm_autopilot_prepare_calendar_reschedule(uuid, jsonb, jsonb) from public, anon, authenticated;
