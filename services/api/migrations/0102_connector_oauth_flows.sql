create table public.connector_oauth_flows (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  kind text not null check (kind in ('calendar', 'email')),
  verifier_ciphertext text,
  verifier_iv text,
  expires_at timestamptz not null,
  error_code text,
  connection_id uuid references public.integration_connections(id) on delete set null
);
alter table public.connector_oauth_flows enable row level security;
revoke all on public.connector_oauth_flows from public, anon, authenticated;
grant select, insert, update, delete on public.connector_oauth_flows to service_role;
create index connector_oauth_flows_expiry on public.connector_oauth_flows (expires_at);

insert into private.data_rights_tables (table_schema, table_name, user_column, redact_columns)
values ('public', 'connector_oauth_flows', 'user_id', '{id,verifier_ciphertext,verifier_iv}');

-- The edited body and approval claim commit together. A retry cannot replace a sent message.
create function public.apm_service_claim_suite_reply(p_user_id uuid, p_action_id uuid, p_body text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  claimed jsonb;
begin
  if p_body is null or length(btrim(p_body)) = 0 or octet_length(p_body) > 4000 then
    raise exception 'action_invalid_request';
  end if;
  perform 1 from public.actions
    where id = p_action_id and user_id = p_user_id and status = 'prepared'
      and idempotency_key like 'suite:reply:%' and payload->>'suiteProposal' = 'reply'
    for update;
  if not found then raise exception 'action_invalid_state'; end if;
  update public.actions set payload = jsonb_set(payload, '{body}', to_jsonb(p_body))
    where id = p_action_id and user_id = p_user_id;
  claimed := private.apm_service_action_claim(p_user_id, p_action_id);
  return claimed;
end;
$$;
revoke all on function public.apm_service_claim_suite_reply(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.apm_service_claim_suite_reply(uuid, uuid, text) to service_role;

create function public.apm_service_record_suite_undo(p_user_id uuid, p_action_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  update public.actions set status = 'cancelled', updated_at = now()
    where id = p_action_id and user_id = p_user_id and status = 'verified'
      and idempotency_key like 'suite:calendar_fix:%';
  if not found then raise exception 'action_invalid_state'; end if;
  insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id)
    values (p_user_id, 'action.undone', 'user', 'worker', 'action', p_action_id::text);
end;
$$;
revoke all on function public.apm_service_record_suite_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apm_service_record_suite_undo(uuid, uuid) to service_role;

alter table public.message_signals drop constraint message_signals_signal_type_check;
alter table public.message_signals add constraint message_signals_signal_type_check
  check (signal_type in ('commitment','request','follow_up','waiting_for','deadline','meeting','cancellation','completion','person','subscription_price_rise','subscription_unused'));

create or replace function public.apm_service_suite_proposal_candidates(p_slot integer)
returns uuid[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(e.user_id order by e.user_id), '{}'::uuid[])
  from public.subscription_entitlements e
  where e.plan in ('life_os', 'autopilot') and e.status in ('active', 'trialing')
    and mod(mod(hashtext(e.user_id::text), 96) + 96, 96) = p_slot
    and (
      exists (
        select 1 from public.permissions p where p.user_id = e.user_id and p.enabled and p.autonomy_level >= 3
          and (p.domain, p.action_type) in (('calendar','event_write'), ('email','send'), ('life_graph','plan_logistics'))
      ) or exists (
        select 1 from public.integration_connections c where c.user_id = e.user_id and c.provider = 'microsoft'
          and c.kind = 'email' and c.status = 'connected' and c.paused_at is null
      )
    );
$$;

create or replace function private.apm_autopilot_event_protected(p_user_id uuid, p_event public.calendar_events, p_c jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_event.availability = 'out_of_office'
    or (not (p_event.organizer ? 'providerEventType') and lower(p_event.title) ~ '(deep[ -]?work|focus|foreground)')
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(p_c->'protectedTitleKeywords', '[]'::jsonb)) k
      where position(k in lower(p_event.title)) > 0
    )
    or exists (
      select 1 from public.personal_os p
      where p.user_id = p_user_id and p.active_mode = 'deep_work'
        and p.mode_started_at < p_event.ends_at and p.mode_ends_at > p_event.starts_at
    )
    or exists (
      select 1 from public.autopilot_executions e
      where e.user_id = p_user_id and e.action_class = 'calendar.create' and e.status = 'verified'
        and e.external_ref = p_event.external_event_id
    );
$$;
