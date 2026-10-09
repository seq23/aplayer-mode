-- 0093: the 18+ age confirmation and the consumer health data consent (owner, 8 Oct 2026).
--
--  A. public.consent_records: one append-only row per decision, stamped by the server
--     (now()), never by the client. Clients can read their own rows; every write goes
--     through apm_record_consent (SECURITY DEFINER, search_path '', ownership from
--     auth.uid()), which also writes the audit event. Rows can never be edited.
--  B. Age: 'age_18_plus' / 'confirmed' is recorded once (a repeat keeps the first time).
--     The Worker refuses every account route until it exists (services/api/src/consent.ts),
--     and a new intake draft cannot be created without it (trigger below).
--  C. Consumer health data (Washington My Health My Data Act): 'consumer_health_data' with
--     'granted', 'declined' or 'withdrawn'; the latest row is the state. Without a live
--     grant, the intake draft trigger strips every health answer before it is stored
--     (the lists are packages/planning/src/intake/healthData.ts, pinned by
--     test/consent-db.test.mjs) and a health-routine reminder cannot be created.
--  D. Signing in to an existing account carries the anonymous session's decisions to it
--     (service role, before the draft merge), so nothing is asked twice.

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('age_18_plus', 'consumer_health_data')),
  decision text not null check (decision in ('confirmed', 'granted', 'declined', 'withdrawn')),
  policy_version text not null check (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  source text not null default 'app' check (source in ('app', 'merge')),
  recorded_at timestamptz not null default now(),
  check ((kind = 'age_18_plus' and decision = 'confirmed')
      or (kind = 'consumer_health_data' and decision in ('granted', 'declined', 'withdrawn')))
);
create index consent_records_user_kind_idx on public.consent_records (user_id, kind, recorded_at desc);

alter table public.consent_records enable row level security;
create policy consent_records_select_own on public.consent_records for select to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.consent_records from anon;
revoke insert, update, delete, truncate, references, trigger on table public.consent_records from authenticated;
grant select on table public.consent_records to authenticated;

-- Append-only: a recorded decision is evidence and is never rewritten (deletion of the
-- whole account still cascades).
create or replace function private.apm_consent_records_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'consent_records_append_only' using errcode = '42501';
end;
$$;
create trigger consent_records_no_update before update on public.consent_records
  for each row execute function private.apm_consent_records_immutable();

insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns)
values ('public', 'consent_records', 'user_id', '{}')
on conflict do nothing;

-- ---------------------------------------------------------------- state
create or replace function private.apm_consent_state(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ageConfirmedAt', (select min(r.recorded_at) from public.consent_records r where r.user_id = p_uid and r.kind = 'age_18_plus'),
    'healthData', (
      select jsonb_build_object('decision', r.decision, 'recordedAt', r.recorded_at, 'policyVersion', r.policy_version)
      from public.consent_records r
      where r.user_id = p_uid and r.kind = 'consumer_health_data'
      order by r.recorded_at desc, r.id desc
      limit 1
    )
  );
$$;
revoke all on function private.apm_consent_state(uuid) from public, anon, authenticated;

create or replace function private.apm_health_consent_active(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select r.decision = 'granted'
    from public.consent_records r
    where r.user_id = p_uid and r.kind = 'consumer_health_data'
    order by r.recorded_at desc, r.id desc
    limit 1
  ), false);
