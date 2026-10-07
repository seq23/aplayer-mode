-- 0045: connector, push and Morning Trigger integrity (backend review, 7 Oct 2026:
-- api P1-3, P1-4, P1-6, P2-13).
--
--  A. Commitments: the source identity is a FULL unique index, so the email sync's
--     `on_conflict=user_id,source_type,source_ref,title` upsert can target it (PostgREST
--     cannot target a partial index). NULL source_ref rows stay distinct, exactly as before.
--  B. A calendar snapshot is replaced in ONE transaction: a failed insert can no longer
--     leave the window empty (and Autopilot's collision check blind). Duplicate event ids
--     in one snapshot are refused before anything is deleted.
--  C. Push tokens follow the device: registering a token deactivates it for every other
--     account (shared phone), and dead tokens (Expo DeviceNotRegistered) are deactivated.
--  D. Morning Trigger candidates rotate: each tick's page starts with the users who have
--     waited longest since their last consideration, so 200 held users can never starve
--     everyone after them.

-- ---------------------------------------------------------------- A. commitments
drop index if exists public.commitments_source_title_unique;
create unique index commitments_source_title_unique on public.commitments(user_id, source_type, source_ref, title);

-- ---------------------------------------------------------------- B. calendar window
create or replace function public.apm_replace_calendar_window(
  p_provider text, p_connection_id uuid, p_from timestamptz, p_to timestamptz, p_events jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_count integer;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_provider is null or p_from is null or p_to is null or p_to < p_from
     or p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 5000 then
    raise exception 'calendar_invalid_snapshot' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) e
     group by e->>'external_event_id' having count(*) > 1
  ) or exists (select 1 from jsonb_array_elements(p_events) e where coalesce(e->>'external_event_id', '') = '' or e->>'provider' is distinct from p_provider) then
    raise exception 'calendar_duplicate_event' using errcode = '22023';
  end if;
  delete from public.calendar_events c
   where c.user_id = v_uid and c.provider = p_provider
     and (p_connection_id is null or c.connection_id = p_connection_id)
     and c.starts_at >= p_from and c.starts_at <= p_to;
  insert into public.calendar_events (
    user_id, connection_id, provider, external_event_id, calendar_external_id, title, location, starts_at, ends_at,
    timezone, all_day, availability, recurrence, organizer, attendees, source_version, deleted, observed_at, updated_at
  )
  select v_uid, p_connection_id, p_provider, e->>'external_event_id', e->>'calendar_external_id', coalesce(e->>'title', ''), e->>'location',
         (e->>'starts_at')::timestamptz, (e->>'ends_at')::timestamptz, e->>'timezone', coalesce((e->>'all_day')::boolean, false),
         coalesce(e->>'availability', 'busy'), coalesce(e->'recurrence', '{}'::jsonb), coalesce(e->'organizer', '{}'::jsonb),
         coalesce(e->'attendees', '[]'::jsonb), e->>'source_version', coalesce((e->>'deleted')::boolean, false), now(), now()
    from jsonb_array_elements(p_events) e
  on conflict (user_id, provider, external_event_id) do update set
    connection_id = excluded.connection_id, calendar_external_id = excluded.calendar_external_id, title = excluded.title,
    location = excluded.location, starts_at = excluded.starts_at, ends_at = excluded.ends_at, timezone = excluded.timezone,
    all_day = excluded.all_day, availability = excluded.availability, recurrence = excluded.recurrence, organizer = excluded.organizer,
    attendees = excluded.attendees, source_version = excluded.source_version, deleted = excluded.deleted,
    observed_at = excluded.observed_at, updated_at = excluded.updated_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.apm_replace_calendar_window(text, uuid, timestamptz, timestamptz, jsonb) from public, anon;
grant execute on function public.apm_replace_calendar_window(text, uuid, timestamptz, timestamptz, jsonb) to authenticated;

