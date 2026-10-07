-- 0031: Morning Trigger fixes (Codex review of PR #21).
--
--  1. The wake window belongs to the wake time's own local day (no wrap past midnight).
--  2. The window is 6 h, so a push held for a full 4-hour Deep Work block is still sent.
--  3. A failed delivery, or a claim abandoned mid-send, is retried by a later tick.

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
   -- The window belongs to the local day of the wake time (no wrap past midnight) and lasts
   -- 6 h, so a push held by a 4-hour Deep Work block is still delivered when the block ends.
   where (extract(epoch from t.local_ts::time) - extract(epoch from t.wake_time::time)) / 60 between 0 and 359
     and not exists (
       select 1 from public.notifications n
        where n.user_id = t.user_id and n.dedupe_key = 'morning:' || t.local_ts::date::text
          and (n.status in ('sent','opened','suppressed') or (n.status = 'queued' and n.created_at > now() - interval '10 minutes'))
     )
   order by t.user_id
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;


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
  -- A failed delivery, or a claim abandoned mid-send (still queued after 10 minutes), is
  -- re-claimed by a later tick instead of silently losing the day's Morning Trigger.
  on conflict (user_id, dedupe_key) do update
     set status = 'queued', title = excluded.title, body = excluded.body, suppression_reason = null, created_at = now()
   where public.notifications.status = 'failed'
      or (public.notifications.status = 'queued' and public.notifications.created_at < now() - interval '10 minutes')
  returning id into v_id;
  return v_id;
end;
$$;

