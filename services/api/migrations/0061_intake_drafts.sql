-- 0061: the first-run intake draft (docs/34 §5, §6).
--
-- An answer exists the moment it is tapped: the device writes it first, then the draft
-- reaches the server here. The intake starts before any account (a silent anonymous
-- session when the project allows it), so RLS and every RPC work for anonymous users too.
--
--  * public.intake_drafts: one draft per user (answers keyed by question id, the client
--    time of each answer, the cursor, the bank version). Clients can SELECT their own row;
--    every write goes through the governed RPCs below (SECURITY DEFINER in `private`,
--    search_path '', ownership from auth.uid(), audited at creation and merge).
--  * Saving merges per question, last write wins by the client's answer time, so offline
--    answers, retries and a second device never duplicate or overwrite newer answers.
--  * Install is idempotent: the client's idempotency key (derived from the draft version)
--    is claimed once; a retry after success replays, a concurrent second tap is refused.
--  * Signing in to an EXISTING account with an anonymous draft merges it by rule (§5 9c):
--    no installed OS → the draft becomes the account's draft; an installed OS is kept and
--    the answers wait as an Edit-my-OS draft (`pending_edit`). Service role only: the API
--    proves both identities before it calls this.
--  * Maintenance (service role, daily cron): installed drafts are deleted 30 days after
--    install (docs/09); anonymous users with no activity for 30 days are listed for the
--    API to delete through the Auth admin API.

create table public.intake_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bank_version integer not null default 1 check (bank_version between 1 and 1000),
  version integer not null default 0 check (version between 0 and 2000000000),
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and octet_length(answers::text) <= 64000),
  answered_at jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answered_at) = 'object' and octet_length(answered_at::text) <= 16000),
  cursor text not null default 'games' check (cursor ~ '^[a-z0-9_]{1,40}$'),
  status text not null default 'open' check (status in ('open','installed','pending_edit')),
  installed_version integer,
  installed_at timestamptz,
  client_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.intake_drafts enable row level security;
create policy intake_drafts_select_own on public.intake_drafts for select to authenticated using ((select auth.uid()) = user_id);
revoke all on table public.intake_drafts from anon;
revoke insert, update, delete, truncate, references, trigger on table public.intake_drafts from authenticated;
grant select on table public.intake_drafts to authenticated;

create table private.intake_installs (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,80}$'),
  status text not null check (status in ('started','done')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (user_id, idempotency_key)
);
revoke all on table private.intake_installs from public, anon, authenticated;

-- The data-rights export reads every user-owned table from one registry (0043).
insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns) values
  ('public', 'intake_drafts', 'user_id', '{}'),
  ('private', 'intake_installs', 'user_id', '{}')
on conflict do nothing;

