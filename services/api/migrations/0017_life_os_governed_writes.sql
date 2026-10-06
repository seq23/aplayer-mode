-- Phase B hardening (Codex review of 1c91c9d, two P1 findings).
--
-- 1. Direct-write bypass. The mobile bundle carries the publishable key and the
--    Worker forwards the user's JWT, so with plain table grants a user could
--    INSERT/UPDATE/DELETE Life OS rows through PostgREST and skip lifecycle
--    validation (completed recurring rows, completion without rollover, forged
--    provenance) and the audit trail. Direct writes are revoked here; every write
--    goes through a governed function that checks ownership, the Life OS
--    entitlement and the lifecycle rules, and writes its audit event in the same
--    transaction.
-- 2. Read weakening. 0016 let any owner SELECT retained rows after downgrade.
--    Ordinary reads need own-row AND entitlement again; the data-rights export /
--    inspection path reads through a dedicated owner-only function instead.
--
-- Shape: the SECURITY DEFINER bodies live in the non-exposed `private` schema
-- (search_path = ''); thin SECURITY INVOKER wrappers in `public` are the RPC
-- surface PostgREST exposes. This keeps definer functions off the public API
-- surface (Supabase advisor lints 0028/0029) while authenticated callers can still
-- reach them. The deterministic recurrence engine in packages/planning stays
-- authoritative: the completion function accepts the server-computed next
-- schedule but rejects anything the API itself would reject.

-- ---------------------------------------------------------------------------
-- 1. Revoke direct writes
-- ---------------------------------------------------------------------------

drop policy if exists life_relationships_insert_life_os on public.life_relationships;
drop policy if exists life_relationships_update_life_os on public.life_relationships;
drop policy if exists life_relationships_delete_life_os on public.life_relationships;
drop policy if exists life_admin_items_insert_life_os on public.life_admin_items;
drop policy if exists life_admin_items_update_life_os on public.life_admin_items;
drop policy if exists life_admin_items_delete_life_os on public.life_admin_items;

revoke all on table public.life_relationships from anon;
revoke all on table public.life_admin_items from anon;
revoke insert, update, delete, truncate, references, trigger on table public.life_relationships from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.life_admin_items from authenticated;
grant select on table public.life_relationships to authenticated;
grant select on table public.life_admin_items to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Restore entitlement on ordinary reads
-- ---------------------------------------------------------------------------

drop policy if exists life_relationships_select_own on public.life_relationships;
drop policy if exists life_relationships_select_life_os on public.life_relationships;
create policy life_relationships_select_life_os
  on public.life_relationships for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));

