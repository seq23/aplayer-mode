-- 0099: "Report this" on the rest of APM's generated content (App Review Guideline 1.2;
-- ship-ready app-review row 10). 0066 covers coach replies; this covers the items of today's
-- plan and each Radar item, which APM writes for the person and which had no Report action.
--
-- What is stored is the item's kind, its id and a fixed reason: never the item's text (it is
-- written from the person's own goals, calendar and email) and no free-text note. Clients cannot
-- write the table; the only writer is a SECURITY DEFINER function. One report per item per
-- person (a second tap returns the first). Additive only: one new table and two functions.

create table if not exists public.content_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('plan_item','radar_item')),
  ref text not null check (char_length(ref) between 1 and 200),
  reason text not null check (reason in ('harmful','wrong','inappropriate','other')),
  status text not null default 'open' check (status in ('open','reviewed')),
  created_at timestamptz not null default now()
);
create unique index if not exists content_reports_one_per_item on public.content_reports(user_id, kind, ref);
create index if not exists content_reports_user_idx on public.content_reports(user_id, created_at desc);
alter table public.content_reports enable row level security;
drop policy if exists content_reports_select_own on public.content_reports;
create policy content_reports_select_own on public.content_reports for select to authenticated using ((select auth.uid()) = user_id);
revoke insert, update, delete, truncate, references, trigger on table public.content_reports from anon, authenticated;
revoke all on table public.content_reports from anon;

create or replace function private.apm_report_content(p_kind text, p_ref text, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_existing uuid;
  v_id uuid;
begin
  if v_user is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('plan_item','radar_item') then
    raise exception 'report_invalid_kind' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('harmful','wrong','inappropriate','other') then
    raise exception 'report_invalid_reason' using errcode = '22023';
  end if;
  if p_ref is null or char_length(p_ref) not between 1 and 200 or p_ref ~ '[\x01-\x1f\x7f]' then
    raise exception 'report_invalid_ref' using errcode = '22023';
  end if;
  select r.id into v_existing from public.content_reports r where r.user_id = v_user and r.kind = p_kind and r.ref = p_ref;
  if v_existing is not null then return jsonb_build_object('reportId', v_existing, 'replayed', true); end if;
  insert into public.content_reports (user_id, kind, ref, reason) values (v_user, p_kind, p_ref, p_reason)
  returning id into v_id;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
  values (v_user, 'content.reported', 'user', 'app', 'content_report', v_id::text,
          jsonb_build_object('kind', p_kind, 'ref', p_ref, 'reason', p_reason));
  return jsonb_build_object('reportId', v_id, 'replayed', false);
end;
$$;
create or replace function public.apm_report_content(p_kind text, p_ref text, p_reason text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_report_content(p_kind, p_ref, p_reason); $$;
revoke all on function private.apm_report_content(text, text, text) from public, anon;
grant execute on function private.apm_report_content(text, text, text) to authenticated;
revoke all on function public.apm_report_content(text, text, text) from public, anon;
grant execute on function public.apm_report_content(text, text, text) to authenticated;

insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns) values
  ('public', 'content_reports', 'user_id', '{}')
on conflict do nothing;
