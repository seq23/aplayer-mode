-- 0094: the two 1–10 mental-state scores under the consumer health data consent (coordinator,
-- 8 Oct 2026: Washington's My Health My Data Act counts mental and psychological state as
-- consumer health data): the daily mood check-in and the intake's "How full does your head
-- feel?" mental-load score.
--
--  * The intake lists from 0093 gain 'load' (packages/planning/src/intake/healthData.ts, pinned by
--    test/consent-db.test.mjs): without a live grant the draft trigger strips it before it is stored.
--  * private.apm_service_day_check_in (last defined in 0028) is redefined: without a live
--    'consumer_health_data' grant (0093) the mood is discarded, from the row and from the agenda;
--    with the grant it is required, 1 to 10, as before. The Mood Gate reads a missing mood as
--    "not low", so the day state alone decides a light day.
--  * public.apm_service_day_check_in_v2: the entry point the Worker calls. It exists only once
--    this migration is applied, so scripts/deploy-api-production.sh (REQUIRED_RPCS) refuses to
--    ship a Worker that sends no mood to a database that would refuse it.

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
  -- 0094: the mood score is consumer health data. Without a live consent it is discarded
  -- here (never stored, never kept in the agenda); with consent it is required as before.
  if not private.apm_health_consent_active(v_uid) then
    p_mood := null;
    p_agenda := p_agenda - 'mood';
  elsif p_mood is null then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if (p_mood is not null and p_mood not between 1 and 10) or p_state not in ('normal','recovery','missed_yesterday') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
  if (p_agenda->>'state') <> p_state then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  -- The Mood Gate and Never Miss Twice are enforced here too, not only in the app.
  if (coalesce(p_mood, 10) <= 2 or p_state <> 'normal') and p_agenda->>'mode' <> 'recovery' then
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
    jsonb_build_object('state', p_state, 'mvd', coalesce(p_mood, 10) <= 2 or p_state <> 'normal'));
  return jsonb_build_object('day', to_jsonb(v_row), 'replayed', false);
end;
$$;

create or replace function public.apm_service_day_check_in_v2(p_user_id uuid, p_day date, p_mood integer, p_state text, p_agenda jsonb)
returns jsonb
language sql
volatile
set search_path = ''
as $$ select private.apm_service_day_check_in(p_user_id, p_day, p_mood, p_state, p_agenda); $$;
revoke all on function public.apm_service_day_check_in_v2(uuid, date, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.apm_service_day_check_in_v2(uuid, date, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------- the mental-load score (intake 'load')
create or replace function private.apm_strip_health_answers(p_answers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := coalesce(p_answers, '{}'::jsonb);
begin
  v := v - array['move', 'workout_days', 'food', 'weight_now', 'weigh_in', 'clinician_flag', 'clinician_sup', 'health_routine', 'bed', 'bed_move', 'load']::text[];
  if jsonb_typeof(v->'games') = 'array' then
    v := jsonb_set(v, '{games}', coalesce((
      select jsonb_agg(g) from jsonb_array_elements(v->'games') g
      where not (g = any (array[to_jsonb('weight'::text)]))
    ), '[]'::jsonb));
  end if;
  if v->>'foreground' in ('weight') then
    v := v - 'foreground';
  end if;
  if v->>'goal' in ('lose_weight', 'workout_habit', 'eat_better', 'energy', 'return_injury') then
    v := v - 'goal' - 'goal_size';
  end if;
  return v;
end;
$$;

create or replace function private.apm_intake_drafts_consent_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A signed-in (or anonymous) user starts a draft only after confirming 18+. The service
  -- role's merge path has no auth.uid(); the Worker checks both sessions before it runs.
  if tg_op = 'INSERT' and auth.uid() is not null
     and not exists (select 1 from public.consent_records r where r.user_id = new.user_id and r.kind = 'age_18_plus') then
    raise exception 'age_confirmation_required' using errcode = '42501';
  end if;
  if not private.apm_health_consent_active(new.user_id) then
    new.answers := private.apm_strip_health_answers(new.answers);
    new.answered_at := new.answered_at - array(select k from jsonb_object_keys(new.answered_at) k where not (new.answers ? k) and k in (
      'move', 'workout_days', 'food', 'weight_now', 'weigh_in', 'clinician_flag', 'clinician_sup', 'health_routine', 'bed', 'bed_move', 'load', 'goal', 'goal_size', 'foreground'));
  end if;
  return new;
end;
$$;
