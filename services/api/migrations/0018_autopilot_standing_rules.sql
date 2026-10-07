-- Phase C — Autopilot standing rules (docs/31-AUTOPILOT-PHASE-C.md).
--
-- Autopilot is level-5 standing authority inside explicit, revocable rules the
-- user sets. The effective authority APM may exercise is
--
--   Autopilot entitlement (active/trialing)
--   AND explicit domain permission at level 5
--   AND an active, unexpired standing rule whose constraints the proposal meets
--   AND the action class is activated by runtime/security evidence
--   AND the user's master pause is off
--   AND the Worker kill switches (GLOBAL_ACTION_EXECUTION, the domain switch,
--       AUTOPILOT_EXECUTION) are on.
--
-- Buying Autopilot never grants authority by itself: a rule must be granted,
-- the permission must be raised to 5, and every supported class ships INACTIVE
-- until a reviewed migration records its runtime evidence.
--
-- Same security shape as migration 0017: the Worker holds only the publishable
-- key plus the user's JWT, so RLS and these functions are the boundary.
--   * anon/authenticated hold no INSERT/UPDATE/DELETE on any Autopilot table;
--   * every write goes through a thin SECURITY INVOKER wrapper in `public` over a
--     SECURITY DEFINER body in the non-exposed `private` schema
--     (search_path = ''), which checks ownership, entitlement and lifecycle and
--     writes its audit event in the same transaction;
--   * ordinary reads need own-row AND the Autopilot entitlement; the data-rights
--     export reads through an owner-only function with no entitlement condition;
--   * stopping authority (pause, revoke, master pause, undo) never needs an
--     entitlement, so a downgraded or lapsed user can always switch it off.
--
-- Never supported as standing classes: purchases, healthcare, banking/bill
-- payment or any other financial execution, sending email, editing existing
-- calendar events, connector administration. The class catalogue below is the
-- whole allow-list; anything else is rejected by name.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table public.autopilot_action_classes (
  class_key text primary key check (class_key in ('calendar.create','email.draft')),
  domain text not null check (domain in ('calendar','email')),
  action_type text not null,
  reversible boolean not null,
  undo_method text not null check (undo_method in ('delete_event','delete_draft')),
  activation_status text not null default 'inactive' check (activation_status in ('inactive','active')),
  evidence_ref text,
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  check (class_key = domain || '.' || split_part(action_type, '.', 2)),
  check (activation_status = 'inactive' or (evidence_ref is not null and activated_at is not null)),
  unique (domain, action_type)
);

-- Both supported classes are reversible and ship inactive. Activation is a
-- separate reviewed migration that records the runtime/security receipt.
insert into public.autopilot_action_classes (class_key, domain, action_type, reversible, undo_method) values
  ('calendar.create', 'calendar', 'calendar.create', true, 'delete_event'),
  ('email.draft', 'email', 'email.draft', true, 'delete_draft');

create table public.autopilot_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_class text not null references public.autopilot_action_classes(class_key),
  status text not null default 'active' check (status in ('active','paused','revoked')),
  constraints jsonb not null,
  version integer not null default 1 check (version >= 1),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paused_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 300),
  last_executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  check (expires_at > granted_at and expires_at <= granted_at + interval '90 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
-- One live (active or paused) rule per user per class.
create unique index autopilot_rules_one_live_per_class
  on public.autopilot_rules(user_id, action_class) where status <> 'revoked';
create index autopilot_rules_action_class_idx on public.autopilot_rules(action_class);

create table public.autopilot_executions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  rule_version integer not null,
  action_class text not null references public.autopilot_action_classes(class_key),
  action_id uuid references public.actions(id) on delete set null,
  status text not null default 'claimed' check (status in ('claimed','verified','failed','reverted')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  proposed_starts_at timestamptz,
  proposed_ends_at timestamptz,
  local_day date not null,
  external_ref text check (external_ref is null or char_length(external_ref) <= 500),
  failure_code text check (failure_code is null or char_length(failure_code) <= 120),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  reverted_at timestamptz,
  unique (user_id, idempotency_key),
  foreign key (user_id, rule_id) references public.autopilot_rules(user_id, id) on delete cascade
);
create index autopilot_executions_rule_day_idx on public.autopilot_executions(user_id, rule_id, local_day);
create index autopilot_executions_window_idx on public.autopilot_executions(user_id, proposed_starts_at, proposed_ends_at)
  where status in ('claimed','verified');
create index autopilot_executions_action_idx on public.autopilot_executions(action_id);
create index autopilot_executions_action_class_idx on public.autopilot_executions(action_class);

create table public.autopilot_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paused boolean not null default false,
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Entitlement helper + RLS (reads only; no client writes)
-- ---------------------------------------------------------------------------

create or replace function private.apm_has_autopilot_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.subscription_entitlements se
    where se.user_id = p_user_id
      and se.status in ('active','trialing')
      and se.plan = 'autopilot'
  );