drop policy if exists life_admin_items_select_own on public.life_admin_items;
drop policy if exists life_admin_items_select_life_os on public.life_admin_items;
create policy life_admin_items_select_life_os
  on public.life_admin_items for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_life_os_access((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 3. Shared guards
-- ---------------------------------------------------------------------------

create or replace function private.apm_life_os_require_access()
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
    raise exception 'life_os_unauthenticated' using errcode = '42501';
  end if;
  if not private.apm_has_life_os_access(v_uid) then
    raise exception 'life_os_required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- Validates a recurrence object exactly as the API's zod schema + canonical
-- anchor normalisation produce it. Anchors must equal the row's own schedule, so
-- a caller cannot plant an anchor that the planning engine would later follow.
create or replace function private.apm_life_os_check_recurrence(
  p_recurrence jsonb,
  p_due_at timestamptz,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_interval integer;
begin
  if p_recurrence is null or p_recurrence = '{}'::jsonb then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_recurrence) <> 'object' then
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_recurrence) loop
    if v_key not in ('frequency','interval','timezone','anchorDueAt','anchorStartsAt') then
      raise exception 'life_os_invalid_recurrence' using errcode = '22023';
    end if;
  end loop;
  if coalesce(p_recurrence->>'frequency', '') not in ('daily','weekly','monthly','yearly') then
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  end if;
  if p_recurrence ? 'interval' then
    if jsonb_typeof(p_recurrence->'interval') <> 'number' then
      raise exception 'life_os_invalid_recurrence' using errcode = '22023';
    end if;
    v_interval := (p_recurrence->>'interval')::numeric::integer;
    if v_interval::numeric <> (p_recurrence->>'interval')::numeric or v_interval < 1 or v_interval > 365 then
      raise exception 'life_os_invalid_recurrence' using errcode = '22023';
    end if;
  end if;
  if p_recurrence ? 'timezone' and (
    jsonb_typeof(p_recurrence->'timezone') <> 'string' or char_length(p_recurrence->>'timezone') not between 1 and 120
  ) then
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  end if;
  if p_recurrence ? 'anchorDueAt' and (p_due_at is null or (p_recurrence->>'anchorDueAt')::timestamptz <> p_due_at) then
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  end if;
  if p_recurrence ? 'anchorStartsAt' and (p_starts_at is null or (p_recurrence->>'anchorStartsAt')::timestamptz <> p_starts_at) then
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  end if;
  return p_recurrence;
end;
$$;

create or replace function private.apm_life_os_check_keys(p_payload jsonb, p_allowed text[])
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
    raise exception 'life_os_invalid_request' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_payload) loop
    if not (v_key = any (p_allowed)) then
      -- user_id, provenance_*, source_*, confidence, completed_at, created_at …
      raise exception 'life_os_field_not_allowed' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function private.apm_life_os_audit(
  p_user_id uuid,
  p_event_type text,
  p_object_type text,
  p_object_id uuid,
  p_metadata jsonb
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (p_user_id, p_event_type, 'user', p_object_type, p_object_id::text, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 4. Governed relationship writes
-- ---------------------------------------------------------------------------

create or replace function private.apm_life_os_save_relationship(
  p_person_id uuid,
  p_birthday date default null,
  p_next_contact_at timestamptz default null,
  p_cadence_days integer default null,
  p_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_life_os_require_access();
  v_row public.life_relationships;
begin
  if p_person_id is null or not exists (
    select 1 from public.people p where p.id = p_person_id and p.user_id = v_uid
  ) then
    raise exception 'life_os_person_not_found' using errcode = 'P0002';
  end if;

  insert into public.life_relationships as lr (
    user_id, person_id, birthday, next_contact_at, cadence_days, notes,
    provenance_kind, source_type, source_ref, confidence, updated_at
  ) values (
    v_uid, p_person_id, p_birthday, p_next_contact_at, p_cadence_days, p_notes,
    'stated', 'manual', null, 1, now()
  )
  on conflict (user_id, person_id) do update set
    birthday = excluded.birthday,
    next_contact_at = excluded.next_contact_at,
    cadence_days = excluded.cadence_days,
    notes = excluded.notes,
    provenance_kind = 'stated',
    source_type = 'manual',
    source_ref = null,
    confidence = 1,
    updated_at = now()
  returning lr.* into v_row;

  perform private.apm_life_os_audit(
    v_uid, 'life_os.relationship_saved', 'life_relationship', v_row.id,
    jsonb_build_object('personId', p_person_id)
  );
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_life_os_update_relationship(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_life_os_require_access();
  v_row public.life_relationships;
begin
  perform private.apm_life_os_check_keys(p_patch, array['birthday','next_contact_at','cadence_days','notes']);

  select * into v_row from public.life_relationships lr
  where lr.id = p_id and lr.user_id = v_uid
  for update;
  if not found then
    raise exception 'life_os_relationship_not_found' using errcode = 'P0002';
  end if;

  update public.life_relationships lr set
    birthday = case when p_patch ? 'birthday' then (p_patch->>'birthday')::date else lr.birthday end,
    next_contact_at = case when p_patch ? 'next_contact_at' then (p_patch->>'next_contact_at')::timestamptz else lr.next_contact_at end,
    cadence_days = case when p_patch ? 'cadence_days' then (p_patch->>'cadence_days')::integer else lr.cadence_days end,
    notes = case when p_patch ? 'notes' then p_patch->>'notes' else lr.notes end,
    updated_at = now()
  where lr.id = p_id and lr.user_id = v_uid
  returning lr.* into v_row;

  perform private.apm_life_os_audit(v_uid, 'life_os.relationship_updated', 'life_relationship', v_row.id, '{}'::jsonb);
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Governed Life Admin writes
-- ---------------------------------------------------------------------------

create or replace function private.apm_life_os_create_item(p_item jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_life_os_require_access();
  v_status text;
  v_person uuid;
  v_due timestamptz;
  v_starts timestamptz;
  v_ends timestamptz;
  v_row public.life_admin_items;
begin
  perform private.apm_life_os_check_keys(p_item, array[
    'person_id','kind','title','status','importance','due_at','starts_at','ends_at',
    'recurrence','amount_minor','currency','details'
  ]);

  v_status := coalesce(p_item->>'status', 'open');
  if v_status = 'completed' then
    raise exception 'life_os_use_completion_route' using errcode = '22023';
  end if;
  if v_status not in ('open','planned','scheduled','paused','cancelled') then
    raise exception 'life_os_invalid_request' using errcode = '22023';
  end if;

  v_person := nullif(p_item->>'person_id', '')::uuid;
  if v_person is not null and not exists (
    select 1 from public.people p where p.id = v_person and p.user_id = v_uid
  ) then
    raise exception 'life_os_person_not_found' using errcode = 'P0002';
  end if;

  v_due := nullif(p_item->>'due_at', '')::timestamptz;
  v_starts := nullif(p_item->>'starts_at', '')::timestamptz;
  v_ends := nullif(p_item->>'ends_at', '')::timestamptz;
  if v_starts is not null and v_ends is not null and v_ends < v_starts then
    raise exception 'life_os_invalid_schedule' using errcode = '22023';
  end if;

  insert into public.life_admin_items (
    user_id, person_id, kind, title, status, importance, due_at, starts_at, ends_at,
    recurrence, amount_minor, currency, details, completed_at,
    provenance_kind, source_type, source_ref, confidence
  ) values (
    v_uid,
    v_person,
    p_item->>'kind',
    p_item->>'title',
    v_status,
    coalesce((p_item->>'importance')::smallint, 3),
    v_due,
    v_starts,
    v_ends,
    private.apm_life_os_check_recurrence(coalesce(p_item->'recurrence', '{}'::jsonb), v_due, v_starts),
    (p_item->>'amount_minor')::bigint,
    nullif(p_item->>'currency', ''),
    -- lastCompletedAt is written only by the completion path.
    coalesce(p_item->'details', '{}'::jsonb) - 'lastCompletedAt',
    null,
    'stated', 'manual', null, 1
  )
  returning * into v_row;

  perform private.apm_life_os_audit(
    v_uid, 'life_os.item_created', 'life_admin_item', v_row.id,
    jsonb_build_object('kind', v_row.kind)
  );
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_life_os_update_item(p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_life_os_require_access();
  v_existing public.life_admin_items;
  v_row public.life_admin_items;
  v_person uuid;
  v_due timestamptz;
  v_starts timestamptz;
  v_ends timestamptz;
  v_recurrence jsonb;
  v_details jsonb;
begin
  perform private.apm_life_os_check_keys(p_patch, array[
    'person_id','kind','title','status','importance','due_at','starts_at','ends_at',
    'recurrence','amount_minor','currency','details'
  ]);

  select * into v_existing from public.life_admin_items li
  where li.id = p_id and li.user_id = v_uid
  for update;
  if not found then
    raise exception 'life_os_item_not_found' using errcode = 'P0002';
  end if;

  if p_patch ? 'status' then
    if p_patch->>'status' = 'completed' then
      raise exception 'life_os_use_completion_route' using errcode = '22023';
    end if;
    if coalesce(p_patch->>'status', '') not in ('open','planned','scheduled','paused','cancelled') then
      raise exception 'life_os_invalid_request' using errcode = '22023';
    end if;
  end if;

  v_person := case when p_patch ? 'person_id' then nullif(p_patch->>'person_id', '')::uuid else v_existing.person_id end;
  if p_patch ? 'person_id' and v_person is not null and not exists (
    select 1 from public.people p where p.id = v_person and p.user_id = v_uid
  ) then
    raise exception 'life_os_person_not_found' using errcode = 'P0002';
  end if;

  v_due := case when p_patch ? 'due_at' then nullif(p_patch->>'due_at', '')::timestamptz else v_existing.due_at end;
  v_starts := case when p_patch ? 'starts_at' then nullif(p_patch->>'starts_at', '')::timestamptz else v_existing.starts_at end;
  v_ends := case when p_patch ? 'ends_at' then nullif(p_patch->>'ends_at', '')::timestamptz else v_existing.ends_at end;
  if v_starts is not null and v_ends is not null and v_ends < v_starts then
    raise exception 'life_os_invalid_schedule' using errcode = '22023';
  end if;

  if p_patch ? 'recurrence' then
    v_recurrence := private.apm_life_os_check_recurrence(p_patch->'recurrence', v_due, v_starts);
  elsif (p_patch ? 'due_at' or p_patch ? 'starts_at') and coalesce(v_existing.recurrence->>'frequency', '') <> '' then
    -- Rescheduling a recurring item must re-anchor it (the API always sends the
    -- re-anchored recurrence); a bare reschedule would leave stale anchors.
    raise exception 'life_os_invalid_recurrence' using errcode = '22023';
  else
    v_recurrence := v_existing.recurrence;
  end if;

  if p_patch ? 'details' then
    v_details := coalesce(p_patch->'details', '{}'::jsonb) - 'lastCompletedAt';
    if v_existing.details ? 'lastCompletedAt' then
      v_details := v_details || jsonb_build_object('lastCompletedAt', v_existing.details->'lastCompletedAt');
    end if;
  else
    v_details := v_existing.details;
  end if;

  update public.life_admin_items li set
    person_id = v_person,
    kind = case when p_patch ? 'kind' then p_patch->>'kind' else li.kind end,
    title = case when p_patch ? 'title' then p_patch->>'title' else li.title end,
    status = case when p_patch ? 'status' then p_patch->>'status' else li.status end,
    importance = case when p_patch ? 'importance' then (p_patch->>'importance')::smallint else li.importance end,
    due_at = v_due,
    starts_at = v_starts,
    ends_at = v_ends,
    recurrence = v_recurrence,
    amount_minor = case when p_patch ? 'amount_minor' then (p_patch->>'amount_minor')::bigint else li.amount_minor end,
    currency = case when p_patch ? 'currency' then nullif(p_patch->>'currency', '') else li.currency end,
    details = v_details,
    updated_at = now()
  where li.id = p_id and li.user_id = v_uid
  returning li.* into v_row;

  perform private.apm_life_os_audit(
    v_uid, 'life_os.item_updated', 'life_admin_item', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'status', v_row.status)
  );
  return to_jsonb(v_row);
end;
$$;

-- Completion. The Worker computes the next occurrence with the deterministic
-- planning engine and passes it in; this function enforces the lifecycle:
--   * non-recurring  -> must NOT carry a next schedule; becomes `completed`;
--   * recurring      -> MUST carry a next schedule that moves strictly forward;
--                       stays `open` (completion without rollover is rejected);
--   * recurrence frequency/interval/anchors cannot change on this path;
--   * completed_at / lastCompletedAt are the database clock, never the caller's;
--   * p_expected_updated_at must match the row (no double-completion on a stale read).
create or replace function private.apm_life_os_complete_item(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_next_due_at timestamptz default null,
  p_next_starts_at timestamptz default null,
  p_next_ends_at timestamptz default null,
  p_recurrence jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_life_os_require_access();
  v_existing public.life_admin_items;
  v_row public.life_admin_items;
  v_now timestamptz := now();
  v_recurring boolean;
  v_has_next boolean := p_next_due_at is not null or p_next_starts_at is not null;
  v_recurrence jsonb;
  v_floor timestamptz := now() - interval '5 minutes';
begin
  select * into v_existing from public.life_admin_items li
  where li.id = p_id and li.user_id = v_uid
  for update;
  if not found then
    raise exception 'life_os_item_not_found' using errcode = 'P0002';
  end if;
  if v_existing.status = 'cancelled' then
    raise exception 'life_os_item_cancelled' using errcode = '22023';
  end if;
  if p_expected_updated_at is null or v_existing.updated_at <> p_expected_updated_at then
    raise exception 'life_os_conflict' using errcode = '40001';
  end if;

  v_recurring := coalesce(v_existing.recurrence->>'frequency', '') <> '';

  if not v_recurring then
    if v_has_next or p_next_ends_at is not null or (p_recurrence is not null and p_recurrence <> '{}'::jsonb) then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    update public.life_admin_items li set
      status = 'completed',
      completed_at = v_now,
      details = li.details || jsonb_build_object('lastCompletedAt', v_now),
      updated_at = v_now
    where li.id = p_id and li.user_id = v_uid
    returning li.* into v_row;
  else
    if not v_has_next then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    -- Due-driven items must roll the due date; start-driven items the start.
    if (v_existing.due_at is not null or v_existing.starts_at is null) and p_next_due_at is null then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    if v_existing.starts_at is not null and p_next_starts_at is null then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    if p_next_due_at is not null and (
      p_next_due_at <= v_floor or (v_existing.due_at is not null and p_next_due_at <= v_existing.due_at)
    ) then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    if p_next_starts_at is not null and (
      p_next_starts_at <= v_floor or (v_existing.starts_at is not null and p_next_starts_at <= v_existing.starts_at)
    ) then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;
    if p_next_ends_at is not null and (p_next_starts_at is null or p_next_ends_at < p_next_starts_at) then
      raise exception 'life_os_invalid_completion' using errcode = '22023';
    end if;

    -- Recurrence may only gain canonical anchors/timezone it did not have yet.
    v_recurrence := coalesce(p_recurrence, v_existing.recurrence);
    if jsonb_typeof(v_recurrence) <> 'object'
      or v_recurrence->>'frequency' is distinct from v_existing.recurrence->>'frequency'
      or coalesce((v_recurrence->>'interval')::numeric, 1) <> coalesce((v_existing.recurrence->>'interval')::numeric, 1)
      or (v_existing.recurrence ? 'timezone' and v_recurrence->'timezone' is distinct from v_existing.recurrence->'timezone')
      or (v_existing.recurrence ? 'anchorDueAt' and v_recurrence->'anchorDueAt' is distinct from v_existing.recurrence->'anchorDueAt')
      or (v_existing.recurrence ? 'anchorStartsAt' and v_recurrence->'anchorStartsAt' is distinct from v_existing.recurrence->'anchorStartsAt')
    then
      raise exception 'life_os_invalid_recurrence' using errcode = '22023';
    end if;
    perform private.apm_life_os_check_recurrence(
      v_recurrence - 'anchorDueAt' - 'anchorStartsAt', null, null
    );
    if (v_recurrence ? 'anchorDueAt' and jsonb_typeof(v_recurrence->'anchorDueAt') <> 'string')
      or (v_recurrence ? 'anchorStartsAt' and jsonb_typeof(v_recurrence->'anchorStartsAt') <> 'string')
      -- A newly added due anchor is the row's own due date, or (for an item with
      -- no schedule at all) the completion instant itself.
      or (not (v_existing.recurrence ? 'anchorDueAt') and v_recurrence ? 'anchorDueAt' and (
            case
              when v_existing.due_at is not null
                then (v_recurrence->>'anchorDueAt')::timestamptz is distinct from v_existing.due_at
              when v_existing.starts_at is null
                then (v_recurrence->>'anchorDueAt')::timestamptz not between v_floor and v_now + interval '5 minutes'
              else true
            end))
      or (not (v_existing.recurrence ? 'anchorStartsAt') and v_recurrence ? 'anchorStartsAt'
          and (v_recurrence->>'anchorStartsAt')::timestamptz is distinct from v_existing.starts_at)
    then
      raise exception 'life_os_invalid_recurrence' using errcode = '22023';
    end if;

    update public.life_admin_items li set
      status = 'open',
      completed_at = v_now,
      details = li.details || jsonb_build_object('lastCompletedAt', v_now),
      recurrence = v_recurrence,
      due_at = coalesce(p_next_due_at, li.due_at),
      starts_at = coalesce(p_next_starts_at, li.starts_at),
      ends_at = coalesce(p_next_ends_at, li.ends_at),
      updated_at = v_now
    where li.id = p_id and li.user_id = v_uid
    returning li.* into v_row;
  end if;

  perform private.apm_life_os_audit(
    v_uid, 'life_os.item_completed', 'life_admin_item', v_row.id,
    jsonb_build_object(
      'kind', v_row.kind,
      'recurring', v_recurring,
      'nextDueAt', case when v_row.status = 'open' then v_row.due_at else null end
    )
  );
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Data-rights read path (owner-only, no entitlement)
-- ---------------------------------------------------------------------------

create or replace function private.apm_life_os_data_rights_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'life_os_unauthenticated' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'life_relationships', coalesce((
      select jsonb_agg(to_jsonb(lr) order by lr.created_at, lr.id)
      from public.life_relationships lr where lr.user_id = v_uid
    ), '[]'::jsonb),
    'life_admin_items', coalesce((
      select jsonb_agg(to_jsonb(li) order by li.created_at, li.id)
      from public.life_admin_items li where li.user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Public RPC surface (SECURITY INVOKER wrappers)
-- ---------------------------------------------------------------------------

create or replace function public.apm_life_os_save_relationship(
  p_person_id uuid,
  p_birthday date default null,
  p_next_contact_at timestamptz default null,
  p_cadence_days integer default null,
  p_notes text default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_life_os_save_relationship(p_person_id, p_birthday, p_next_contact_at, p_cadence_days, p_notes); $$;

create or replace function public.apm_life_os_update_relationship(p_id uuid, p_patch jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_life_os_update_relationship(p_id, p_patch); $$;

create or replace function public.apm_life_os_create_item(p_item jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_life_os_create_item(p_item); $$;

create or replace function public.apm_life_os_update_item(p_id uuid, p_patch jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_life_os_update_item(p_id, p_patch); $$;

create or replace function public.apm_life_os_complete_item(
  p_id uuid,
  p_expected_updated_at timestamptz,
  p_next_due_at timestamptz default null,
  p_next_starts_at timestamptz default null,
  p_next_ends_at timestamptz default null,
  p_recurrence jsonb default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_life_os_complete_item(p_id, p_expected_updated_at, p_next_due_at, p_next_starts_at, p_next_ends_at, p_recurrence); $$;

create or replace function public.apm_life_os_data_rights_export()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_life_os_data_rights_export(); $$;

-- ---------------------------------------------------------------------------
-- 8. Execute grants: authenticated only, never anon/public
-- ---------------------------------------------------------------------------

revoke all on function private.apm_life_os_require_access() from public, anon;
revoke all on function private.apm_life_os_check_recurrence(jsonb, timestamptz, timestamptz) from public, anon;
revoke all on function private.apm_life_os_check_keys(jsonb, text[]) from public, anon;
revoke all on function private.apm_life_os_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.apm_life_os_save_relationship(uuid, date, timestamptz, integer, text) from public, anon;
revoke all on function private.apm_life_os_update_relationship(uuid, jsonb) from public, anon;
revoke all on function private.apm_life_os_create_item(jsonb) from public, anon;
revoke all on function private.apm_life_os_update_item(uuid, jsonb) from public, anon;
revoke all on function private.apm_life_os_complete_item(uuid, timestamptz, timestamptz, timestamptz, timestamptz, jsonb) from public, anon;
revoke all on function private.apm_life_os_data_rights_export() from public, anon;

grant execute on function private.apm_life_os_save_relationship(uuid, date, timestamptz, integer, text) to authenticated;
grant execute on function private.apm_life_os_update_relationship(uuid, jsonb) to authenticated;
grant execute on function private.apm_life_os_create_item(jsonb) to authenticated;
grant execute on function private.apm_life_os_update_item(uuid, jsonb) to authenticated;
grant execute on function private.apm_life_os_complete_item(uuid, timestamptz, timestamptz, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function private.apm_life_os_data_rights_export() to authenticated;

revoke all on function public.apm_life_os_save_relationship(uuid, date, timestamptz, integer, text) from public, anon;
revoke all on function public.apm_life_os_update_relationship(uuid, jsonb) from public, anon;
revoke all on function public.apm_life_os_create_item(jsonb) from public, anon;
revoke all on function public.apm_life_os_update_item(uuid, jsonb) from public, anon;
revoke all on function public.apm_life_os_complete_item(uuid, timestamptz, timestamptz, timestamptz, timestamptz, jsonb) from public, anon;
revoke all on function public.apm_life_os_data_rights_export() from public, anon;

grant execute on function public.apm_life_os_save_relationship(uuid, date, timestamptz, integer, text) to authenticated;
grant execute on function public.apm_life_os_update_relationship(uuid, jsonb) to authenticated;
grant execute on function public.apm_life_os_create_item(jsonb) to authenticated;
grant execute on function public.apm_life_os_update_item(uuid, jsonb) to authenticated;
grant execute on function public.apm_life_os_complete_item(uuid, timestamptz, timestamptz, timestamptz, timestamptz, jsonb) to authenticated;
grant execute on function public.apm_life_os_data_rights_export() to authenticated;
