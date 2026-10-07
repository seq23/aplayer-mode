-- 0065: multiple connected calendars and inboxes (owner decision, 7 Oct 2026).
--
-- Autopilot = everything in Executive Suite + standing rules + MULTIPLE connected
-- calendars and inboxes (work and personal at once). Every other plan gets ONE cloud
-- calendar and ONE inbox. The limit lives HERE, not only in the app:
--
--  A. integration_connections gains a user-chosen label ("Work", "Personal"), a primary
--     flag (one per kind) and a pause (paused_at/paused_reason). Existing rows stay valid:
--     the oldest live account of each kind becomes primary.
--  B. A BEFORE trigger refuses to make a second account of a kind live (insert, reconnect,
--     un-pause) unless the user holds the 'multi_account' capability: an active or
--     trialing Autopilot entitlement (packages/policy productPlanPolicies.autopilot,
--     pinned by test/multi-account-db.test.mjs). Device calendars (the phone's own
--     aggregate) are not cloud accounts and are never counted.
--  C. Downgrade never deletes: a trigger on subscription_entitlements pauses every live
--     account that is not the primary (no sync, no actions), audited. The user reactivates
--     after upgrading, or picks a different primary on any plan. Disconnecting always
--     works, on every plan.
--  D. A paused (or, without the capability, non-primary) account cannot receive synced
--     rows, cannot be named by an Autopilot claim, and cannot be claimed by an approved
--     action. Undo is not blocked: reversing what APM did is always allowed.
--  E. Calendar rows are keyed per account, so one invitation on both the work and the
--     personal calendar is two rows, never one row that flips between accounts. The
--     collision check (private.apm_autopilot_slot_busy) already spans every calendar.
--  F. Every Autopilot rule names the account it acts on (default: the primary of its
--     kind), every execution records it, and a claim on any other account is refused.

-- ---------------------------------------------------------------- A. columns
alter table public.integration_connections
  add column if not exists label text,
  add column if not exists is_primary boolean not null default false,
  add column if not exists paused_at timestamptz,
  add column if not exists paused_reason text;
alter table public.integration_connections
  add constraint integration_connections_label_check
    check (label is null or (char_length(btrim(label)) between 1 and 40 and label !~ '[[:cntrl:]]')),
  add constraint integration_connections_paused_reason_check
    check ((paused_at is null) = (paused_reason is null) and (paused_reason is null or paused_reason in ('plan'))),
  add constraint integration_connections_primary_live_check
    check (not is_primary or (paused_at is null and status <> 'disconnected'));
create unique index integration_connections_one_primary_per_kind
  on public.integration_connections(user_id, kind) where is_primary;

-- ---------------------------------------------------------------- helpers
-- Mirrors the 'multi_account' capability (packages/policy): Autopilot, active or trialing.
create or replace function private.apm_has_multi_account_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscription_entitlements se
     where se.user_id = p_user_id and se.status in ('active','trialing') and se.plan = 'autopilot'
  );
$$;

-- A live account: not disconnected, not paused.
create or replace function private.apm_connection_live(p_row public.integration_connections)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_row.status <> 'disconnected' and p_row.paused_at is null; $$;

-- May this account sync or act right now? Live, and either the primary, a device
-- calendar, or the user holds the multi-account capability (so a missed downgrade
-- reconcile can never leave an extra account working).
create or replace function private.apm_connection_usable(p_user_id uuid, p_connection_id uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.integration_connections ic
     where ic.id = p_connection_id and ic.user_id = p_user_id
       and (p_kind is null or ic.kind = p_kind)
       and ic.status <> 'disconnected' and ic.paused_at is null
       and (ic.is_primary or ic.provider = 'device' or private.apm_has_multi_account_access(p_user_id))
  );
$$;