$$;

alter table public.autopilot_action_classes enable row level security;
alter table public.autopilot_rules enable row level security;
alter table public.autopilot_executions enable row level security;
alter table public.autopilot_settings enable row level security;

revoke all on table public.autopilot_action_classes from anon;
revoke all on table public.autopilot_rules from anon;
revoke all on table public.autopilot_executions from anon;
revoke all on table public.autopilot_settings from anon;
revoke insert, update, delete, truncate, references, trigger on table public.autopilot_action_classes from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.autopilot_rules from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.autopilot_executions from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.autopilot_settings from authenticated;
grant select on table public.autopilot_action_classes to authenticated;
grant select on table public.autopilot_rules to authenticated;
grant select on table public.autopilot_executions to authenticated;
grant select on table public.autopilot_settings to authenticated;

-- The class catalogue is product metadata, not private data.
create policy autopilot_action_classes_read
  on public.autopilot_action_classes for select to authenticated
  using (true);

create policy autopilot_rules_select_autopilot
  on public.autopilot_rules for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_autopilot_access((select auth.uid())));

create policy autopilot_executions_select_autopilot
  on public.autopilot_executions for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_autopilot_access((select auth.uid())));

create policy autopilot_settings_select_autopilot
  on public.autopilot_settings for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_autopilot_access((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 3. Shared guards
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_require_owner()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'autopilot_unauthenticated' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function private.apm_autopilot_require_access()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
begin
  if not private.apm_has_autopilot_access(v_uid) then
    raise exception 'autopilot_required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function private.apm_autopilot_audit(
  p_user_id uuid,
  p_event_type text,
  p_object_type text,
  p_object_id uuid,
  p_metadata jsonb,
  p_actor_type text default 'user',
  p_actor_ref text default null
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, p_event_type, p_actor_type, p_actor_ref, p_object_type, p_object_id::text, coalesce(p_metadata, '{}'::jsonb));
$$;

create or replace function private.apm_autopilot_check_keys(p_payload jsonb, p_allowed text[], p_required text[], p_error text)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '%', p_error using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_payload) loop
    if not (v_key = any (p_allowed)) then
      raise exception '%', p_error using errcode = '22023';
    end if;
  end loop;
  foreach v_key in array p_required loop
    if not (p_payload ? v_key) or jsonb_typeof(p_payload->v_key) = 'null' then
      raise exception '%', p_error using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function private.apm_autopilot_int(p_value jsonb, p_min integer, p_max integer)