-- ---------------------------------------------------------------- C. push tokens
create or replace function private.apm_service_register_push_token(p_user_id uuid, p_token text, p_device_id text, p_platform text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or char_length(coalesce(p_token, '')) not between 10 and 300
     or (p_platform is not null and p_platform not in ('ios','android','web')) then
    raise exception 'push_invalid_token' using errcode = '22023';
  end if;
  -- One device, one account: the previous account on this phone stops receiving.
  update public.push_subscriptions set active = false, updated_at = now()
   where expo_push_token = p_token and user_id <> p_user_id and active;
  insert into public.push_subscriptions (user_id, expo_push_token, device_id, platform, active, updated_at)
  values (p_user_id, p_token, left(p_device_id, 200), p_platform, true, now())
  on conflict (user_id, expo_push_token) do update set active = true, device_id = excluded.device_id, platform = excluded.platform, updated_at = now();
end;
$$;

create or replace function private.apm_service_deactivate_push_tokens(p_tokens text[])
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  update public.push_subscriptions set active = false, updated_at = now()
   where expo_push_token = any (coalesce(p_tokens, '{}')) and active;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.apm_service_register_push_token(p_user_id uuid, p_token text, p_device_id text, p_platform text)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_register_push_token(p_user_id, p_token, p_device_id, p_platform); $$;
create or replace function public.apm_service_deactivate_push_tokens(p_tokens text[])
returns integer language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_deactivate_push_tokens(p_tokens); $$;
do $$
declare f text;
begin
  foreach f in array array['apm_service_register_push_token(uuid, text, text, text)', 'apm_service_deactivate_push_tokens(text[])'] loop
    execute 'revoke all on function private.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function private.' || f || ' to service_role';
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---------------------------------------------------------------- D. Morning Trigger rotation
create table private.morning_trigger_considered (
  user_id uuid primary key references auth.users(id) on delete cascade,
  considered_at timestamptz not null
);
alter table private.morning_trigger_considered enable row level security;
create policy morning_trigger_considered_server_only on private.morning_trigger_considered for all to anon, authenticated using (false) with check (false);
revoke all on table private.morning_trigger_considered from public, anon, authenticated;
insert into private.data_rights_tables (table_schema, table_name, user_column) values ('private', 'morning_trigger_considered', 'user_id') on conflict do nothing;

drop function if exists public.apm_service_morning_candidates(timestamptz, integer);
drop function if exists private.apm_service_morning_candidates(timestamptz, integer);
create function private.apm_service_morning_candidates(p_now timestamptz, p_limit integer default 200)
returns table (user_id uuid, timezone text, wake_time text, local_day date)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
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
  ), eligible as (
    select t.user_id, t.tz, t.wake_time::text as wake_time, t.local_ts::date as local_day,
           (select c.considered_at from private.morning_trigger_considered c where c.user_id = t.user_id) as considered_at
      from timed t
     -- The window belongs to the local day of the wake time (no wrap past midnight) and lasts
     -- 6 h, so a push held by a 4-hour Deep Work block is still delivered when the block ends.
     where (extract(epoch from t.local_ts::time) - extract(epoch from t.wake_time::time)) / 60 between 0 and 359
       and not exists (
         select 1 from public.notifications n
          where n.user_id = t.user_id and n.dedupe_key = 'morning:' || t.local_ts::date::text
            and (n.status in ('sent','opened','suppressed') or (n.status = 'queued' and n.created_at > now() - interval '10 minutes'))
       )
     -- Longest-waiting first: never considered, then least recently considered.
     order by considered_at nulls first, t.user_id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ), marked as (
    insert into private.morning_trigger_considered (user_id, considered_at)
    select e.user_id, p_now from eligible e
    on conflict on constraint morning_trigger_considered_pkey do update set considered_at = excluded.considered_at
    returning private.morning_trigger_considered.user_id
  )
  select e.user_id, e.tz, e.wake_time, e.local_day from eligible e where e.user_id in (select m.user_id from marked m);
end;
$$;
create function public.apm_service_morning_candidates(p_now timestamptz, p_limit integer default 200)
returns table (user_id uuid, timezone text, wake_time text, local_day date)
language sql volatile security invoker set search_path = ''
as $$ select * from private.apm_service_morning_candidates(p_now, p_limit); $$;
revoke all on function private.apm_service_morning_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function private.apm_service_morning_candidates(timestamptz, integer) to service_role;
revoke all on function public.apm_service_morning_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.apm_service_morning_candidates(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------- E. body red flag on goals
-- A new goal's title/outcome is free text too: a red flag there pauses body coaching
-- before its plan is built (api P1-7).
alter table public.personal_os drop constraint if exists personal_os_body_referral_source_check;
alter table public.personal_os add constraint personal_os_body_referral_source_check
  check (body_referral_source is null or body_referral_source in ('intake','diary','day_close','check_in','os_change','goal'));
create or replace function private.apm_flag_body_referral(p_source text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_os public.personal_os;
begin
  if coalesce(p_source, '') not in ('intake','diary','day_close','check_in','os_change','goal') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
  update public.personal_os
     set body_referral_at = coalesce(body_referral_at, now()), body_referral_source = coalesce(body_referral_source, p_source),
         clinician_cleared_at = null, updated_at = now()
   where user_id = v_uid
  returning * into v_os;
  if v_os.user_id is null then raise exception 'loop_personal_os_missing' using errcode = 'P0002'; end if;
  perform private.apm_loop_audit(v_uid, 'body.referral_paused', 'personal_os', v_uid::text, jsonb_build_object('source', p_source));
  return jsonb_build_object('bodyReferralAt', v_os.body_referral_at, 'source', v_os.body_referral_source);
end;
$$;