-- ---------------------------------------------------------------- helpers
create or replace function private.apm_intake_draft_json(p_row public.intake_drafts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when p_row.user_id is null then null else jsonb_build_object(
    'bankVersion', p_row.bank_version,
    'version', p_row.version,
    'answers', p_row.answers,
    'answeredAt', p_row.answered_at,
    'cursor', p_row.cursor,
    'status', p_row.status,
    'updatedAt', floor(extract(epoch from coalesce(p_row.client_updated_at, p_row.updated_at)) * 1000)::bigint,
    'installedVersion', p_row.installed_version
  ) end;
$$;

-- Per-question last-write-wins merge of two answer maps with their answer times.
create or replace function private.apm_intake_merge(
  p_answers jsonb, p_times jsonb, p_new_answers jsonb, p_new_times jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_answers jsonb := coalesce(p_answers, '{}'::jsonb);
  v_times jsonb := coalesce(p_times, '{}'::jsonb);
  v_key text;
  v_old numeric;
  v_new numeric;
begin
  for v_key in
    select k from jsonb_object_keys(coalesce(p_new_times, '{}'::jsonb)) k
    union
    select k from jsonb_object_keys(coalesce(p_new_answers, '{}'::jsonb)) k
  loop
    v_old := case when jsonb_typeof(v_times->v_key) = 'number' then (v_times->>v_key)::numeric else -1 end;
    v_new := case when jsonb_typeof(p_new_times->v_key) = 'number' then (p_new_times->>v_key)::numeric else 0 end;
    if v_new > v_old or (v_new = v_old and not (v_answers ? v_key)) then
      if p_new_answers ? v_key then
        v_answers := v_answers || jsonb_build_object(v_key, p_new_answers->v_key);
      else
        v_answers := v_answers - v_key; -- cleared on the newer copy
      end if;
      v_times := v_times || jsonb_build_object(v_key, v_new);
    end if;
  end loop;
  return jsonb_build_object('answers', v_answers, 'times', v_times);
end;
$$;

create or replace function private.apm_intake_check_draft(p_draft jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if p_draft is null or jsonb_typeof(p_draft) <> 'object'
     or coalesce(jsonb_typeof(p_draft->'answers'), '') <> 'object'
     or (p_draft ? 'answeredAt' and coalesce(jsonb_typeof(p_draft->'answeredAt'), '') <> 'object')
     or coalesce(jsonb_typeof(p_draft->'version'), '') <> 'number'
     or (p_draft ? 'bankVersion' and coalesce(jsonb_typeof(p_draft->'bankVersion'), '') <> 'number')
     or coalesce(p_draft->>'cursor', 'games') !~ '^[a-z0-9_]{1,40}$'
     or octet_length((p_draft->'answers')::text) > 64000
     or octet_length(coalesce(p_draft->'answeredAt', '{}'::jsonb)::text) > 16000 then
    raise exception 'intake_invalid_draft' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_draft->'answers') loop
    if v_key !~ '^[a-z_][a-z0-9_|]{0,59}$' then
      raise exception 'intake_invalid_draft' using errcode = '22023';
    end if;
  end loop;
  for v_key in select jsonb_object_keys(coalesce(p_draft->'answeredAt', '{}'::jsonb)) loop
    if jsonb_typeof(p_draft->'answeredAt'->v_key) <> 'number' then
      raise exception 'intake_invalid_draft' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function private.apm_intake_audit(p_user_id uuid, p_event text, p_metadata jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (p_user_id, p_event, 'user', 'intake_draft', p_user_id::text, coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------- RPCs (owner)
create or replace function private.apm_save_intake_draft(p_draft jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.intake_drafts;
  v_merged jsonb;
  v_client_ms numeric;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  perform private.apm_intake_check_draft(p_draft);
  v_client_ms := case when jsonb_typeof(p_draft->'updatedAt') = 'number' then (p_draft->>'updatedAt')::numeric end;

  select * into v_row from public.intake_drafts d where d.user_id = v_uid for update;
  if v_row.user_id is null then
    v_merged := private.apm_intake_merge('{}'::jsonb, '{}'::jsonb, p_draft->'answers', p_draft->'answeredAt');
    insert into public.intake_drafts (user_id, bank_version, version, answers, answered_at, cursor, client_updated_at)
    values (
      v_uid,
      coalesce((p_draft->>'bankVersion')::integer, 1),
      greatest((p_draft->>'version')::integer, 0),
      v_merged->'answers', v_merged->'times',
      coalesce(p_draft->>'cursor', 'games'),
      case when v_client_ms is not null then to_timestamp(v_client_ms / 1000) end
    )
    returning * into v_row;
    perform private.apm_intake_audit(v_uid, 'intake_draft.created', jsonb_build_object('answers', (select count(*) from jsonb_object_keys(v_row.answers))));
    return private.apm_intake_draft_json(v_row);
  end if;

  v_merged := private.apm_intake_merge(v_row.answers, v_row.answered_at, p_draft->'answers', p_draft->'answeredAt');
  update public.intake_drafts d set
    answers = v_merged->'answers',
    answered_at = v_merged->'times',
    bank_version = greatest(d.bank_version, coalesce((p_draft->>'bankVersion')::integer, 1)),
    version = greatest(d.version, (p_draft->>'version')::integer) + 1,
    -- The cursor follows the copy changed last.
    cursor = case when v_client_ms is null or d.client_updated_at is null or to_timestamp(v_client_ms / 1000) >= d.client_updated_at
                  then coalesce(p_draft->>'cursor', d.cursor) else d.cursor end,
    client_updated_at = greatest(d.client_updated_at, case when v_client_ms is not null then to_timestamp(v_client_ms / 1000) end),
    updated_at = now()
  where d.user_id = v_uid
  returning * into v_row;
  return private.apm_intake_draft_json(v_row);
end;
$$;

create or replace function private.apm_get_intake_draft()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.intake_drafts;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select * into v_row from public.intake_drafts d where d.user_id = v_uid;
  return private.apm_intake_draft_json(v_row);
end;
$$;

-- Install idempotency (docs/34 §6 rule 7, AT8): 'claimed' = install now; 'replay' = already
-- installed with this key; 'in_progress' = a second tap while the first runs.
create or replace function private.apm_claim_intake_install(p_key text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row private.intake_installs;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_.:-]{1,80}$' then
    raise exception 'intake_invalid_key' using errcode = '22023';
  end if;
  insert into private.intake_installs (user_id, idempotency_key, status) values (v_uid, p_key, 'started')
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_row;
  if v_row.user_id is not null then return 'claimed'; end if;
  select * into v_row from private.intake_installs i where i.user_id = v_uid and i.idempotency_key = p_key for update;
  if v_row.status = 'done' then return 'replay'; end if;
  -- A start that never finished (a timeout) may be retried after 2 minutes.
  if v_row.started_at < now() - interval '2 minutes' then
    update private.intake_installs set started_at = now() where user_id = v_uid and idempotency_key = p_key;
    return 'claimed';
  end if;
  return 'in_progress';
end;
$$;

create or replace function private.apm_finish_intake_install(p_key text, p_ok boolean, p_version integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if not exists (select 1 from private.intake_installs i where i.user_id = v_uid and i.idempotency_key = p_key) then
    raise exception 'intake_install_not_claimed' using errcode = '55000';
  end if;
  if not coalesce(p_ok, false) then
    delete from private.intake_installs where user_id = v_uid and idempotency_key = p_key and status = 'started';
    return;
  end if;
  update private.intake_installs set status = 'done', finished_at = now() where user_id = v_uid and idempotency_key = p_key;
  update public.intake_drafts
     set status = 'installed', installed_version = greatest(coalesce(installed_version, 0), coalesce(p_version, 0)), installed_at = now(), updated_at = now()
   where user_id = v_uid;
  perform private.apm_intake_audit(v_uid, 'intake.installed', jsonb_build_object('key', p_key));
end;
$$;

-- ---------------------------------------------------------------- service role
create or replace function private.apm_service_merge_anonymous_draft(p_from uuid, p_to uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_from public.intake_drafts;
  v_to public.intake_drafts;
  v_merged jsonb;
  v_installed boolean;
  v_outcome text;
begin
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'intake_invalid_merge' using errcode = '22023';
  end if;
  select * into v_from from public.intake_drafts d where d.user_id = p_from for update;
  if v_from.user_id is null then
    return jsonb_build_object('outcome', 'nothing_to_merge');
  end if;
  select exists (select 1 from public.personal_os p where p.user_id = p_to) into v_installed;
  select * into v_to from public.intake_drafts d where d.user_id = p_to for update;
  v_merged := private.apm_intake_merge(coalesce(v_to.answers, '{}'::jsonb), coalesce(v_to.answered_at, '{}'::jsonb), v_from.answers, v_from.answered_at);
  v_outcome := case when v_installed then 'pending_edit' else 'draft' end;
  insert into public.intake_drafts (user_id, bank_version, version, answers, answered_at, cursor, status, client_updated_at)
  values (p_to, v_from.bank_version, v_from.version + 1, v_merged->'answers', v_merged->'times', v_from.cursor,
          case when v_installed then 'pending_edit' else 'open' end, v_from.client_updated_at)
  on conflict (user_id) do update set
    answers = excluded.answers,
    answered_at = excluded.answered_at,
    bank_version = greatest(public.intake_drafts.bank_version, excluded.bank_version),
    version = greatest(public.intake_drafts.version, excluded.version) + 1,
    cursor = case when v_installed then public.intake_drafts.cursor else excluded.cursor end,
    status = case when v_installed then 'pending_edit' else public.intake_drafts.status end,
    updated_at = now();
  delete from public.intake_drafts where user_id = p_from;
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (p_to, 'intake_draft.merged', 'system', 'intake_draft', p_to::text, jsonb_build_object('outcome', v_outcome, 'fromAnonymous', true));
  return jsonb_build_object('outcome', v_outcome);
end;
$$;

create or replace function private.apm_service_intake_maintenance(p_now timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_stale jsonb;
begin
  delete from public.intake_drafts where status = 'installed' and installed_at < p_now - interval '30 days';
  get diagnostics v_deleted = row_count;
  select coalesce(jsonb_agg(u.id), '[]'::jsonb) into v_stale from (
    select au.id from auth.users au
     where coalesce(au.is_anonymous, false)
       and coalesce(au.last_sign_in_at, au.created_at) < p_now - interval '30 days'
       and not exists (select 1 from public.intake_drafts d where d.user_id = au.id and d.updated_at >= p_now - interval '30 days')
       and not exists (select 1 from public.personal_os p where p.user_id = au.id and p.updated_at >= p_now - interval '30 days')
     order by au.created_at
     limit 500
  ) u;
  return jsonb_build_object('deletedDrafts', v_deleted, 'staleAnonymous', v_stale);
end;
$$;

-- ---------------------------------------------------------------- public RPC surface (thin)
create or replace function public.apm_save_intake_draft(p_draft jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_save_intake_draft(p_draft); $$;
create or replace function public.apm_get_intake_draft()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_get_intake_draft(); $$;
create or replace function public.apm_claim_intake_install(p_key text)
returns text language sql volatile security invoker set search_path = ''
as $$ select private.apm_claim_intake_install(p_key); $$;
create or replace function public.apm_finish_intake_install(p_key text, p_ok boolean, p_version integer)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_finish_intake_install(p_key, p_ok, p_version); $$;
create or replace function public.apm_service_merge_anonymous_draft(p_from uuid, p_to uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_merge_anonymous_draft(p_from, p_to); $$;
create or replace function public.apm_service_intake_maintenance()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_intake_maintenance(now()); $$;

-- ---------------------------------------------------------------- grants
revoke all on function private.apm_intake_draft_json(public.intake_drafts) from public, anon, authenticated;
revoke all on function private.apm_intake_merge(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_intake_check_draft(jsonb) from public, anon, authenticated;
revoke all on function private.apm_intake_audit(uuid, text, jsonb) from public, anon, authenticated;

revoke all on function private.apm_save_intake_draft(jsonb) from public, anon;
grant execute on function private.apm_save_intake_draft(jsonb) to authenticated;
revoke all on function public.apm_save_intake_draft(jsonb) from public, anon;
grant execute on function public.apm_save_intake_draft(jsonb) to authenticated;
revoke all on function private.apm_get_intake_draft() from public, anon;
grant execute on function private.apm_get_intake_draft() to authenticated;
revoke all on function public.apm_get_intake_draft() from public, anon;
grant execute on function public.apm_get_intake_draft() to authenticated;
revoke all on function private.apm_claim_intake_install(text) from public, anon;
grant execute on function private.apm_claim_intake_install(text) to authenticated;
revoke all on function public.apm_claim_intake_install(text) from public, anon;
grant execute on function public.apm_claim_intake_install(text) to authenticated;
revoke all on function private.apm_finish_intake_install(text, boolean, integer) from public, anon;
grant execute on function private.apm_finish_intake_install(text, boolean, integer) to authenticated;
revoke all on function public.apm_finish_intake_install(text, boolean, integer) from public, anon;
grant execute on function public.apm_finish_intake_install(text, boolean, integer) to authenticated;

revoke all on function private.apm_service_merge_anonymous_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function private.apm_service_merge_anonymous_draft(uuid, uuid) to service_role;
revoke all on function public.apm_service_merge_anonymous_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_merge_anonymous_draft(uuid, uuid) to service_role;
revoke all on function private.apm_service_intake_maintenance(timestamptz) from public, anon, authenticated;
grant execute on function private.apm_service_intake_maintenance(timestamptz) to service_role;
revoke all on function public.apm_service_intake_maintenance() from public, anon, authenticated;
grant execute on function public.apm_service_intake_maintenance() to service_role;
