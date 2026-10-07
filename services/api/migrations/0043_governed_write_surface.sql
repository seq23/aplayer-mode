-- 0043: close the direct-write surface that bypassed governed functions
-- (backend review, 7 Oct 2026: db P1-1..P1-4, P2-3; api P1-1, P1-2, P1-5; engine P1-5).
--
--  A. audit_events: no client writes at all. The Worker records audits through a
--     service-role function with a fixed event/actor allow-list; every other audit
--     row is written inside the SECURITY DEFINER function that did the work.
--  B. personal_os / tracks / pillar_settings: no direct client writes. The intake and
--     mode writers become SECURITY DEFINER (search_path ''), so the Week-1 lock, the
--     body red-flag referral stop and the OS change flow cannot be skipped by a PATCH.
--  C. data_rights_jobs: requested through an audited function; only the server marks
--     a job complete; deletions are claimed and executed by the cron's service-role
--     processor (services/api/src/dataRights.ts) and leave an erasure receipt.
--  D. actions / action_attempts: no client writes. Prepare, claim and result are
--     service-role functions: prepare is idempotent (never resets a row), the claim
--     is a single conditional UPDATE (a double approve executes once), and a trigger
--     forbids any status moving backwards.
--  E. The data-rights export reads every user-owned table from one registry; a test
--     fails when a table with a user column is missing from it.

-- ---------------------------------------------------------------- A. audit
drop policy if exists audit_events_insert_own on public.audit_events;
revoke insert, update, delete, truncate, references, trigger on table public.audit_events from anon, authenticated;

create or replace function private.apm_service_record_audit(
  p_user_id uuid, p_event_type text, p_actor_type text, p_object_type text, p_object_id text, p_metadata jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'audit_unknown_user' using errcode = '22023';
  end if;
  -- The only events the Worker itself records (services/api/src/audit.ts WORKER_AUDIT_EVENTS
  -- is pinned to this list by test/security-write-surface-db.test.mjs).
  if p_actor_type = 'user' and p_event_type not in (
       'day.replan_refused','integration.connected','next_action.completed','notification_preferences.updated',
       'operating_mode.changed','permission.changed','personal_os.installed','product_interest.changed',
       'mode.entered','mode.exited','sprint.completed','sprint.recovery_started','recovery.return_declared','recovery.resumed')
     or p_actor_type = 'system' and p_event_type not in (
       'mode.auto_exited','mode.exited','sprint.completed','sprint.recovery_started','recovery.resumed','coaching.safety_stop')
     or p_actor_type not in ('user','system') then
    raise exception 'audit_event_not_allowed' using errcode = '22023';
  end if;
  if p_metadata is not null and (jsonb_typeof(p_metadata) <> 'object' or pg_catalog.octet_length(p_metadata::text) > 4096) then
    raise exception 'audit_invalid_metadata' using errcode = '22023';
  end if;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, p_event_type, p_actor_type, 'worker', left(p_object_type, 80), left(p_object_id, 200), coalesce(p_metadata, '{}'::jsonb));