returns integer
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_num numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  v_num := (p_value #>> '{}')::numeric;
  if v_num <> trunc(v_num) or v_num < p_min or v_num > p_max then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  return v_num::integer;
end;
$$;

create or replace function private.apm_autopilot_hhmm(p_value jsonb)
returns time
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string'
     or (p_value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  return (p_value #>> '{}')::time;
end;
$$;

create or replace function private.apm_autopilot_timezone(p_value jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  v_tz := p_value #>> '{}';
  if char_length(v_tz) not between 1 and 120 then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end;
  return v_tz;
end;
$$;

-- Validates and normalises the constraint object for one action class. The
-- shapes are the whole contract; unknown keys are rejected.
create or replace function private.apm_autopilot_check_constraints(p_class text, p_constraints jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_weekdays jsonb;
  v_day jsonb;
  v_days integer[] := '{}';
  v_start time;
  v_end time;
  v_window_minutes integer;
  v_duration integer;
  v_domains jsonb;
  v_domain jsonb;
  v_domain_list text[] := '{}';
  v_tz text;
begin
  if p_class = 'calendar.create' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxDurationMinutes','maxPerDay','horizonDays','collision'],
      array['timezone','weekdays','windowStart','windowEnd','maxDurationMinutes','maxPerDay','horizonDays','collision'],
      'autopilot_invalid_constraints');
  elsif p_class = 'email.draft' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','allowedRecipientDomains'],
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','allowedRecipientDomains'],
      'autopilot_invalid_constraints');
  else
    raise exception 'autopilot_unsupported_action_class' using errcode = '22023';
  end if;

  v_tz := private.apm_autopilot_timezone(p_constraints->'timezone');

  v_weekdays := p_constraints->'weekdays';
  if jsonb_typeof(v_weekdays) <> 'array' or jsonb_array_length(v_weekdays) not between 1 and 7 then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  for v_day in select value from jsonb_array_elements(v_weekdays) loop
    v_days := v_days || private.apm_autopilot_int(v_day, 1, 7);
  end loop;
  if (select count(distinct d) from unnest(v_days) d) <> cardinality(v_days) then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;

  v_start := private.apm_autopilot_hhmm(p_constraints->'windowStart');
  v_end := private.apm_autopilot_hhmm(p_constraints->'windowEnd');
  if v_end <= v_start then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  v_window_minutes := (extract(epoch from (v_end - v_start)) / 60)::integer;

  if p_class = 'calendar.create' then
    v_duration := private.apm_autopilot_int(p_constraints->'maxDurationMinutes', 15, 240);
    if v_duration > v_window_minutes then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    if p_constraints->'collision' <> to_jsonb('never_overlap_busy'::text) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'timezone', v_tz,
      'weekdays', (select jsonb_agg(d order by d) from unnest(v_days) d),
      'windowStart', p_constraints->'windowStart',
      'windowEnd', p_constraints->'windowEnd',
      'maxDurationMinutes', v_duration,
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 10),
      'horizonDays', private.apm_autopilot_int(p_constraints->'horizonDays', 1, 30),
      'collision', 'never_overlap_busy'
    );
  end if;

  v_domains := p_constraints->'allowedRecipientDomains';
  if jsonb_typeof(v_domains) <> 'array' or jsonb_array_length(v_domains) not between 1 and 10 then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  for v_domain in select value from jsonb_array_elements(v_domains) loop
    if jsonb_typeof(v_domain) <> 'string'
       or char_length(v_domain #>> '{}') > 253
       or (v_domain #>> '{}') !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    v_domain_list := v_domain_list || (v_domain #>> '{}');
  end loop;
  return jsonb_build_object(
    'timezone', v_tz,
    'weekdays', (select jsonb_agg(d order by d) from unnest(v_days) d),
    'windowStart', p_constraints->'windowStart',
    'windowEnd', p_constraints->'windowEnd',
    'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 20),
    'allowedRecipientDomains', (select jsonb_agg(distinct d) from unnest(v_domain_list) d)
  );
end;
$$;

create or replace function private.apm_autopilot_check_expiry(p_expires_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_expires_at is null or p_expires_at <= now() + interval '1 hour' or p_expires_at > now() + interval '90 days' then
    raise exception 'autopilot_invalid_expiry' using errcode = '22023';
  end if;
  return p_expires_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Rule lifecycle
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_grant_rule(p_action_class text, p_constraints jsonb, p_expires_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_access();
  v_constraints jsonb;
  v_row public.autopilot_rules;
begin
  if not exists (select 1 from public.autopilot_action_classes c where c.class_key = p_action_class) then
    raise exception 'autopilot_unsupported_action_class' using errcode = '22023';
  end if;
  v_constraints := private.apm_autopilot_check_constraints(p_action_class, p_constraints);
  if exists (
    select 1 from public.autopilot_rules r
    where r.user_id = v_uid and r.action_class = p_action_class and r.status <> 'revoked'
  ) then
    raise exception 'autopilot_rule_exists' using errcode = '23505';
  end if;

  insert into public.autopilot_rules (user_id, action_class, status, constraints, version, granted_at, expires_at)
  values (v_uid, p_action_class, 'active', v_constraints, 1, now(), private.apm_autopilot_check_expiry(p_expires_at))
  returning * into v_row;

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.rule_granted', 'autopilot_rule', v_row.id,
    jsonb_build_object('actionClass', v_row.action_class, 'version', v_row.version, 'expiresAt', v_row.expires_at)
  );
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_autopilot_update_rule(
  p_id uuid,
  p_expected_version integer,
  p_constraints jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_access();
  v_row public.autopilot_rules;
  v_constraints jsonb;
begin
  select * into v_row from public.autopilot_rules r
  where r.id = p_id and r.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_rule_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'revoked' then
    raise exception 'autopilot_rule_revoked' using errcode = '22023';
  end if;
  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception 'autopilot_conflict' using errcode = '40001';
  end if;
  v_constraints := private.apm_autopilot_check_constraints(v_row.action_class, coalesce(p_constraints, v_row.constraints));

  -- A renewal re-grants from now, so the 90-day ceiling is measured from the
  -- latest explicit grant.
  update public.autopilot_rules r set
    constraints = v_constraints,
    granted_at = case when p_expires_at is not null then now() else r.granted_at end,
    expires_at = case when p_expires_at is not null then private.apm_autopilot_check_expiry(p_expires_at) else r.expires_at end,
    version = r.version + 1,
    updated_at = now()
  where r.id = p_id and r.user_id = v_uid
  returning r.* into v_row;

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.rule_updated', 'autopilot_rule', v_row.id,
    jsonb_build_object('actionClass', v_row.action_class, 'version', v_row.version, 'expiresAt', v_row.expires_at)
  );
  return to_jsonb(v_row);
end;
$$;

-- Pausing never needs an entitlement; resuming does (it restores authority).
create or replace function private.apm_autopilot_set_rule_status(p_id uuid, p_status text, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_row public.autopilot_rules;
begin
  if p_status not in ('active','paused') then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_status = 'active' then
    perform private.apm_autopilot_require_access();
  end if;
  select * into v_row from public.autopilot_rules r
  where r.id = p_id and r.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_rule_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'revoked' then
    raise exception 'autopilot_rule_revoked' using errcode = '22023';
  end if;
  if p_expected_version is null or v_row.version <> p_expected_version then
    raise exception 'autopilot_conflict' using errcode = '40001';
  end if;
  if p_status = 'active' and v_row.expires_at <= now() then
    raise exception 'autopilot_rule_expired' using errcode = '22023';
  end if;
  if v_row.status = p_status then
    return to_jsonb(v_row);
  end if;

  update public.autopilot_rules r set
    status = p_status,
    paused_at = case when p_status = 'paused' then now() else null end,
    version = r.version + 1,
    updated_at = now()
  where r.id = p_id and r.user_id = v_uid
  returning r.* into v_row;

  perform private.apm_autopilot_audit(
    v_uid, case when p_status = 'paused' then 'autopilot.rule_paused' else 'autopilot.rule_resumed' end,
    'autopilot_rule', v_row.id,
    jsonb_build_object('actionClass', v_row.action_class, 'version', v_row.version)
  );
  return to_jsonb(v_row);
end;
$$;

-- Revocation is terminal and owner-only (no entitlement, no version check: the
-- off switch must always work).
create or replace function private.apm_autopilot_revoke_rule(p_id uuid, p_reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_row public.autopilot_rules;
begin
  if p_reason is not null and char_length(p_reason) > 300 then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  select * into v_row from public.autopilot_rules r
  where r.id = p_id and r.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_rule_not_found' using errcode = 'P0002';
  end if;
  if v_row.status = 'revoked' then
    return to_jsonb(v_row);
  end if;

  update public.autopilot_rules r set
    status = 'revoked',
    revoked_at = now(),
    revoke_reason = p_reason,
    paused_at = null,
    version = r.version + 1,
    updated_at = now()
  where r.id = p_id and r.user_id = v_uid
  returning r.* into v_row;

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.rule_revoked', 'autopilot_rule', v_row.id,
    jsonb_build_object('actionClass', v_row.action_class, 'version', v_row.version)
  );
  return to_jsonb(v_row);
end;
$$;

-- Master pause: pausing is owner-only; un-pausing needs the entitlement.
create or replace function private.apm_autopilot_set_master_pause(p_paused boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_row public.autopilot_settings;
begin
  if p_paused is null then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if not p_paused then
    perform private.apm_autopilot_require_access();
  end if;
  insert into public.autopilot_settings as s (user_id, paused, paused_at, updated_at)
  values (v_uid, p_paused, case when p_paused then now() else null end, now())
  on conflict (user_id) do update set
    paused = excluded.paused,
    paused_at = case when excluded.paused then coalesce(s.paused_at, now()) else null end,
    updated_at = now()
  returning s.* into v_row;

  perform private.apm_autopilot_audit(
    v_uid, case when p_paused then 'autopilot.paused' else 'autopilot.resumed' end,
    'autopilot_settings', v_uid, '{}'::jsonb
  );
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Standing execution: claim -> (Worker executes connector) -> record result
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_claim(
  p_rule_id uuid,
  p_idempotency_key text,
  p_payload jsonb,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_access();
  v_rule public.autopilot_rules;
  v_class public.autopilot_action_classes;
  v_permission_id uuid;
  v_existing public.autopilot_executions;
  v_existing_action public.actions;
  v_c jsonb;
  v_tz text;
  v_conn uuid;
  v_starts timestamptz;
  v_ends timestamptz;
  v_local_start timestamp;
  v_local_end timestamp;
  v_local_day date;
  v_to text;
  v_action public.actions;
  v_exec public.autopilot_executions;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_reason is null or char_length(p_reason) not between 3 and 1000 then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;

  -- Serialise claims on one rule so rate and collision checks see each other.
  select * into v_rule from public.autopilot_rules r
  where r.id = p_rule_id and r.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_rule_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent replay: the same key on the same rule with the same payload
  -- returns the original execution and never runs twice.
  select * into v_existing from public.autopilot_executions e
  where e.user_id = v_uid and e.idempotency_key = p_idempotency_key;
  if found then
    select * into v_existing_action from public.actions a where a.id = v_existing.action_id;
    if v_existing.rule_id <> p_rule_id or v_existing_action.id is null or v_existing_action.payload <> p_payload then
      raise exception 'autopilot_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('replayed', true, 'execution', to_jsonb(v_existing), 'action', to_jsonb(v_existing_action));
  end if;
  if exists (select 1 from public.actions a where a.user_id = v_uid and a.idempotency_key = 'autopilot:' || p_idempotency_key) then
    raise exception 'autopilot_idempotency_conflict' using errcode = '23505';
  end if;

  if coalesce((select s.paused from public.autopilot_settings s where s.user_id = v_uid), false) then
    raise exception 'autopilot_paused' using errcode = '42501';
  end if;
  if v_rule.status <> 'active' then
    raise exception 'autopilot_rule_inactive' using errcode = '42501';
  end if;
  if v_rule.expires_at <= now() then
    raise exception 'autopilot_rule_expired' using errcode = '42501';
  end if;

  select * into v_class from public.autopilot_action_classes c where c.class_key = v_rule.action_class;
  if v_class.activation_status <> 'active' then
    raise exception 'autopilot_class_not_activated' using errcode = '42501';
  end if;

  select p.id into v_permission_id from public.permissions p
  where p.user_id = v_uid and p.domain = v_class.domain and p.action_type = v_class.action_type
    and p.enabled and p.autonomy_level = 5;
  if v_permission_id is null then
    raise exception 'autopilot_permission_required' using errcode = '42501';
  end if;

  v_c := v_rule.constraints;
  v_tz := v_c->>'timezone';

  if v_class.class_key = 'calendar.create' then
    perform private.apm_autopilot_check_keys(p_payload,
      array['connectionId','title','startsAt','endsAt','location'],
      array['connectionId','title','startsAt','endsAt'],
      'autopilot_invalid_payload');
    if jsonb_typeof(p_payload->'title') <> 'string' or char_length(btrim(p_payload->>'title')) not between 1 and 200
       or (p_payload ? 'location' and (jsonb_typeof(p_payload->'location') <> 'string' or char_length(p_payload->>'location') > 300)) then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    begin
      v_conn := (p_payload->>'connectionId')::uuid;
      v_starts := (p_payload->>'startsAt')::timestamptz;
      v_ends := (p_payload->>'endsAt')::timestamptz;
    exception when others then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end;
    if v_ends <= v_starts then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    if v_ends - v_starts > make_interval(mins => (v_c->>'maxDurationMinutes')::integer) then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    if v_starts <= now() or v_starts > now() + make_interval(days => (v_c->>'horizonDays')::integer) then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    v_local_start := v_starts at time zone v_tz;
    v_local_end := v_ends at time zone v_tz;
    v_local_day := v_local_start::date;
    if v_local_end::date <> v_local_day
       or not (extract(isodow from v_local_start)::integer in (select (jsonb_array_elements_text(v_c->'weekdays'))::integer))
       or v_local_start::time < (v_c->>'windowStart')::time
       or v_local_end::time > (v_c->>'windowEnd')::time then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    -- Collision rule: never overlap an existing busy/tentative/out-of-office
    -- event or another Autopilot block.
    if exists (
      select 1 from public.calendar_events ce
      where ce.user_id = v_uid and not ce.deleted and ce.availability <> 'free'
        and ce.starts_at < v_ends and ce.ends_at > v_starts
    ) or exists (
      select 1 from public.autopilot_executions e
      where e.user_id = v_uid and e.status in ('claimed','verified')
        and e.proposed_starts_at < v_ends and e.proposed_ends_at > v_starts
    ) then
      raise exception 'autopilot_collision' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.integration_connections ic
      where ic.id = v_conn and ic.user_id = v_uid and ic.kind = 'calendar'
        and ic.provider in ('google','microsoft') and ic.status = 'connected'
    ) then
      raise exception 'autopilot_connection_not_found' using errcode = 'P0002';
    end if;
  else
    perform private.apm_autopilot_check_keys(p_payload,
      array['connectionId','to','subject','body'],
      array['connectionId','to','subject','body'],
      'autopilot_invalid_payload');
    if jsonb_typeof(p_payload->'to') <> 'string' or jsonb_typeof(p_payload->'subject') <> 'string'
       or jsonb_typeof(p_payload->'body') <> 'string'
       or char_length(btrim(p_payload->>'subject')) not between 1 and 300
       or char_length(p_payload->>'body') > 10000
       or char_length(p_payload->>'to') > 320
       or (p_payload->>'to') !~ '^[^@\s,;<>]+@[^@\s,;<>]+$' then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    begin
      v_conn := (p_payload->>'connectionId')::uuid;
    exception when others then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end;
    v_to := lower(split_part(p_payload->>'to', '@', 2));
    if not (v_c->'allowedRecipientDomains' ? v_to) then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    v_local_start := now() at time zone v_tz;
    v_local_day := v_local_start::date;
    if not (extract(isodow from v_local_start)::integer in (select (jsonb_array_elements_text(v_c->'weekdays'))::integer))
       or v_local_start::time < (v_c->>'windowStart')::time
       or date_trunc('minute', v_local_start)::time > (v_c->>'windowEnd')::time then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.integration_connections ic
      where ic.id = v_conn and ic.user_id = v_uid and ic.kind = 'email'
        and ic.provider in ('google','microsoft') and ic.status = 'connected'
    ) then
      raise exception 'autopilot_connection_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- Rate rule: failed attempts do not count; claimed, verified and reverted do.
  if (
    select count(*) from public.autopilot_executions e
    where e.user_id = v_uid and e.rule_id = v_rule.id and e.local_day = v_local_day
      and e.status in ('claimed','verified','reverted')
  ) >= (v_c->>'maxPerDay')::integer then
    raise exception 'autopilot_rate_limited' using errcode = '42501';
  end if;

  insert into public.actions (
    user_id, domain, action_type, status, payload, reason, permission_id,
    idempotency_key, requires_approval, approved_at, updated_at
  ) values (
    v_uid, v_class.domain, v_class.action_type, 'executing', p_payload, p_reason, v_permission_id,
    'autopilot:' || p_idempotency_key, false, now(), now()
  ) returning * into v_action;

  insert into public.autopilot_executions (
    user_id, rule_id, rule_version, action_class, action_id, status, idempotency_key,
    proposed_starts_at, proposed_ends_at, local_day
  ) values (
    v_uid, v_rule.id, v_rule.version, v_class.class_key, v_action.id, 'claimed', p_idempotency_key,
    v_starts, v_ends, v_local_day
  ) returning * into v_exec;

  update public.autopilot_rules r set last_executed_at = now() where r.id = v_rule.id;

  -- Metadata is structural only: no titles, recipients, subjects or bodies.
  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.execution_claimed', 'autopilot_execution', v_exec.id,
    jsonb_build_object('actionClass', v_class.class_key, 'ruleId', v_rule.id, 'ruleVersion', v_rule.version, 'actionId', v_action.id),
    'system', 'autopilot_rule:' || v_rule.id::text
  );
  return jsonb_build_object('replayed', false, 'execution', to_jsonb(v_exec), 'action', to_jsonb(v_action));
end;
$$;

create or replace function private.apm_autopilot_record_result(
  p_execution_id uuid,
  p_outcome text,
  p_external_ref text default null,
  p_failure_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_exec public.autopilot_executions;
begin
  if p_outcome not in ('verified','failed') then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_outcome = 'verified' and (p_external_ref is null or char_length(p_external_ref) not between 1 and 500) then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_outcome = 'failed' and (p_failure_code is null or p_failure_code !~ '^[A-Za-z0-9_:.-]{1,120}$') then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;

  select * into v_exec from public.autopilot_executions e
  where e.id = p_execution_id and e.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_execution_not_found' using errcode = 'P0002';
  end if;
  if v_exec.status <> 'claimed' or v_exec.action_id is null then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;

  update public.autopilot_executions e set
    status = p_outcome,
    external_ref = case when p_outcome = 'verified' then p_external_ref else null end,
    failure_code = case when p_outcome = 'failed' then p_failure_code else null end,
    completed_at = now()
  where e.id = v_exec.id
  returning e.* into v_exec;

  update public.actions a set
    status = p_outcome,
    executed_at = case when p_outcome = 'verified' then now() else a.executed_at end,
    verified_at = case when p_outcome = 'verified' then now() else null end,
    failure_code = case when p_outcome = 'failed' then p_failure_code else null end,
    updated_at = now()
  where a.id = v_exec.action_id and a.user_id = v_uid;

  insert into public.action_attempts (user_id, action_id, attempt, status, external_ref, error_code, completed_at)
  values (
    v_uid, v_exec.action_id,
    coalesce((select max(aa.attempt) from public.action_attempts aa where aa.action_id = v_exec.action_id), 0) + 1,
    case when p_outcome = 'verified' then 'succeeded' else 'failed' end,
    case when p_outcome = 'verified' then p_external_ref else null end,
    case when p_outcome = 'failed' then p_failure_code else null end,
    now()
  );

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.execution_' || p_outcome, 'autopilot_execution', v_exec.id,
    jsonb_build_object('actionClass', v_exec.action_class, 'ruleId', v_exec.rule_id, 'actionId', v_exec.action_id,
      'failureCode', case when p_outcome = 'failed' then p_failure_code else null end),
    'system', 'autopilot_rule:' || v_exec.rule_id::text
  );
  return to_jsonb(v_exec);
end;
$$;

-- Undo is owner-only (works after downgrade) and only for verified executions
-- of a reversible class. The Worker reads the target, reverts at the provider,
-- then records the reversal.
create or replace function private.apm_autopilot_undo_target(p_execution_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_exec public.autopilot_executions;
  v_class public.autopilot_action_classes;
  v_action public.actions;
begin
  select * into v_exec from public.autopilot_executions e where e.id = p_execution_id and e.user_id = v_uid;
  if not found then
    raise exception 'autopilot_execution_not_found' using errcode = 'P0002';
  end if;
  select * into v_class from public.autopilot_action_classes c where c.class_key = v_exec.action_class;
  if v_exec.status <> 'verified' or not v_class.reversible or v_exec.action_id is null then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;
  select * into v_action from public.actions a where a.id = v_exec.action_id and a.user_id = v_uid;
  if not found then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'executionId', v_exec.id,
    'actionClass', v_class.class_key,
    'domain', v_class.domain,
    'undoMethod', v_class.undo_method,
    'externalRef', v_exec.external_ref,
    'connectionId', v_action.payload->>'connectionId'
  );
end;
$$;

create or replace function private.apm_autopilot_record_undo(p_execution_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_exec public.autopilot_executions;
begin
  select * into v_exec from public.autopilot_executions e
  where e.id = p_execution_id and e.user_id = v_uid
  for update;
  if not found then
    raise exception 'autopilot_execution_not_found' using errcode = 'P0002';
  end if;
  if v_exec.status = 'reverted' then
    return to_jsonb(v_exec);
  end if;
  if v_exec.status <> 'verified' then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;

  update public.autopilot_executions e set status = 'reverted', reverted_at = now()
  where e.id = v_exec.id
  returning e.* into v_exec;
  update public.actions a set status = 'cancelled', updated_at = now()
  where a.id = v_exec.action_id and a.user_id = v_uid;

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.execution_reverted', 'autopilot_execution', v_exec.id,
    jsonb_build_object('actionClass', v_exec.action_class, 'ruleId', v_exec.rule_id, 'actionId', v_exec.action_id)
  );
  return to_jsonb(v_exec);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Data-rights read path (owner-only, no entitlement)
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_data_rights_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
begin
  return jsonb_build_object(
    'autopilot_rules', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at, r.id)
      from public.autopilot_rules r where r.user_id = v_uid
    ), '[]'::jsonb),
    'autopilot_executions', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.claimed_at, e.id)
      from public.autopilot_executions e where e.user_id = v_uid
    ), '[]'::jsonb),
    'autopilot_settings', (
      select to_jsonb(s) from public.autopilot_settings s where s.user_id = v_uid
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Public RPC surface (SECURITY INVOKER wrappers)
-- ---------------------------------------------------------------------------

create or replace function public.apm_autopilot_grant_rule(p_action_class text, p_constraints jsonb, p_expires_at timestamptz)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_grant_rule(p_action_class, p_constraints, p_expires_at); $$;

create or replace function public.apm_autopilot_update_rule(p_id uuid, p_expected_version integer, p_constraints jsonb default null, p_expires_at timestamptz default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_update_rule(p_id, p_expected_version, p_constraints, p_expires_at); $$;

create or replace function public.apm_autopilot_set_rule_status(p_id uuid, p_status text, p_expected_version integer)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_set_rule_status(p_id, p_status, p_expected_version); $$;

create or replace function public.apm_autopilot_revoke_rule(p_id uuid, p_reason text default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_revoke_rule(p_id, p_reason); $$;

create or replace function public.apm_autopilot_set_master_pause(p_paused boolean)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_set_master_pause(p_paused); $$;

create or replace function public.apm_autopilot_claim(p_rule_id uuid, p_idempotency_key text, p_payload jsonb, p_reason text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_claim(p_rule_id, p_idempotency_key, p_payload, p_reason); $$;

create or replace function public.apm_autopilot_record_result(p_execution_id uuid, p_outcome text, p_external_ref text default null, p_failure_code text default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_record_result(p_execution_id, p_outcome, p_external_ref, p_failure_code); $$;

create or replace function public.apm_autopilot_undo_target(p_execution_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_autopilot_undo_target(p_execution_id); $$;

create or replace function public.apm_autopilot_record_undo(p_execution_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_record_undo(p_execution_id); $$;

create or replace function public.apm_autopilot_data_rights_export()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_autopilot_data_rights_export(); $$;

-- ---------------------------------------------------------------------------
-- 8. Execute grants: authenticated only, never anon/public
-- ---------------------------------------------------------------------------

-- Internal helpers: callable only from the definer bodies.
revoke all on function private.apm_autopilot_audit(uuid, text, text, uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_keys(jsonb, text[], text[], text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_int(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.apm_autopilot_hhmm(jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_timezone(jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_constraints(text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_expiry(timestamptz) from public, anon, authenticated;
revoke all on function private.apm_autopilot_require_owner() from public, anon, authenticated;
revoke all on function private.apm_autopilot_require_access() from public, anon, authenticated;

-- RLS helper: evaluated as the caller inside policies.
revoke all on function private.apm_has_autopilot_access(uuid) from public, anon;
grant execute on function private.apm_has_autopilot_access(uuid) to authenticated;

revoke all on function private.apm_autopilot_grant_rule(text, jsonb, timestamptz) from public, anon;
revoke all on function private.apm_autopilot_update_rule(uuid, integer, jsonb, timestamptz) from public, anon;
revoke all on function private.apm_autopilot_set_rule_status(uuid, text, integer) from public, anon;
revoke all on function private.apm_autopilot_revoke_rule(uuid, text) from public, anon;
revoke all on function private.apm_autopilot_set_master_pause(boolean) from public, anon;
revoke all on function private.apm_autopilot_claim(uuid, text, jsonb, text) from public, anon;
revoke all on function private.apm_autopilot_record_result(uuid, text, text, text) from public, anon;
revoke all on function private.apm_autopilot_undo_target(uuid) from public, anon;
revoke all on function private.apm_autopilot_record_undo(uuid) from public, anon;
revoke all on function private.apm_autopilot_data_rights_export() from public, anon;

grant execute on function private.apm_autopilot_grant_rule(text, jsonb, timestamptz) to authenticated;
grant execute on function private.apm_autopilot_update_rule(uuid, integer, jsonb, timestamptz) to authenticated;
grant execute on function private.apm_autopilot_set_rule_status(uuid, text, integer) to authenticated;
grant execute on function private.apm_autopilot_revoke_rule(uuid, text) to authenticated;
grant execute on function private.apm_autopilot_set_master_pause(boolean) to authenticated;
grant execute on function private.apm_autopilot_claim(uuid, text, jsonb, text) to authenticated;
grant execute on function private.apm_autopilot_record_result(uuid, text, text, text) to authenticated;
grant execute on function private.apm_autopilot_undo_target(uuid) to authenticated;
grant execute on function private.apm_autopilot_record_undo(uuid) to authenticated;
grant execute on function private.apm_autopilot_data_rights_export() to authenticated;

revoke all on function public.apm_autopilot_grant_rule(text, jsonb, timestamptz) from public, anon;
revoke all on function public.apm_autopilot_update_rule(uuid, integer, jsonb, timestamptz) from public, anon;
revoke all on function public.apm_autopilot_set_rule_status(uuid, text, integer) from public, anon;
revoke all on function public.apm_autopilot_revoke_rule(uuid, text) from public, anon;
revoke all on function public.apm_autopilot_set_master_pause(boolean) from public, anon;
revoke all on function public.apm_autopilot_claim(uuid, text, jsonb, text) from public, anon;
revoke all on function public.apm_autopilot_record_result(uuid, text, text, text) from public, anon;
revoke all on function public.apm_autopilot_undo_target(uuid) from public, anon;
revoke all on function public.apm_autopilot_record_undo(uuid) from public, anon;
revoke all on function public.apm_autopilot_data_rights_export() from public, anon;

grant execute on function public.apm_autopilot_grant_rule(text, jsonb, timestamptz) to authenticated;
grant execute on function public.apm_autopilot_update_rule(uuid, integer, jsonb, timestamptz) to authenticated;
grant execute on function public.apm_autopilot_set_rule_status(uuid, text, integer) to authenticated;
grant execute on function public.apm_autopilot_revoke_rule(uuid, text) to authenticated;
grant execute on function public.apm_autopilot_set_master_pause(boolean) to authenticated;
grant execute on function public.apm_autopilot_claim(uuid, text, jsonb, text) to authenticated;
grant execute on function public.apm_autopilot_record_result(uuid, text, text, text) to authenticated;
grant execute on function public.apm_autopilot_undo_target(uuid) to authenticated;
grant execute on function public.apm_autopilot_record_undo(uuid) to authenticated;
grant execute on function public.apm_autopilot_data_rights_export() to authenticated;