$$;
revoke all on function private.apm_health_consent_active(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- record (owner)
create or replace function private.apm_record_consent(p_kind text, p_decision text, p_policy_version text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_latest text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if coalesce(p_policy_version, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'consent_invalid_request' using errcode = '22023';
  end if;
  if p_kind = 'age_18_plus' then
    if p_decision is distinct from 'confirmed' then
      raise exception 'age_confirmation_required' using errcode = '22023';
    end if;
    -- Once is enough: a repeat keeps the first confirmation and its time.
    if exists (select 1 from public.consent_records r where r.user_id = v_uid and r.kind = 'age_18_plus') then
      return private.apm_consent_state(v_uid);
    end if;
  elsif p_kind = 'consumer_health_data' then
    if p_decision is null or p_decision not in ('granted', 'declined', 'withdrawn') then
      raise exception 'consent_invalid_request' using errcode = '22023';
    end if;
    select r.decision into v_latest from public.consent_records r
      where r.user_id = v_uid and r.kind = 'consumer_health_data'
      order by r.recorded_at desc, r.id desc limit 1;
    -- A repeat of the current decision is a no-op; withdrawing what was never given is too.
    if v_latest is not distinct from p_decision or (p_decision = 'withdrawn' and v_latest is distinct from 'granted') then
      return private.apm_consent_state(v_uid);
    end if;
  else
    raise exception 'consent_invalid_request' using errcode = '22023';
  end if;

  insert into public.consent_records (user_id, kind, decision, policy_version)
  values (v_uid, p_kind, p_decision, p_policy_version)
  returning id into v_id;
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (v_uid,
          case when p_kind = 'age_18_plus' then 'consent.age_confirmed' else 'consent.health_data_' || p_decision end,
          'user', 'consent_record', v_id::text, jsonb_build_object('policyVersion', p_policy_version));
  return private.apm_consent_state(v_uid);
end;
$$;
revoke all on function private.apm_record_consent(text, text, text) from public, anon;
grant execute on function private.apm_record_consent(text, text, text) to authenticated;

create or replace function public.apm_record_consent(p_kind text, p_decision text, p_policy_version text)
returns jsonb
language sql
volatile
set search_path = ''
as $$ select private.apm_record_consent(p_kind, p_decision, p_policy_version); $$;
revoke all on function public.apm_record_consent(text, text, text) from public, anon;
grant execute on function public.apm_record_consent(text, text, text) to authenticated;

create or replace function private.apm_my_consents()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return private.apm_consent_state(auth.uid());
end;
$$;
revoke all on function private.apm_my_consents() from public, anon;
grant execute on function private.apm_my_consents() to authenticated;

create or replace function public.apm_my_consents()
returns jsonb
language sql
stable
set search_path = ''
as $$ select private.apm_my_consents(); $$;
revoke all on function public.apm_my_consents() from public, anon;
grant execute on function public.apm_my_consents() to authenticated;

-- ---------------------------------------------------------------- merge (service role)
-- Called by the Worker after it has proven both sessions (POST /v1/intake/draft/merge).
-- The account keeps any decision it already has; otherwise it takes the anonymous one,
-- with its original time.
create or replace function private.apm_service_carry_consents(p_from uuid, p_to uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_age timestamptz;
  v_health public.consent_records;
begin
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'consent_invalid_request' using errcode = '22023';
  end if;
  if not exists (select 1 from public.consent_records r where r.user_id = p_to and r.kind = 'age_18_plus') then
    select min(r.recorded_at) into v_age from public.consent_records r where r.user_id = p_from and r.kind = 'age_18_plus';
    if v_age is not null then
      insert into public.consent_records (user_id, kind, decision, policy_version, source, recorded_at)
      select p_to, 'age_18_plus', 'confirmed', r.policy_version, 'merge', r.recorded_at
      from public.consent_records r where r.user_id = p_from and r.kind = 'age_18_plus' order by r.recorded_at limit 1;
    end if;
  end if;
  if not exists (select 1 from public.consent_records r where r.user_id = p_to and r.kind = 'consumer_health_data') then
    select * into v_health from public.consent_records r where r.user_id = p_from and r.kind = 'consumer_health_data'
      order by r.recorded_at desc, r.id desc limit 1;
    if v_health.id is not null then
      insert into public.consent_records (user_id, kind, decision, policy_version, source, recorded_at)
      values (p_to, 'consumer_health_data', v_health.decision, v_health.policy_version, 'merge', v_health.recorded_at);
    end if;
  end if;
  return private.apm_consent_state(p_to);
end;
$$;
revoke all on function private.apm_service_carry_consents(uuid, uuid) from public, anon, authenticated;
grant execute on function private.apm_service_carry_consents(uuid, uuid) to service_role;

create or replace function public.apm_service_carry_consents(p_from uuid, p_to uuid)
returns jsonb
language sql
volatile
set search_path = ''
as $$ select private.apm_service_carry_consents(p_from, p_to); $$;
revoke all on function public.apm_service_carry_consents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_carry_consents(uuid, uuid) to service_role;

-- ---------------------------------------------------------------- enforcement
-- The health items, mirrored from packages/planning/src/intake/healthData.ts.
create or replace function private.apm_strip_health_answers(p_answers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := coalesce(p_answers, '{}'::jsonb);
begin
  v := v - array['move', 'workout_days', 'food', 'weight_now', 'weigh_in', 'clinician_flag', 'clinician_sup', 'health_routine', 'bed', 'bed_move']::text[];
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
      'move', 'workout_days', 'food', 'weight_now', 'weigh_in', 'clinician_flag', 'clinician_sup', 'health_routine', 'bed', 'bed_move', 'goal', 'goal_size', 'foreground'));
  end if;
  return new;
end;
$$;
create trigger intake_drafts_consent_guard before insert or update on public.intake_drafts
  for each row execute function private.apm_intake_drafts_consent_guard();

create or replace function private.apm_life_admin_health_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'health_routine' and not private.apm_health_consent_active(new.user_id) then
    raise exception 'health_data_consent_required' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger life_admin_items_health_guard before insert or update of kind on public.life_admin_items
  for each row execute function private.apm_life_admin_health_guard();
