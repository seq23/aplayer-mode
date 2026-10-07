-- 0066: App Store items from the app review (docs/35, 7 Oct 2026).
--
--  A. "Report this" on AI coach replies (App Review 1.2 / 5.6.x for generative content):
--     a person can report one stored assistant reply. The report keeps a snapshot of the
--     reply text (so it survives the session being deleted), a fixed reason and an optional
--     note, and writes an audit row in the same transaction. Clients cannot write the table;
--     the only writer is a SECURITY DEFINER function that checks the turn is the caller's own
--     assistant reply. One report per reply per person (a second tap returns the first).
--  B. The App Review demo sign-in is audited: 'auth.review_login' joins the Worker's
--     user-actor allow-list (services/api/src/audit.ts WORKER_AUDIT_EVENTS is pinned to it).

-- ---------------------------------------------------------------- A. coach reply reports
create table if not exists public.coaching_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  turn_id uuid references public.coaching_turns(id) on delete set null,
  session_id uuid,
  reason text not null check (reason in ('harmful','wrong','inappropriate','other')),
  note text check (note is null or char_length(note) <= 500),
  reply_excerpt text not null check (char_length(reply_excerpt) <= 2000),
  status text not null default 'open' check (status in ('open','reviewed')),
  created_at timestamptz not null default now()
);
create unique index if not exists coaching_reports_one_per_turn on public.coaching_reports(user_id, turn_id) where turn_id is not null;
create index if not exists coaching_reports_user_idx on public.coaching_reports(user_id, created_at desc);
alter table public.coaching_reports enable row level security;
drop policy if exists coaching_reports_select_own on public.coaching_reports;
create policy coaching_reports_select_own on public.coaching_reports for select to authenticated using ((select auth.uid()) = user_id);
revoke insert, update, delete, truncate, references, trigger on table public.coaching_reports from anon, authenticated;
revoke all on table public.coaching_reports from anon;

create or replace function private.apm_report_coach_reply(p_turn_id uuid, p_reason text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_turn public.coaching_turns;
  v_existing uuid;
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('harmful','wrong','inappropriate','other') then
    raise exception 'report_invalid_reason' using errcode = '22023';
  end if;
  if p_note is not null and (char_length(p_note) > 500 or p_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'report_invalid_note' using errcode = '22023';
  end if;
  select * into v_turn from public.coaching_turns t where t.id = p_turn_id and t.user_id = v_user;
  if v_turn.id is null or v_turn.role <> 'assistant' then
    raise exception 'report_turn_not_found' using errcode = 'P0002';
  end if;
  select r.id into v_existing from public.coaching_reports r where r.user_id = v_user and r.turn_id = v_turn.id;
  if v_existing is not null then return jsonb_build_object('reportId', v_existing, 'replayed', true); end if;
  insert into public.coaching_reports (user_id, turn_id, session_id, reason, note, reply_excerpt)
  values (v_user, v_turn.id, v_turn.session_id, p_reason, nullif(btrim(p_note), ''), left(v_turn.content, 2000))
  returning id into v_id;
  -- The audit row carries ids and the reason only: never the reply text or the note.
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (v_user, 'coaching.reply_reported', 'user', 'app', 'coaching_report', v_id::text,
          jsonb_build_object('reason', p_reason, 'turnId', v_turn.id, 'sessionId', v_turn.session_id));
  return jsonb_build_object('reportId', v_id, 'replayed', false);
end;
$$;
create or replace function public.apm_report_coach_reply(p_turn_id uuid, p_reason text, p_note text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_report_coach_reply(p_turn_id, p_reason, p_note); $$;
revoke all on function private.apm_report_coach_reply(uuid, text, text) from public, anon;
grant execute on function private.apm_report_coach_reply(uuid, text, text) to authenticated;
revoke all on function public.apm_report_coach_reply(uuid, text, text) from public, anon;
grant execute on function public.apm_report_coach_reply(uuid, text, text) to authenticated;

-- The data-rights export reads every user-owned table from one registry (0043).
insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns) values
  ('public', 'coaching_reports', 'user_id', '{}')
on conflict do nothing;

-- ---------------------------------------------------------------- B. audited review sign-in
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
       'mode.entered','mode.exited','sprint.completed','sprint.recovery_started','recovery.return_declared','recovery.resumed',
       'auth.review_login')
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
revoke all on function private.apm_service_record_audit(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_record_audit(uuid, text, text, text, text, jsonb) to service_role;