create or replace function private.apm_connection_audit(p_user_id uuid, p_event text, p_connection_id uuid, p_metadata jsonb, p_actor text default 'user')
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (p_user_id, p_event, p_actor, case when p_actor = 'system' then 'plan_limit' else 'user' end,
          'integration_connection', p_connection_id::text, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------- B. the limit
create or replace function private.apm_integration_connections_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activating boolean;
  v_others integer;
begin
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.kind is distinct from old.kind
       or new.provider is distinct from old.provider or new.external_account_id is distinct from old.external_account_id) then
    raise exception 'connection_immutable' using errcode = '42501';
  end if;
  -- A paused or disconnected account is never primary.
  if new.status = 'disconnected' or new.paused_at is not null then new.is_primary := false; end if;
  if new.paused_at is null then new.paused_reason := null; end if;
  if new.provider = 'device' then return new; end if;

  if tg_op = 'INSERT' then
    -- An upsert of an account that already exists becomes an UPDATE of that row,
    -- which this trigger checks on its own; the proposed insert row is not a new account.
    if exists (select 1 from public.integration_connections ic
                where ic.user_id = new.user_id and ic.provider = new.provider and ic.kind = new.kind
                  and ic.external_account_id is not distinct from new.external_account_id) then
      return new;
    end if;
    v_activating := private.apm_connection_live(new);
  else
    v_activating := private.apm_connection_live(new) and not private.apm_connection_live(old);
  end if;
  if not v_activating then return new; end if;

  -- Serialise activations per user and kind so two concurrent connects cannot both pass.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text || ':' || new.kind, 65));
  select count(*) into v_others from public.integration_connections ic
   where ic.user_id = new.user_id and ic.kind = new.kind and ic.id <> new.id and ic.provider <> 'device'
     and ic.status <> 'disconnected' and ic.paused_at is null;
  if v_others > 0 and not private.apm_has_multi_account_access(new.user_id) then
    raise exception 'connection_multi_account_requires_autopilot' using errcode = '42501',
      hint = 'A second connected calendar or inbox is part of Autopilot.';
  end if;
  if v_others = 0 then new.is_primary := true; end if;
  return new;
end;
$$;
revoke all on function private.apm_integration_connections_guard() from public, anon, authenticated;
create trigger integration_connections_guard before insert or update on public.integration_connections
  for each row execute function private.apm_integration_connections_guard();

