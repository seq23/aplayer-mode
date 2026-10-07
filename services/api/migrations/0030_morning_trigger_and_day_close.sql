-- 0030: the Morning Trigger delivers itself, and the end-of-day close is real.
--
--  A. Notification settings gain the Morning Trigger: on/off and the wake time
--     (HH:MM, the user's local clock).
--  B. Service-role-only functions for the Cloudflare Cron Trigger: find the users
--     whose local wake time has arrived, print their agenda for the LOCAL day, and
--     claim the day's morning push exactly once (`morning:<YYYY-MM-DD>`, unique per
--     user). No authenticated or anonymous caller can reach them.
--  C. The end-of-day close (BHPC Prompt #6) records the pillar-by-pillar review,
--     the computed verdict next to the user's verdict, one carry-forward item and
--     the day's insight, through a governed function for the LOCAL today.

-- Supabase always has service_role; embedded test databases may not.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

-- ---------------------------------------------------------------- A. settings
alter table public.notification_preferences
  add column morning_push_enabled boolean not null default true,
  add column wake_time text not null default '07:00' check (wake_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ---------------------------------------------------------------- B. service functions
create or replace function private.apm_service_audit(p_user_id uuid, p_event_type text, p_object_type text, p_object_id text, p_metadata jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, p_event_type, 'system', 'cron:morning_trigger', p_object_type, p_object_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Users whose local wake time arrived within the last 4 hours and who have not had
-- today's morning push. Notification settings are respected here: disabled
-- notifications, a disabled Morning Trigger or no registered device = not a candidate.
create or replace function private.apm_service_morning_candidates(p_now timestamptz, p_limit integer default 200)
returns table (user_id uuid, timezone text, wake_time text, local_day date)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select p.user_id,
           coalesce((select up.timezone from public.user_profiles up
                      where up.user_id = p.user_id
                        and exists (select 1 from pg_catalog.pg_timezone_names tz where tz.name = up.timezone)), 'UTC') as tz,
           np.wake_time
      from public.personal_os p
      join public.notification_preferences np on np.user_id = p.user_id
     where np.enabled and np.morning_push_enabled
       and private.apm_has_core_access(p.user_id)
       and exists (select 1 from public.push_subscriptions ps where ps.user_id = p.user_id and ps.active)
  ), timed as (
    select b.user_id, b.tz, b.wake_time, (p_now at time zone b.tz) as local_ts from base b
  )
  select t.user_id, t.tz, t.wake_time, t.local_ts::date
    from timed t
   where ((extract(epoch from t.local_ts::time) - extract(epoch from t.wake_time::time)) / 60 + 1440)::integer % 1440 < 240
     and not exists (
       select 1 from public.notifications n
        where n.user_id = t.user_id and n.dedupe_key = 'morning:' || t.local_ts::date::text
     )
   order by t.user_id
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

-- Prints (never locks) the day's agenda. A day the user already checked in to, or
-- closed, is never overwritten.
create or replace function private.apm_service_print_agenda(p_user_id uuid, p_day date, p_agenda jsonb)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_day is distinct from private.apm_local_today(p_user_id) then
    raise exception 'loop_day_not_today' using errcode = '22023';
  end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  perform private.apm_loop_check_agenda_items(p_user_id, p_agenda);
  perform private.apm_loop_check_required_floors(p_user_id, p_agenda);
  insert into public.day_records (user_id, day, mode, day_state, agenda, agenda_status, updated_at)
  values (p_user_id, p_day, coalesce((select p.active_mode from public.personal_os p where p.user_id = p_user_id), 'standard'),
          p_agenda->>'state', p_agenda, 'printed', now())
  on conflict (user_id, day) do update
     set agenda = excluded.agenda, day_state = excluded.day_state, agenda_status = 'printed', updated_at = now()
   where public.day_records.checked_in_at is null and public.day_records.closed_at is null
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  perform private.apm_service_audit(p_user_id, 'day.agenda_printed', 'day_record', v_id::text, jsonb_build_object('day', p_day, 'state', p_agenda->>'state'));
  return true;
end;
$$;

-- Exactly-once claim of the day's morning push. NULL = someone already claimed it.
create or replace function private.apm_service_claim_notification(p_user_id uuid, p_dedupe_key text, p_title text, p_body text, p_deep_link text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_dedupe_key !~ '^morning:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or char_length(coalesce(p_title, '')) not between 1 and 120
     or char_length(coalesce(p_body, '')) not between 1 and 240
     or char_length(coalesce(p_deep_link, '')) > 200 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  insert into public.notifications (user_id, title, body, deep_link, dedupe_key, status)
  values (p_user_id, p_title, p_body, p_deep_link, p_dedupe_key, 'queued')
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.apm_service_finish_notification(p_id uuid, p_status text, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if p_status not in ('sent','failed','suppressed') or char_length(coalesce(p_reason, '')) > 120 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  update public.notifications
     set status = p_status,
         sent_at = case when p_status = 'sent' then now() else null end,
         suppression_reason = case when p_status = 'sent' then null else nullif(p_reason, '') end
   where id = p_id and status = 'queued'
  returning user_id into v_user;
  if v_user is not null then
    perform private.apm_service_audit(v_user, 'notification.morning_trigger', 'notification', p_id::text,
      jsonb_build_object('status', p_status, 'reason', nullif(p_reason, '')));
  end if;
end;
$$;

-- ---------------------------------------------------------------- C. the end-of-day close
alter table public.day_records
  add column pillar_review jsonb check (pillar_review is null or jsonb_typeof(pillar_review) = 'array'),
  add column computed_verdict text check (computed_verdict is null or computed_verdict in ('full_day','mvd','miss')),
  add column carry_forward text check (carry_forward is null or char_length(carry_forward) between 5 and 200),
  add column insight text check (insight is null or char_length(insight) <= 300);

create or replace function private.apm_close_day_review(
  p_verdict text,
  p_computed_verdict text,
  p_pillar_review jsonb,
  p_note text,
  p_carry_forward text,
  p_insight text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_entry jsonb;
  v_key text;
  v_row public.day_records;
begin
  if p_verdict not in ('full_day','mvd','miss') or p_computed_verdict not in ('full_day','mvd','miss')
     or char_length(coalesce(p_note, '')) > 1000 or char_length(coalesce(p_insight, '')) > 300
     or (p_carry_forward is not null and char_length(btrim(p_carry_forward)) not between 5 and 200) then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if p_pillar_review is null or jsonb_typeof(p_pillar_review) <> 'array' or jsonb_array_length(p_pillar_review) > 5 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  for v_entry in select e from jsonb_array_elements(p_pillar_review) e loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception 'loop_invalid_request' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(v_entry) loop
      if v_key not in ('pillar','score','completed') then
        raise exception 'loop_field_not_allowed' using errcode = '22023';
      end if;
    end loop;
    if coalesce(v_entry->>'pillar', '') not in ('wealth','body','spirit','execution','family')
       or coalesce(v_entry->>'score', '') not in ('hit','partial','miss')
       or char_length(coalesce(v_entry->>'completed', '')) > 300 then
      raise exception 'loop_invalid_request' using errcode = '22023';
    end if;
  end loop;

  -- Evidence before verdict (as 0023/0024): no Full Day / MVD without today's check-in
  -- and completion evidence; a closed day stays closed.
  if p_verdict <> 'miss' and not private.apm_loop_day_opened(v_uid, v_today) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  if exists (select 1 from public.day_records d where d.user_id = v_uid and d.day = v_today and d.closed_at is not null) then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  if p_verdict <> 'miss' and not private.apm_loop_has_evidence(v_uid, v_today) then
    raise exception 'loop_verdict_needs_evidence' using errcode = '55000';
  end if;
  if p_verdict = 'full_day' and private.apm_loop_max_verdict(v_uid, v_today) <> 'full_day' then
    raise exception 'loop_verdict_needs_evidence' using errcode = '55000';
  end if;

  insert into public.day_records (user_id, day, mode, verdict, computed_verdict, pillar_review, completed_action_ids, note, carry_forward, insight, closed_at, updated_at)
  values (
    v_uid, v_today,
    coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
    p_verdict, p_computed_verdict, p_pillar_review,
    coalesce((select array_agg(c.id) from public.plan_action_completions c where c.user_id = v_uid and c.day = v_today), '{}'),
    nullif(btrim(coalesce(p_note, '')), ''), nullif(btrim(coalesce(p_carry_forward, '')), ''), nullif(btrim(coalesce(p_insight, '')), ''),
    now(), now()
  )
  on conflict (user_id, day) do update set
    verdict = excluded.verdict, computed_verdict = excluded.computed_verdict, pillar_review = excluded.pillar_review,
    completed_action_ids = excluded.completed_action_ids, note = excluded.note, carry_forward = excluded.carry_forward,
    insight = excluded.insight, closed_at = excluded.closed_at, updated_at = now()
  returning * into v_row;

  perform private.apm_loop_audit(v_uid, 'day.closed', 'day_record', v_row.id::text, jsonb_build_object(
    'verdict', p_verdict, 'computed', p_computed_verdict, 'overridden', p_verdict <> p_computed_verdict,
    'carried', v_row.carry_forward is not null, 'day', v_today));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.apm_close_day_review(p_verdict text, p_computed_verdict text, p_pillar_review jsonb, p_note text, p_carry_forward text, p_insight text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_close_day_review(p_verdict, p_computed_verdict, p_pillar_review, p_note, p_carry_forward, p_insight); $$;

create or replace function public.apm_service_morning_candidates(p_now timestamptz, p_limit integer default 200)
returns table (user_id uuid, timezone text, wake_time text, local_day date)
language sql stable security invoker set search_path = ''
as $$ select * from private.apm_service_morning_candidates(p_now, p_limit); $$;
create or replace function public.apm_service_print_agenda(p_user_id uuid, p_day date, p_agenda jsonb)
returns boolean language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_print_agenda(p_user_id, p_day, p_agenda); $$;
create or replace function public.apm_service_claim_notification(p_user_id uuid, p_dedupe_key text, p_title text, p_body text, p_deep_link text)
returns uuid language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_claim_notification(p_user_id, p_dedupe_key, p_title, p_body, p_deep_link); $$;
create or replace function public.apm_service_finish_notification(p_id uuid, p_status text, p_reason text)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_finish_notification(p_id, p_status, p_reason); $$;

-- ---------------------------------------------------------------- grants
revoke all on function private.apm_service_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_service_morning_candidates(timestamptz, integer) from public, anon, authenticated;
revoke all on function private.apm_service_print_agenda(uuid, date, jsonb) from public, anon, authenticated;
revoke all on function private.apm_service_claim_notification(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function private.apm_service_finish_notification(uuid, text, text) from public, anon, authenticated;
revoke all on function public.apm_service_morning_candidates(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.apm_service_print_agenda(uuid, date, jsonb) from public, anon, authenticated;
revoke all on function public.apm_service_claim_notification(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.apm_service_finish_notification(uuid, text, text) from public, anon, authenticated;

grant usage on schema private to service_role;
grant execute on function private.apm_has_core_access(uuid) to service_role;
grant execute on function private.apm_local_today(uuid) to service_role;
grant execute on function private.apm_loop_check_agenda(jsonb, date) to service_role;
grant execute on function private.apm_loop_check_agenda_items(uuid, jsonb) to service_role;
grant execute on function private.apm_loop_check_required_floors(uuid, jsonb) to service_role;
grant execute on function private.apm_loop_allowed_actions(jsonb, date) to service_role;
grant execute on function private.apm_service_audit(uuid, text, text, text, jsonb) to service_role;
grant execute on function private.apm_service_morning_candidates(timestamptz, integer) to service_role;
grant execute on function private.apm_service_print_agenda(uuid, date, jsonb) to service_role;
grant execute on function private.apm_service_claim_notification(uuid, text, text, text, text) to service_role;
grant execute on function private.apm_service_finish_notification(uuid, text, text) to service_role;
grant execute on function public.apm_service_morning_candidates(timestamptz, integer) to service_role;
grant execute on function public.apm_service_print_agenda(uuid, date, jsonb) to service_role;
grant execute on function public.apm_service_claim_notification(uuid, text, text, text, text) to service_role;
grant execute on function public.apm_service_finish_notification(uuid, text, text) to service_role;

revoke all on function private.apm_close_day_review(text, text, jsonb, text, text, text) from public, anon;
revoke all on function public.apm_close_day_review(text, text, jsonb, text, text, text) from public, anon;
grant execute on function private.apm_close_day_review(text, text, jsonb, text, text, text) to authenticated;
grant execute on function public.apm_close_day_review(text, text, jsonb, text, text, text) to authenticated;
