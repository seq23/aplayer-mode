-- 0028: agendas are server-derived by construction (sixth Codex pass on PR #14).
--
-- Every earlier hardening pass mirrored a piece of packages/planning in SQL to check an
-- agenda the CLIENT submitted. The robust fix is to stop accepting client agendas: the
-- check-in and the declared replan — the only writes that lock an agenda — become
-- service-role-only. The Worker authenticates the user, computes the agenda with the
-- deterministic engine (composeAgenda: one foreground by arbitration, required floors,
-- background maintenance, the one-action MVD) and writes it with its server-only key.
-- The direct authenticated RPCs are revoked, so a client can no longer lock an agenda
-- of its own making; the 0021–0027 checks stay as defence in depth.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;
grant usage on schema private to service_role;

create or replace function private.apm_service_day_check_in(p_user_id uuid, p_day date, p_mood integer, p_state text, p_agenda jsonb)
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
  if p_mood is null or p_mood not between 1 and 10 or p_state not in ('normal','recovery','missed_yesterday') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
  if (p_agenda->>'state') <> p_state then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  -- The Mood Gate and Never Miss Twice are enforced here too, not only in the app.
  if (p_mood <= 2 or p_state <> 'normal') and p_agenda->>'mode' <> 'recovery' then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  if p_state = 'normal' and private.apm_loop_missed_yesterday(v_uid, p_day) then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  perform private.apm_loop_check_required_floors(v_uid, p_agenda);

  insert into public.day_records (user_id, day, mode, mood, day_state, agenda, agenda_status, checked_in_at, updated_at)
  values (v_uid, p_day, coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
          p_mood, p_state, p_agenda, 'locked', now(), now())
  on conflict (user_id, day) do update
     set mood = excluded.mood, day_state = excluded.day_state, agenda = excluded.agenda,
         agenda_status = 'locked', checked_in_at = excluded.checked_in_at, updated_at = now()
   where public.day_records.checked_in_at is null and public.day_records.closed_at is null
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.day_records d where d.user_id = v_uid and d.day = p_day;
    return jsonb_build_object('day', to_jsonb(v_row), 'replayed', true);
  end if;
  perform private.apm_loop_audit(v_uid, 'day.checked_in', 'day_record', v_row.id::text,
    jsonb_build_object('state', p_state, 'mvd', p_mood <= 2 or p_state <> 'normal'));
  return jsonb_build_object('day', to_jsonb(v_row), 'replayed', false);
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
  if jsonb_array_length(v_row.replans) >= 3 then
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


create or replace function public.apm_service_day_check_in(p_user_id uuid, p_day date, p_mood integer, p_state text, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_day_check_in(p_user_id, p_day, p_mood, p_state, p_agenda); $$;
create or replace function public.apm_service_day_replan(p_user_id uuid, p_day date, p_reason text, p_detail text, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_day_replan(p_user_id, p_day, p_reason, p_detail, p_agenda); $$;

-- Client-built agendas are no longer accepted.
revoke all on function public.apm_day_check_in(date, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.apm_day_replan(date, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_day_check_in(date, integer, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_day_replan(date, text, text, jsonb) from public, anon, authenticated;

revoke all on function private.apm_service_day_check_in(uuid, date, integer, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_service_day_replan(uuid, date, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.apm_service_day_check_in(uuid, date, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.apm_service_day_replan(uuid, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_day_check_in(uuid, date, integer, text, jsonb) to service_role;
grant execute on function private.apm_service_day_replan(uuid, date, text, text, jsonb) to service_role;
grant execute on function public.apm_service_day_check_in(uuid, date, integer, text, jsonb) to service_role;
grant execute on function public.apm_service_day_replan(uuid, date, text, text, jsonb) to service_role;
grant execute on function private.apm_has_core_access(uuid) to service_role;
grant execute on function private.apm_local_today(uuid) to service_role;
grant execute on function private.apm_loop_audit(uuid, text, text, text, jsonb) to service_role;
grant execute on function private.apm_loop_check_agenda(jsonb, date) to service_role;
grant execute on function private.apm_loop_check_agenda_items(uuid, jsonb) to service_role;
grant execute on function private.apm_loop_check_required_floors(uuid, jsonb) to service_role;
grant execute on function private.apm_loop_allowed_actions(jsonb, date) to service_role;
grant execute on function private.apm_loop_missed_yesterday(uuid, date) to service_role;