-- ---------------------------------------------------------------- C. reconcile (downgrade)
-- Every live kind has exactly one primary; without the capability every other live
-- account is paused (never deleted). Returns the number of accounts paused.
create or replace function private.apm_connections_reconcile(p_user_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_primary uuid;
  v_paused integer := 0;
  v_id uuid;
begin
  foreach v_kind in array array['calendar','email'] loop
    select ic.id into v_primary from public.integration_connections ic
     where ic.user_id = p_user_id and ic.kind = v_kind and ic.is_primary;
    if v_primary is null then
      select ic.id into v_primary from public.integration_connections ic
       where ic.user_id = p_user_id and ic.kind = v_kind and ic.provider <> 'device'
         and ic.status <> 'disconnected' and ic.paused_at is null
       order by ic.created_at, ic.id limit 1;
      if v_primary is not null then
        update public.integration_connections set is_primary = true, updated_at = now() where id = v_primary;
      end if;
    end if;
    if not private.apm_has_multi_account_access(p_user_id) then
      for v_id in
        update public.integration_connections ic
           set paused_at = now(), paused_reason = 'plan', is_primary = false, updated_at = now()
         where ic.user_id = p_user_id and ic.kind = v_kind and ic.provider <> 'device'
           and ic.status <> 'disconnected' and ic.paused_at is null and ic.id is distinct from v_primary
        returning ic.id
      loop
        v_paused := v_paused + 1;
        perform private.apm_connection_audit(p_user_id, 'connection.paused', v_id, jsonb_build_object('kind', v_kind, 'reason', 'plan'), 'system');
      end loop;
    end if;
  end loop;
  return v_paused;
end;
$$;
revoke all on function private.apm_connections_reconcile(uuid) from public, anon, authenticated;

create or replace function private.apm_entitlement_reconcile_connections()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.apm_connections_reconcile(new.user_id);
  return null;
end;
$$;
revoke all on function private.apm_entitlement_reconcile_connections() from public, anon, authenticated;
create trigger subscription_entitlements_reconcile_connections
  after insert or update of plan, status on public.subscription_entitlements
  for each row execute function private.apm_entitlement_reconcile_connections();

-- ---------------------------------------------------------------- user RPCs
create or replace function private.apm_connection_require_own(p_connection_id uuid)
returns public.integration_connections
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_row public.integration_connections;
begin
  if auth.uid() is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  select * into v_row from public.integration_connections ic where ic.id = p_connection_id and ic.user_id = auth.uid();
  if v_row.id is null then raise exception 'connection_not_found' using errcode = 'P0002'; end if;
  return v_row;
end;
$$;

create or replace function private.apm_connection_set_label(p_connection_id uuid, p_label text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.integration_connections := private.apm_connection_require_own(p_connection_id);
begin
  if p_label is not null and (char_length(btrim(p_label)) not between 1 and 40 or p_label ~ '[[:cntrl:]]') then
    raise exception 'connection_invalid_label' using errcode = '22023';
  end if;
  update public.integration_connections set label = nullif(btrim(p_label), ''), updated_at = now() where id = v_row.id returning * into v_row;
  perform private.apm_connection_audit(v_row.user_id, 'connection.label_changed', v_row.id, jsonb_build_object('kind', v_row.kind));
  return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor';
end;
$$;

-- On any plan the user chooses which account stays live: without the capability the
-- previous primary is paused in the same transaction (one live account, always).
create or replace function private.apm_connection_set_primary(p_connection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.integration_connections := private.apm_connection_require_own(p_connection_id);
  v_old public.integration_connections;
  v_multi boolean := private.apm_has_multi_account_access(v_row.user_id);
begin
  if v_row.status = 'disconnected' or v_row.provider = 'device' then raise exception 'connection_not_found' using errcode = 'P0002'; end if;
  if v_row.is_primary then return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor'; end if;
  select * into v_old from public.integration_connections ic where ic.user_id = v_row.user_id and ic.kind = v_row.kind and ic.is_primary;
  if v_old.id is not null then
    if v_multi then
      update public.integration_connections set is_primary = false, updated_at = now() where id = v_old.id;
    else
      update public.integration_connections set paused_at = now(), paused_reason = 'plan', updated_at = now() where id = v_old.id;
      perform private.apm_connection_audit(v_row.user_id, 'connection.paused', v_old.id, jsonb_build_object('kind', v_row.kind, 'reason', 'plan'));
    end if;
  end if;
  -- Without the capability, every other live account of the kind is paused too.
  if not v_multi then
    update public.integration_connections ic set paused_at = now(), paused_reason = 'plan', updated_at = now()
     where ic.user_id = v_row.user_id and ic.kind = v_row.kind and ic.id <> v_row.id and ic.provider <> 'device'
       and ic.status <> 'disconnected' and ic.paused_at is null;
  end if;
  update public.integration_connections set paused_at = null, is_primary = true, updated_at = now() where id = v_row.id returning * into v_row;
  perform private.apm_connection_audit(v_row.user_id, 'connection.primary_changed', v_row.id, jsonb_build_object('kind', v_row.kind, 'previous', v_old.id));
  return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor';
end;
$$;

-- Reactivating a paused extra is the same activation the guard checks: Autopilot only.
create or replace function private.apm_connection_reactivate(p_connection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.integration_connections := private.apm_connection_require_own(p_connection_id);
begin
  if v_row.status = 'disconnected' then raise exception 'connection_not_found' using errcode = 'P0002'; end if;
  if v_row.paused_at is null then return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor'; end if;
  update public.integration_connections set paused_at = null, updated_at = now() where id = v_row.id returning * into v_row;
  perform private.apm_connection_audit(v_row.user_id, 'connection.reactivated', v_row.id, jsonb_build_object('kind', v_row.kind));
  return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor';
end;
$$;

-- Disconnecting always works, on every plan, paused or not: the credentials are
-- destroyed and the account's synced rows are removed. Another live account of the
-- kind becomes primary; a paused one is never woken without the user.
create or replace function private.apm_connection_disconnect(p_connection_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_row public.integration_connections := private.apm_connection_require_own(p_connection_id);
begin
  update public.integration_connections
     set status = 'disconnected', encrypted_credentials = null, credential_iv = null, sync_cursor = null,
         paused_at = null, is_primary = false, updated_at = now()
   where id = v_row.id returning * into v_row;
  delete from public.calendar_events ce where ce.user_id = v_row.user_id and ce.connection_id = v_row.id;
  delete from public.message_signals ms where ms.user_id = v_row.user_id and ms.connection_id = v_row.id;
  perform private.apm_connection_audit(v_row.user_id, 'connection.disconnected', v_row.id, jsonb_build_object('kind', v_row.kind, 'provider', v_row.provider));
  perform private.apm_connections_reconcile(v_row.user_id);
  return to_jsonb(v_row) - 'encrypted_credentials' - 'credential_iv' - 'sync_cursor';
end;
$$;

create or replace function public.apm_connection_set_label(p_connection_id uuid, p_label text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_connection_set_label(p_connection_id, p_label); $$;
create or replace function public.apm_connection_set_primary(p_connection_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_connection_set_primary(p_connection_id); $$;
create or replace function public.apm_connection_reactivate(p_connection_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_connection_reactivate(p_connection_id); $$;
create or replace function public.apm_connection_disconnect(p_connection_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_connection_disconnect(p_connection_id); $$;

do $$
declare f text;
begin
  foreach f in array array['apm_connection_set_label(uuid, text)', 'apm_connection_set_primary(uuid)',
                           'apm_connection_reactivate(uuid)', 'apm_connection_disconnect(uuid)'] loop
    execute 'revoke all on function private.' || f || ' from public, anon';
    execute 'grant execute on function private.' || f || ' to authenticated';
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
  foreach f in array array['apm_connection_require_own(uuid)', 'apm_connection_audit(uuid, text, uuid, jsonb, text)',
                           'apm_connection_usable(uuid, uuid, text)', 'apm_has_multi_account_access(uuid)'] loop
    execute 'revoke all on function private.' || f || ' from public, anon';
    execute 'grant execute on function private.' || f || ' to authenticated, service_role';
  end loop;
  execute 'revoke all on function private.apm_connection_live(public.integration_connections) from public, anon';
  execute 'grant execute on function private.apm_connection_live(public.integration_connections) to authenticated, service_role';
end $$;

-- ---------------------------------------------------------------- D. paused accounts do nothing
-- Synced rows: only a usable account may write calendar events or email signals.
create or replace function private.apm_connector_rows_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.connection_id is not null
     and not private.apm_connection_usable(new.user_id, new.connection_id, case tg_table_name when 'calendar_events' then 'calendar' else 'email' end) then
    raise exception 'connection_paused' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.apm_connector_rows_guard() from public, anon, authenticated;
create trigger calendar_events_connection_guard before insert or update of connection_id on public.calendar_events
  for each row execute function private.apm_connector_rows_guard();
create trigger message_signals_connection_guard before insert or update of connection_id on public.message_signals
  for each row execute function private.apm_connector_rows_guard();

-- Autopilot claims name only a usable account (adds the pause to the 0033 check).
create or replace function private.apm_autopilot_require_connection(p_user_id uuid, p_connection jsonb, p_class text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conn uuid;
  v_class public.autopilot_action_classes;
  v_ic public.integration_connections;
begin
  begin
    v_conn := (p_connection #>> '{}')::uuid;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  select * into v_class from public.autopilot_action_classes c where c.class_key = p_class;
  select * into v_ic from public.integration_connections ic
  where ic.id = v_conn and ic.user_id = p_user_id and ic.kind = v_class.connector_kind
    and ic.provider in ('google','microsoft') and ic.status = 'connected';
  if not found then
    raise exception 'autopilot_connection_not_found' using errcode = 'P0002';
  end if;
  if not private.apm_connection_usable(p_user_id, v_conn, v_class.connector_kind) then
    raise exception 'autopilot_connection_paused' using errcode = '42501';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(v_class.required_scopes->v_ic.provider, '[]'::jsonb)) s
    where not (s = any (coalesce(v_ic.scopes, '{}'::text[])))
  ) then
    raise exception 'autopilot_connector_scope_missing' using errcode = '42501';
  end if;
  return v_conn;
end;
$$;

-- Approved (Executive Suite) actions: the named account must be the user's own and usable.
create or replace function private.apm_action_connection(p_payload jsonb)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare v_text text := coalesce(p_payload->'composed'->>'connectionId', p_payload->>'connectionId');
begin
  if v_text is null then return null; end if;
  if v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'action_invalid_request' using errcode = '22023';
  end if;
  return v_text::uuid;
end;
$$;
revoke all on function private.apm_action_connection(jsonb) from public, anon, authenticated;

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
  v_conn uuid;
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
  -- A prepared action names the account it will act on; it must be the user's own.
  v_conn := private.apm_action_connection(p_payload);
  if v_conn is not null and not exists (
    select 1 from public.integration_connections ic where ic.id = v_conn and ic.user_id = p_user_id and ic.status <> 'disconnected'
  ) then
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

create or replace function private.apm_service_action_claim(p_user_id uuid, p_action_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.actions;
  v_conn uuid;
begin
  select * into v_row from public.actions a where a.id = p_action_id and a.user_id = p_user_id;
  v_conn := private.apm_action_connection(coalesce(v_row.payload, '{}'::jsonb));
  if v_conn is not null and not private.apm_connection_usable(p_user_id, v_conn, null) then
    raise exception 'action_connection_paused' using errcode = '42501';
  end if;
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

-- ---------------------------------------------------------------- E. calendar rows per account
alter table public.calendar_events drop constraint if exists calendar_events_user_id_provider_external_event_id_key;
create unique index calendar_events_account_event_unique
  on public.calendar_events(user_id, provider, connection_id, external_event_id) nulls not distinct;

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
  if (p_connection_id is null) <> (p_provider = 'device') then
    raise exception 'calendar_invalid_snapshot' using errcode = '22023';
  end if;
  if p_connection_id is not null and not private.apm_connection_usable(v_uid, p_connection_id, 'calendar') then
    raise exception 'connection_paused' using errcode = '42501';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) e
     group by e->>'external_event_id' having count(*) > 1
  ) or exists (select 1 from jsonb_array_elements(p_events) e where coalesce(e->>'external_event_id', '') = '' or e->>'provider' is distinct from p_provider) then
    raise exception 'calendar_duplicate_event' using errcode = '22023';
  end if;
  -- Only THIS account's window is replaced; the other calendars are untouched.
  delete from public.calendar_events c
   where c.user_id = v_uid and c.provider = p_provider
     and c.connection_id is not distinct from p_connection_id
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
  on conflict (user_id, provider, connection_id, external_event_id) do update set
    calendar_external_id = excluded.calendar_external_id, title = excluded.title,
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

-- ---------------------------------------------------------------- F. rules and executions name the account
alter table public.autopilot_rules add column if not exists connection_id uuid references public.integration_connections(id) on delete set null;
alter table public.autopilot_executions add column if not exists connection_id uuid references public.integration_connections(id) on delete set null;
create index if not exists autopilot_rules_connection_idx on public.autopilot_rules(connection_id);
create index if not exists autopilot_executions_connection_idx on public.autopilot_executions(connection_id);
drop index if exists public.autopilot_rules_one_live_per_class;
create unique index autopilot_rules_one_live_per_class_account
  on public.autopilot_rules(user_id, action_class, connection_id) nulls not distinct where status <> 'revoked';

-- A rule with no account named acts on the primary account of its kind.
create or replace function private.apm_autopilot_rules_default_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.connection_id is null then
    select ic.id into new.connection_id
      from public.integration_connections ic
      join public.autopilot_action_classes c on c.class_key = new.action_class and c.connector_kind = ic.kind
     where ic.user_id = new.user_id and ic.is_primary;
  elsif not exists (
    select 1 from public.integration_connections ic
      join public.autopilot_action_classes c on c.class_key = new.action_class and c.connector_kind = ic.kind
     where ic.id = new.connection_id and ic.user_id = new.user_id and ic.status <> 'disconnected'
  ) then
    raise exception 'autopilot_connection_not_found' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
revoke all on function private.apm_autopilot_rules_default_account() from public, anon, authenticated;
create trigger autopilot_rules_default_account before insert on public.autopilot_rules
  for each row execute function private.apm_autopilot_rules_default_account();

-- Every execution acts on the rule's account (or, for a rule with none, the primary).
create or replace function private.apm_autopilot_executions_account_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.autopilot_rules;
  v_kind text;
  v_conn uuid;
  v_expected uuid;
begin
  select * into v_rule from public.autopilot_rules r where r.id = new.rule_id;
  select c.connector_kind into v_kind from public.autopilot_action_classes c where c.class_key = new.action_class;
  select private.apm_action_connection(a.payload) into v_conn from public.actions a where a.id = new.action_id;
  v_expected := coalesce(v_rule.connection_id,
    (select ic.id from public.integration_connections ic where ic.user_id = new.user_id and ic.kind = v_kind and ic.is_primary));
  if v_conn is null or v_conn is distinct from v_expected then
    raise exception 'autopilot_wrong_account' using errcode = '42501';
  end if;
  new.connection_id := v_conn;
  return new;
end;
$$;
revoke all on function private.apm_autopilot_executions_account_guard() from public, anon, authenticated;
create trigger autopilot_executions_account_guard before insert on public.autopilot_executions
  for each row execute function private.apm_autopilot_executions_account_guard();

-- grant_rule takes the account (default: the primary). One live rule per class PER ACCOUNT.
drop function if exists public.apm_autopilot_grant_rule(text, jsonb, timestamptz);
drop function if exists private.apm_autopilot_grant_rule(text, jsonb, timestamptz);
create or replace function private.apm_autopilot_grant_rule(p_action_class text, p_constraints jsonb, p_expires_at timestamptz, p_connection_id uuid default null)
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
  v_conn uuid := p_connection_id;
begin
  if not exists (select 1 from public.autopilot_action_classes c where c.class_key = p_action_class) then
    raise exception 'autopilot_unsupported_action_class' using errcode = '22023';
  end if;
  v_constraints := private.apm_autopilot_check_constraints(p_action_class, p_constraints);
  if v_conn is null then
    select ic.id into v_conn from public.integration_connections ic
      join public.autopilot_action_classes c on c.class_key = p_action_class and c.connector_kind = ic.kind
     where ic.user_id = v_uid and ic.is_primary;
  end if;
  if exists (
    select 1 from public.autopilot_rules r
    where r.user_id = v_uid and r.action_class = p_action_class and r.status <> 'revoked'
      and r.connection_id is not distinct from v_conn
  ) then
    raise exception 'autopilot_rule_exists' using errcode = '23505';
  end if;

  insert into public.autopilot_rules (user_id, action_class, status, constraints, version, granted_at, expires_at, connection_id)
  values (v_uid, p_action_class, 'active', v_constraints, 1, now(), private.apm_autopilot_check_expiry(p_expires_at), v_conn)
  returning * into v_row;

  perform private.apm_autopilot_audit(
    v_uid, 'autopilot.rule_granted', 'autopilot_rule', v_row.id,
    jsonb_build_object('actionClass', v_row.action_class, 'version', v_row.version, 'expiresAt', v_row.expires_at, 'connectionId', v_row.connection_id)
  );
  return to_jsonb(v_row);
end;
$$;
create or replace function public.apm_autopilot_grant_rule(p_action_class text, p_constraints jsonb, p_expires_at timestamptz, p_connection_id uuid default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_grant_rule(p_action_class, p_constraints, p_expires_at, p_connection_id); $$;
revoke all on function private.apm_autopilot_grant_rule(text, jsonb, timestamptz, uuid) from public, anon;
grant execute on function private.apm_autopilot_grant_rule(text, jsonb, timestamptz, uuid) to authenticated;
revoke all on function public.apm_autopilot_grant_rule(text, jsonb, timestamptz, uuid) from public, anon;
grant execute on function public.apm_autopilot_grant_rule(text, jsonb, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------- backfill
-- Existing rows stay valid: each user's oldest live account per kind becomes primary,
-- and an extra account on a plan without the capability is paused (never deleted).
do $$
declare v_user uuid;
begin
  for v_user in select distinct ic.user_id from public.integration_connections ic loop
    perform private.apm_connections_reconcile(v_user);
  end loop;
end $$;
update public.autopilot_rules r set connection_id = ic.id
  from public.autopilot_action_classes c, public.integration_connections ic
 where r.connection_id is null and c.class_key = r.action_class
   and ic.user_id = r.user_id and ic.kind = c.connector_kind and ic.is_primary;
update public.autopilot_executions e set connection_id = ic.id
  from public.actions a, public.integration_connections ic
 where e.connection_id is null and a.id = e.action_id and ic.user_id = e.user_id
   and ic.id::text = coalesce(a.payload->'composed'->>'connectionId', a.payload->>'connectionId');