end;
$$;
create or replace function public.apm_service_record_audit(
  p_user_id uuid, p_event_type text, p_actor_type text, p_object_type text, p_object_id text, p_metadata jsonb
)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_record_audit(p_user_id, p_event_type, p_actor_type, p_object_type, p_object_id, p_metadata); $$;
revoke all on function private.apm_service_record_audit(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_record_audit(uuid, text, text, text, text, jsonb) to service_role;
revoke all on function public.apm_service_record_audit(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.apm_service_record_audit(uuid, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------- B. Personal OS
drop policy if exists personal_os_insert_own on public.personal_os;
drop policy if exists personal_os_update_own on public.personal_os;
drop policy if exists personal_os_delete_own on public.personal_os;
drop policy if exists pillar_settings_insert_own on public.pillar_settings;
drop policy if exists pillar_settings_update_own on public.pillar_settings;
drop policy if exists pillar_settings_delete_own on public.pillar_settings;
drop policy if exists tracks_insert_own on public.tracks;
drop policy if exists tracks_update_own on public.tracks;
drop policy if exists tracks_delete_own on public.tracks;
revoke insert, update, delete, truncate, references, trigger on table public.personal_os from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.pillar_settings from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.tracks from anon, authenticated;

-- Track 1 is only ever shown by its display name (@apm/domain TRACK_DISPLAY_NAMES).
update public.tracks set name = 'Billionaire High Performance Coach Track' where key = 'billionaire_mindset' and name <> 'Billionaire High Performance Coach Track';

create or replace function private.apm_save_methodology_intake(p_payload jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid;
  v_role text;
  v_track_key text;
  v_track_name text;
  v_pillar text;
  v_primary_goal text := nullif(trim(p_payload->>'primary_goal'), '');
  v_first_action text := nullif(trim(p_payload->>'first_next_action'), '');
  v_active_mode text := coalesce(nullif(p_payload->>'active_mode', ''), 'standard');
  v_track jsonb;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;
  if v_primary_goal is null then
    raise exception 'primary_goal_required';
  end if;
  if v_active_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;

  insert into public.user_profiles (user_id, display_name, timezone, current_season, becoming, updated_at)
  values (
    v_user_id,
    coalesce(p_payload->>'display_name', ''),
    nullif(p_payload->>'timezone', ''),
    nullif(p_payload->>'current_season', ''),
    nullif(p_payload->>'becoming', ''),
    now()
  )
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    timezone = excluded.timezone,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  for v_role in select jsonb_array_elements_text(coalesce(p_payload->'roles', '[]'::jsonb))
  loop
    if trim(v_role) <> '' then
      insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
      values (v_user_id, trim(v_role), true, 'stated', 'manual', 1)
      on conflict (user_id, name) do update set active = true;
    end if;
  end loop;

  select id into v_goal_id
    from public.goals
   where user_id = v_user_id and status = 'active' and priority = 1
   order by updated_at desc
   limit 1;

  if v_goal_id is null then
    v_goal_id := gen_random_uuid();
    update public.goals
       set priority = priority + 1, updated_at = now()
     where user_id = v_user_id;

    insert into public.goals (
      id, user_id, title, outcome, status, health, pillar, target_date, priority,
      provenance_kind, source_type, confidence
    ) values (
      v_goal_id,
      v_user_id,
      v_primary_goal,
      nullif(p_payload->>'goal_outcome', ''),
      'active',
      'unknown',
      nullif(p_payload->>'pillar', ''),
      nullif(p_payload->>'goal_target_date', '')::date,
      1,
      'stated',
      'manual',
      1
    );
  else
    update public.goals
       set title = v_primary_goal,
           outcome = nullif(p_payload->>'goal_outcome', ''),
           pillar = nullif(p_payload->>'pillar', ''),
           target_date = nullif(p_payload->>'goal_target_date', '')::date,
           updated_at = now()
     where id = v_goal_id and user_id = v_user_id;
  end if;

  -- next_actions are RPC-only (0035): seeds go through the governed writer.
  if v_first_action is not null then
    perform private.apm_seed_next_action(v_goal_id, v_first_action, true);
  elsif not exists (
    select 1 from public.next_actions
     where user_id = v_user_id and goal_id = v_goal_id and status = 'open'
  ) then
    perform private.apm_seed_next_action(v_goal_id, 'Spend 45 focused minutes advancing: ' || v_primary_goal, false);
  end if;

  insert into public.personal_os (
    user_id, north_star, core_values, non_negotiables, failure_patterns,
    body_context, work_money_context, mind_spirit_learning_context,
    weekly_cadence, coaching_style, accountability, active_mode, foreground_goal_id,
    installed_at, updated_at
  ) values (
    v_user_id,
    nullif(p_payload->>'north_star', ''),
    coalesce(p_payload->'values', '[]'::jsonb),
    coalesce(p_payload->'non_negotiables', '[]'::jsonb),
    coalesce(p_payload->'failure_patterns', '[]'::jsonb),
    nullif(p_payload->>'body_context', ''),
    nullif(p_payload->>'work_money_context', ''),
    nullif(p_payload->>'mind_spirit_learning_context', ''),
    coalesce(p_payload->'weekly_cadence', '{"heavyDays":[],"lightDays":[]}'::jsonb),
    coalesce(p_payload->'coaching_style', '{"firmness":"direct"}'::jsonb),
    coalesce(p_payload->'accountability', '{"dayStart":"guided"}'::jsonb),
    v_active_mode,
    v_goal_id,
    now(),
    now()
  )
  on conflict (user_id) do update set
    north_star = excluded.north_star,
    core_values = excluded.core_values,
    non_negotiables = excluded.non_negotiables,
    failure_patterns = excluded.failure_patterns,
    body_context = excluded.body_context,
    work_money_context = excluded.work_money_context,
    mind_spirit_learning_context = excluded.mind_spirit_learning_context,
    weekly_cadence = excluded.weekly_cadence,
    coaching_style = excluded.coaching_style,
    accountability = excluded.accountability,
    active_mode = excluded.active_mode,
    foreground_goal_id = excluded.foreground_goal_id,
    updated_at = now();

  -- Formerly a direct PATCH from the Worker. Never stabilization_started_at,
  -- body_referral_* or clinician_cleared_at: those move only through their own
  -- governed functions (0032), never from client input.
  if jsonb_typeof(coalesce(p_payload->'morning_sequence', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload->'morning_sequence', '[]'::jsonb)) > 5
     or jsonb_typeof(coalesce(p_payload->'hard_boundaries', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload->'hard_boundaries', '[]'::jsonb)) > 20
     or coalesce(p_payload->>'scheduling_preference', 'ordered_stack') not in ('strict_blocks','loose_dayparts','ordered_stack')
     or jsonb_typeof(coalesce(p_payload->'scoring_config', '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_request';
  end if;
  update public.personal_os set
    morning_sequence = coalesce(p_payload->'morning_sequence', '[]'::jsonb),
    scheduling_preference = coalesce(p_payload->>'scheduling_preference', 'ordered_stack'),
    hard_boundaries = coalesce(p_payload->'hard_boundaries', '[]'::jsonb),
    scoring_config = coalesce(p_payload->'scoring_config', '{"enabled":true,"showSevenDaySnapshot":true}'::jsonb),
    updated_at = now()
  where user_id = v_user_id;

  delete from public.pillar_settings where user_id = v_user_id;
  foreach v_pillar in array array['wealth','body','spirit','execution']
  loop
    insert into public.pillar_settings (user_id, name, active, critical, minimum_floor)
    values (
      v_user_id,
      v_pillar,
      true,
      exists (
        select 1
          from jsonb_array_elements_text(coalesce(p_payload->'critical_pillars', '[]'::jsonb)) as cp(value)
         where cp.value = v_pillar
      ),
      nullif(p_payload->'minimum_floors'->>v_pillar, '')
    );
  end loop;

  -- The full Track set the user chose, with the display names the Worker passes from
  -- @apm/domain TRACK_DISPLAY_NAMES (one map; the key is the only thing validated here).
  if jsonb_typeof(coalesce(p_payload->'tracks', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_payload->'tracks', '[]'::jsonb)) > 7 then
    raise exception 'invalid_tracks';
  end if;
  delete from public.tracks where user_id = v_user_id;
  for v_track in select jsonb_array_elements(coalesce(p_payload->'tracks', '[]'::jsonb))
  loop
    v_track_key := v_track->>'key';
    v_track_name := btrim(coalesce(v_track->>'name', ''));
    if v_track_key is null or char_length(v_track_name) not between 1 and 120 then
      raise exception 'invalid_tracks';
    end if;
    insert into public.tracks (user_id, key, name, active, foreground, provenance_kind, source_type, confidence)
    values (v_user_id, v_track_key, v_track_name, true, false, 'stated', 'manual', 1)
    on conflict (user_id, key) do update set name = excluded.name, active = true;
  end loop;

  delete from public.operating_modes where user_id = v_user_id;
  insert into public.operating_modes (user_id, key, name, active, provenance_kind, source_type, confidence)
  values
    (v_user_id, 'standard', 'Standard', v_active_mode = 'standard', 'system', 'system', 1),
    (v_user_id, 'recovery', 'Recovery', v_active_mode = 'recovery', 'system', 'system', 1),
    (v_user_id, 'high_pressure', 'High-Pressure Coaching', v_active_mode = 'high_pressure', 'system', 'system', 1),
    (v_user_id, 'executive_review', 'Executive Review', v_active_mode = 'executive_review', 'system', 'system', 1),
    (v_user_id, 'sprint', 'Sprint', false, 'system', 'system', 1),
    (v_user_id, 'deep_work', 'Deep Work', false, 'system', 'system', 1);
end;
$$;
create or replace function public.apm_save_methodology_intake(p_payload jsonb)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_save_methodology_intake(p_payload); $$;
revoke all on function private.apm_save_methodology_intake(jsonb) from public, anon;
grant execute on function private.apm_save_methodology_intake(jsonb) to authenticated;
revoke all on function public.apm_save_methodology_intake(jsonb) from public, anon;
grant execute on function public.apm_save_methodology_intake(jsonb) to authenticated;

create or replace function private.apm_set_mode_state(
  p_mode text, p_started_at timestamptz, p_ends_at timestamptz, p_focus text, p_recovery_locked_until timestamptz, p_resume jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review','sprint','deep_work') then
    raise exception 'invalid_mode';
  end if;
  update public.personal_os
     set active_mode = p_mode,
         mode_started_at = p_started_at,
         mode_ends_at = p_ends_at,
         mode_focus = nullif(btrim(coalesce(p_focus, '')), ''),
         recovery_locked_until = p_recovery_locked_until,
         mode_resume = p_resume,
         updated_at = now()
   where user_id = v_user_id;
  if not found then raise exception 'personal_os_missing'; end if;
  update public.operating_modes set active = (key = p_mode) where user_id = v_user_id;
end;
$$;
create or replace function public.apm_set_mode_state(
  p_mode text, p_started_at timestamptz, p_ends_at timestamptz, p_focus text, p_recovery_locked_until timestamptz, p_resume jsonb
)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_set_mode_state(p_mode, p_started_at, p_ends_at, p_focus, p_recovery_locked_until, p_resume); $$;
revoke all on function private.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) from public, anon;
grant execute on function private.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) to authenticated;
revoke all on function public.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) from public, anon;
grant execute on function public.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) to authenticated;

create or replace function private.apm_set_operating_mode(p_mode text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_mode in ('sprint','deep_work') then raise exception 'mode_requires_duration'; end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;
  update public.personal_os set active_mode = p_mode, updated_at = now() where user_id = v_user_id;
  update public.operating_modes set active = (key = p_mode) where user_id = v_user_id;
end;
$$;
create or replace function public.apm_set_operating_mode(p_mode text)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_set_operating_mode(p_mode); $$;
revoke all on function private.apm_set_operating_mode(text) from public, anon;
grant execute on function private.apm_set_operating_mode(text) to authenticated;
revoke all on function public.apm_set_operating_mode(text) from public, anon;
grant execute on function public.apm_set_operating_mode(text) to authenticated;

-- ---------------------------------------------------------------- C. data rights
drop policy if exists data_rights_jobs_insert_own on public.data_rights_jobs;
drop policy if exists data_rights_jobs_update_own on public.data_rights_jobs;
drop policy if exists data_rights_jobs_delete_own on public.data_rights_jobs;
revoke insert, update, delete, truncate, references, trigger on table public.data_rights_jobs from anon, authenticated;
alter table public.data_rights_jobs add column attempts integer not null default 0 check (attempts between 0 and 1000);
alter table public.data_rights_jobs add column claimed_at timestamptz;

-- The erasure receipt outlives the account: the job row is deleted with the auth user
-- (on delete cascade), so proof that a requested erasure ran is kept here, with no
-- foreign key and no personal data beyond the random account id.
create table private.data_rights_erasures (
  job_id uuid primary key,
  user_id uuid not null,
  requested_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  status text not null default 'processing' check (status in ('processing','complete','failed')),
  attempts integer not null default 0,
  failure_code text check (failure_code is null or char_length(failure_code) <= 200),
  steps jsonb not null default '{}'::jsonb check (jsonb_typeof(steps) = 'object')
);
alter table private.data_rights_erasures enable row level security;
create policy data_rights_erasures_server_only on private.data_rights_erasures for all to anon, authenticated using (false) with check (false);
revoke all on table private.data_rights_erasures from public, anon, authenticated;

create or replace function private.apm_request_data_rights(p_job_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.data_rights_jobs;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_job_type not in ('export','delete') then raise exception 'data_rights_invalid_type' using errcode = '22023'; end if;
  if p_job_type = 'delete' then
    -- One open erasure request at a time; a repeat request returns the open one.
    select * into v_row from public.data_rights_jobs j
     where j.user_id = v_uid and j.job_type = 'delete' and j.status in ('requested','processing')
     order by j.requested_at limit 1;
    if v_row.id is not null then return to_jsonb(v_row); end if;
  end if;
  insert into public.data_rights_jobs (user_id, job_type) values (v_uid, p_job_type) returning * into v_row;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (v_uid, case p_job_type when 'delete' then 'deletion.requested' else 'data_export.requested' end,
          'user', null, 'data_rights_job', v_row.id::text, '{}'::jsonb);
  return to_jsonb(v_row);
end;
$$;
create or replace function public.apm_request_data_rights(p_job_type text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_request_data_rights(p_job_type); $$;
revoke all on function private.apm_request_data_rights(text) from public, anon;
grant execute on function private.apm_request_data_rights(text) to authenticated;
revoke all on function public.apm_request_data_rights(text) from public, anon;
grant execute on function public.apm_request_data_rights(text) to authenticated;

-- An export job is marked complete only by the server, after it built the export.
create or replace function private.apm_service_data_rights_complete_export(p_user_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.data_rights_jobs;
begin
  update public.data_rights_jobs j set status = 'complete', completed_at = now()
   where j.id = p_job_id and j.user_id = p_user_id and j.job_type = 'export' and j.status = 'requested'
  returning * into v_row;
  if v_row.id is null then raise exception 'data_rights_job_not_found' using errcode = 'P0002'; end if;
  return to_jsonb(v_row);
end;
$$;

-- Claims erasure requests for the cron processor. A claim older than an hour
-- (a crashed run) is claimed again; a failed attempt is retried after an hour.
create or replace function private.apm_service_data_rights_claim_deletions(p_limit integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job public.data_rights_jobs;
  v_out jsonb := '[]'::jsonb;
begin
  for v_job in
    select * from public.data_rights_jobs j
     where j.job_type = 'delete'
       and ((j.status = 'requested' and (j.claimed_at is null or j.claimed_at < now() - interval '1 hour'))
         or (j.status = 'processing' and j.claimed_at < now() - interval '1 hour'))
     order by j.requested_at
     limit least(greatest(coalesce(p_limit, 5), 1), 25)
     for update skip locked
  loop
    update public.data_rights_jobs set status = 'processing', claimed_at = now(), attempts = attempts + 1 where id = v_job.id;
    insert into private.data_rights_erasures (job_id, user_id, requested_at, claimed_at, attempts)
    values (v_job.id, v_job.user_id, v_job.requested_at, now(), 1)
    on conflict (job_id) do update set claimed_at = now(), status = 'processing', attempts = private.data_rights_erasures.attempts + 1;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'jobId', v_job.id, 'userId', v_job.user_id, 'requestedAt', v_job.requested_at,
      'connections', coalesce((select jsonb_agg(jsonb_build_object(
          'id', c.id, 'provider', c.provider, 'kind', c.kind,
          'encryptedCredentials', c.encrypted_credentials, 'credentialIv', c.credential_iv))
        from public.integration_connections c where c.user_id = v_job.user_id and c.encrypted_credentials is not null), '[]'::jsonb)));
  end loop;
  return v_out;
end;
$$;

-- Removes what the auth-user cascade would not: rows whose foreign key is
-- ON DELETE SET NULL (usage, analytics) and the billing ledger's user link.
create or replace function private.apm_service_data_rights_purge(p_job_id uuid, p_steps jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_er private.data_rights_erasures;
begin
  select * into v_er from private.data_rights_erasures e where e.job_id = p_job_id and e.status = 'processing' for update;
  if v_er.job_id is null then raise exception 'data_rights_job_not_found' using errcode = 'P0002'; end if;
  delete from public.ai_usage_events where user_id = v_er.user_id;
  delete from public.analytics_events where user_id = v_er.user_id;
  update public.integration_connections set encrypted_credentials = null, credential_iv = null, status = 'disconnected', updated_at = now()
   where user_id = v_er.user_id;
  update public.push_subscriptions set active = false, updated_at = now() where user_id = v_er.user_id;
  update private.billing_events set user_id = null, app_user_id = null where user_id = v_er.user_id;
  update private.data_rights_erasures set steps = steps || coalesce(p_steps, '{}'::jsonb) where job_id = p_job_id;
end;
$$;

-- Records completion only once the auth identity (and with it every cascaded row) is gone.
create or replace function private.apm_service_data_rights_finish(p_job_id uuid, p_steps jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_er private.data_rights_erasures;
begin
  select * into v_er from private.data_rights_erasures e where e.job_id = p_job_id for update;
  if v_er.job_id is null then raise exception 'data_rights_job_not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from auth.users u where u.id = v_er.user_id) then
    raise exception 'data_rights_identity_still_exists' using errcode = '55000';
  end if;
  update private.data_rights_erasures
     set status = 'complete', completed_at = now(), failure_code = null, steps = steps || coalesce(p_steps, '{}'::jsonb)
   where job_id = p_job_id
  returning * into v_er;
  return jsonb_build_object('jobId', v_er.job_id, 'status', v_er.status, 'completedAt', v_er.completed_at);
end;
$$;

create or replace function private.apm_service_data_rights_fail(p_job_id uuid, p_failure_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.data_rights_jobs set status = 'requested', failure_code = left(p_failure_code, 200) where id = p_job_id and status = 'processing';
  update private.data_rights_erasures set status = 'failed', failure_code = left(p_failure_code, 200) where job_id = p_job_id;
end;
$$;

-- The named stop: erasure requests still open after p_hours.
create or replace function private.apm_service_data_rights_overdue(p_hours integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from public.data_rights_jobs j
   where j.job_type = 'delete' and j.status in ('requested','processing')
     and j.requested_at < now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1));
$$;

create or replace function public.apm_service_data_rights_complete_export(p_user_id uuid, p_job_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_data_rights_complete_export(p_user_id, p_job_id); $$;
create or replace function public.apm_service_data_rights_claim_deletions(p_limit integer)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_data_rights_claim_deletions(p_limit); $$;
create or replace function public.apm_service_data_rights_purge(p_job_id uuid, p_steps jsonb)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_data_rights_purge(p_job_id, p_steps); $$;
create or replace function public.apm_service_data_rights_finish(p_job_id uuid, p_steps jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_data_rights_finish(p_job_id, p_steps); $$;
create or replace function public.apm_service_data_rights_fail(p_job_id uuid, p_failure_code text)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_data_rights_fail(p_job_id, p_failure_code); $$;
create or replace function public.apm_service_data_rights_overdue(p_hours integer)
returns integer language sql stable security invoker set search_path = ''
as $$ select private.apm_service_data_rights_overdue(p_hours); $$;

-- ---------------------------------------------------------------- D. actions
drop policy if exists actions_insert_own on public.actions;
drop policy if exists actions_update_own on public.actions;
drop policy if exists actions_delete_own on public.actions;
drop policy if exists action_attempts_insert_own on public.action_attempts;
drop policy if exists action_attempts_update_own on public.action_attempts;
drop policy if exists action_attempts_delete_own on public.action_attempts;
revoke insert, update, delete, truncate, references, trigger on table public.actions from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.action_attempts from anon, authenticated;

-- The action state machine only moves forward. Once execution starts, the row can
-- never be re-prepared or re-approved (so it can never execute twice) and what it
-- executed (domain, type, payload) is frozen. Undo of a verified write is 'cancelled'.
create or replace function private.apm_actions_forward_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('executing','executed','verified','closed','failed','cancelled')
     and new.status in ('proposed','prepared','approved') then
    raise exception 'action_status_backwards' using errcode = '55000';
  end if;
  if old.status in ('executed','verified','closed','failed','cancelled') and new.status = 'executing' then
    raise exception 'action_status_backwards' using errcode = '55000';
  end if;
  if old.status not in ('proposed','prepared','approved')
     and (new.domain is distinct from old.domain or new.action_type is distinct from old.action_type
          or new.payload is distinct from old.payload or new.idempotency_key is distinct from old.idempotency_key) then
    raise exception 'action_frozen' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function private.apm_actions_forward_only() from public, anon, authenticated;
drop trigger if exists actions_forward_only on public.actions;
create trigger actions_forward_only before update on public.actions
  for each row execute function private.apm_actions_forward_only();

-- Prepare: the Worker has already run the policy decision. Idempotent on the key:
-- a retry returns the existing row unchanged; a different action under the same key
-- is refused. 'autopilot:' keys belong to the standing-rule path (0018/0033).
create or replace function private.apm_service_action_prepare(
  p_user_id uuid, p_domain text, p_action_type text, p_payload jsonb, p_reason text, p_permission_id uuid, p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.actions;
begin
  if p_user_id is null or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' or char_length(coalesce(p_reason, '')) not between 3 and 1000 then
    raise exception 'action_invalid_request' using errcode = '22023';
  end if;
  if p_idempotency_key like 'autopilot:%' then raise exception 'action_key_reserved' using errcode = '22023'; end if;
  if p_payload ? 'stoppedReason' or p_payload ? 'composed' then raise exception 'action_invalid_request' using errcode = '22023'; end if;
  if p_permission_id is not null and not exists (select 1 from public.permissions p where p.id = p_permission_id and p.user_id = p_user_id) then
    raise exception 'action_invalid_request' using errcode = '22023';
  end if;
  insert into public.actions (user_id, domain, action_type, status, payload, reason, permission_id, idempotency_key, requires_approval, updated_at)
  values (p_user_id, p_domain, p_action_type, 'prepared', p_payload, p_reason, p_permission_id, p_idempotency_key, true, now())
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_row;
  if v_row.id is not null then
    insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
    values (p_user_id, 'action.prepared', 'user', 'worker', 'action', v_row.id::text, jsonb_build_object('domain', p_domain, 'actionType', p_action_type));
    return jsonb_build_object('action', to_jsonb(v_row), 'replayed', false);
  end if;
  select * into v_row from public.actions a where a.user_id = p_user_id and a.idempotency_key = p_idempotency_key;
  if v_row.domain is distinct from p_domain or v_row.action_type is distinct from p_action_type or v_row.payload is distinct from p_payload then
    raise exception 'action_idempotency_conflict' using errcode = '23505';
  end if;
  return jsonb_build_object('action', to_jsonb(v_row), 'replayed', true);
end;
$$;

-- Claim: one conditional UPDATE. Of two concurrent approvals exactly one gets the row.
create or replace function private.apm_service_action_claim(p_user_id uuid, p_action_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.actions;
begin
  update public.actions a set status = 'executing', approved_at = now(), updated_at = now()
   where a.id = p_action_id and a.user_id = p_user_id and a.status in ('prepared','approved')
     and not (a.payload ? 'stoppedReason')
  returning * into v_row;
  if v_row.id is null then raise exception 'action_invalid_state' using errcode = '55000'; end if;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, 'action.approved', 'user', 'worker', 'action', v_row.id::text, jsonb_build_object('domain', v_row.domain, 'actionType', v_row.action_type));
  return to_jsonb(v_row);
end;
$$;

-- Result: only an executing action takes a result; success and failure are both audited.
create or replace function private.apm_service_action_result(
  p_user_id uuid, p_action_id uuid, p_outcome text, p_provider text, p_external_ref text, p_failure_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.actions;
begin
  if p_outcome not in ('verified','failed') then raise exception 'action_invalid_request' using errcode = '22023'; end if;
  update public.actions a set
    status = p_outcome,
    executed_at = case when p_outcome = 'verified' then now() else a.executed_at end,
    verified_at = case when p_outcome = 'verified' then now() else null end,
    failure_code = case when p_outcome = 'failed' then left(coalesce(p_failure_code, 'unknown_failure'), 120) else null end,
    updated_at = now()
   where a.id = p_action_id and a.user_id = p_user_id and a.status = 'executing'
  returning * into v_row;
  if v_row.id is null then raise exception 'action_invalid_state' using errcode = '55000'; end if;
  insert into public.action_attempts (user_id, action_id, attempt, status, provider, external_ref, error_code, completed_at)
  values (p_user_id, p_action_id,
          coalesce((select max(aa.attempt) from public.action_attempts aa where aa.action_id = p_action_id), 0) + 1,
          case when p_outcome = 'verified' then 'succeeded' else 'failed' end,
          nullif(left(coalesce(p_provider, ''), 40), ''),
          case when p_outcome = 'verified' then nullif(left(coalesce(p_external_ref, ''), 500), '') else null end,
          case when p_outcome = 'failed' then left(coalesce(p_failure_code, 'unknown_failure'), 120) else null end,
          now());
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, case when p_outcome = 'verified' then 'action.executed' else 'action.failed' end, 'connector', p_provider, 'action', v_row.id::text,
          jsonb_build_object('domain', v_row.domain, 'actionType', v_row.action_type, 'status', v_row.status,
                             'failureCode', case when p_outcome = 'failed' then v_row.failure_code else null end));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.apm_service_action_prepare(
  p_user_id uuid, p_domain text, p_action_type text, p_payload jsonb, p_reason text, p_permission_id uuid, p_idempotency_key text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_action_prepare(p_user_id, p_domain, p_action_type, p_payload, p_reason, p_permission_id, p_idempotency_key); $$;
create or replace function public.apm_service_action_claim(p_user_id uuid, p_action_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_action_claim(p_user_id, p_action_id); $$;
create or replace function public.apm_service_action_result(
  p_user_id uuid, p_action_id uuid, p_outcome text, p_provider text, p_external_ref text, p_failure_code text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_action_result(p_user_id, p_action_id, p_outcome, p_provider, p_external_ref, p_failure_code); $$;

-- ---------------------------------------------------------------- E. export registry
-- Every table holding a user's rows, and the column that names the user. A full-chain
-- test fails when a table with a user column is missing here, so a new table can
-- never be left out of the export silently. Secrets are never exported.
create table private.data_rights_tables (
  table_schema text not null check (table_schema in ('public','private')),
  table_name text not null,
  user_column text not null,
  redact_columns text[] not null default '{}',
  primary key (table_schema, table_name, user_column)
);
alter table private.data_rights_tables enable row level security;
create policy data_rights_tables_server_only on private.data_rights_tables for all to anon, authenticated using (false) with check (false);
revoke all on table private.data_rights_tables from public, anon, authenticated;

insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns) values
  ('public','action_attempts','user_id','{}'), ('public','actions','user_id','{}'), ('public','ai_usage_events','user_id','{}'),
  ('public','analytics_events','user_id','{}'), ('public','audit_events','user_id','{}'), ('public','autopilot_executions','user_id','{}'),
  ('public','autopilot_flexible_events','user_id','{}'), ('public','autopilot_rules','user_id','{}'), ('public','autopilot_settings','user_id','{}'),
  ('public','calendar_events','user_id','{}'), ('public','coaching_sessions','user_id','{}'), ('public','coaching_turns','user_id','{}'),
  ('public','commitments','user_id','{}'), ('public','data_rights_jobs','user_id','{}'), ('public','day_records','user_id','{}'),
  ('public','diary_entries','user_id','{}'), ('public','evidence','user_id','{}'), ('public','goal_plans','user_id','{}'),
  ('public','goals','user_id','{}'), ('public','household_items','created_by','{}'), ('public','household_items','assigned_user_id','{}'),
  ('public','household_members','user_id','{}'), ('public','households','created_by','{}'),
  ('public','integration_connections','user_id','{encrypted_credentials,credential_iv,sync_cursor}'),
  ('public','life_admin_items','user_id','{}'), ('public','life_relationships','user_id','{}'), ('public','message_signals','user_id','{}'),
  ('public','milestones','user_id','{}'), ('public','next_actions','user_id','{}'), ('public','notification_preferences','user_id','{}'),
  ('public','notifications','user_id','{}'), ('public','operating_modes','user_id','{}'), ('public','os_change_requests','user_id','{}'),
  ('public','people','user_id','{}'), ('public','permissions','user_id','{}'), ('public','personal_os','user_id','{}'),
  ('public','pillar_settings','user_id','{}'), ('public','plan_action_completions','user_id','{}'), ('public','preferences','user_id','{}'),
  ('public','product_interests','user_id','{}'), ('public','projects','user_id','{}'), ('public','push_subscriptions','user_id','{expo_push_token}'),
  ('public','roles','user_id','{}'), ('public','routines','user_id','{}'), ('public','rules','user_id','{}'),
  ('public','subscription_entitlements','user_id','{}'), ('public','tracks','user_id','{}'), ('public','user_profiles','user_id','{}'),
  ('public','weekly_reviews','user_id','{}'),
  ('private','billing_events','user_id','{}'), ('private','billing_founding_slots','user_id','{}');

-- The user's complete export: every registered table, every row (no cap), read as the
-- owner whatever the current entitlement (the right of access survives a downgrade).
create or replace function private.apm_data_rights_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_t private.data_rights_tables;
  v_rows jsonb;
  v_out jsonb := '{}'::jsonb;
  v_key text;
begin
  if v_uid is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  for v_t in select * from private.data_rights_tables order by table_schema, table_name, user_column loop
    execute pg_catalog.format(
      'select coalesce(jsonb_agg(to_jsonb(t) - $2), ''[]''::jsonb) from %I.%I t where t.%I = $1',
      v_t.table_schema, v_t.table_name, v_t.user_column)
      into v_rows using v_uid, v_t.redact_columns;
    v_key := case when v_t.table_schema = 'public' then v_t.table_name else v_t.table_schema || '.' || v_t.table_name end
             || case when v_t.user_column = 'user_id' then '' else ':' || v_t.user_column end;
    v_out := v_out || jsonb_build_object(v_key, v_rows);
  end loop;
  return v_out;
end;
$$;
create or replace function public.apm_data_rights_export()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_data_rights_export(); $$;
revoke all on function private.apm_data_rights_export() from public, anon;
grant execute on function private.apm_data_rights_export() to authenticated;
revoke all on function public.apm_data_rights_export() from public, anon;
grant execute on function public.apm_data_rights_export() to authenticated;

-- ---------------------------------------------------------------- service grants
do $$
declare f text;
begin
  foreach f in array array[
    'apm_service_data_rights_complete_export(uuid, uuid)', 'apm_service_data_rights_claim_deletions(integer)',
    'apm_service_data_rights_purge(uuid, jsonb)', 'apm_service_data_rights_finish(uuid, jsonb)',
    'apm_service_data_rights_fail(uuid, text)', 'apm_service_data_rights_overdue(integer)',
    'apm_service_action_prepare(uuid, text, text, jsonb, text, uuid, text)', 'apm_service_action_claim(uuid, uuid)',
    'apm_service_action_result(uuid, uuid, text, text, text, text)'
  ] loop
    execute 'revoke all on function private.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function private.' || f || ' to service_role';
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;
