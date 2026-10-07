-- Phase C hardening (self security review of 8468775; the Codex review could
-- not run: usage limit).
--
-- Email-draft header injection. The Worker builds the Gmail draft as raw MIME
-- (`Subject: <subject>\r\n…`), so a subject carrying CR/LF could add Cc/Bcc
-- headers with recipients outside the rule's allowedRecipientDomains. The claim
-- now rejects any control character in the subject (the API's zod schema does
-- the same). Only private.apm_autopilot_claim changes; its signature, grants and
-- public wrapper are unchanged, so CREATE OR REPLACE keeps the existing ACL.

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
       -- The subject becomes a MIME header: CR/LF or any other control
       -- character could inject Cc/Bcc recipients past the allowed domains.
       or (p_payload->>'subject') ~ '[[:cntrl:]]'
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

-- Re-assert the ACL explicitly (CREATE OR REPLACE preserves it; this keeps the
-- migration self-evidently safe).
revoke all on function private.apm_autopilot_claim(uuid, text, jsonb, text) from public, anon;
grant execute on function private.apm_autopilot_claim(uuid, text, jsonb, text) to authenticated;
