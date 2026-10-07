-- Phase C+ — Autopilot action classes (owner's ruling, 6 Oct 2026; docs/31).
--
-- Autopilot may now act on its own, inside user-written standing rules, for four
-- more classes. Every one ships INACTIVE (activation is a reviewed migration that
-- records Phase E runtime evidence), exactly like calendar.create / email.draft.
--
--   email.send          rule-defined kinds only: scheduling replies, follow-ups on
--                       what OTHERS owe the user, confirmations, pre-approved
--                       templates; recipient + domain allow-lists; per-rule and
--                       per-recipient daily caps; CR/LF header guards. Can't undo.
--   calendar.reschedule only events the user marked flexible or that match the
--                       rule's criteria; never Deep Work / foreground / Autopilot
--                       routine blocks; only the user's own meetings. Undo moves
--                       it back.
--   calendar.decline    only meetings that violate a boundary the rule declares,
--                       never protected blocks, never the user's own meetings; a
--                       polite note goes with it. Undo re-accepts.
--   appointment.book    FREE bookings only, by emailing an allow-listed provider
--                       with a fixed request (no free text: scheduling logistics,
--                       never clinical choices). Anything that needs a card or a
--                       deposit STOPS and becomes a prepared Life OS action.
--                       Can't undo (cancel with the provider).
--   subscription.cancel saves money, never spends it: a fixed cancellation email
--                       to an allow-listed provider domain, or — when the provider
--                       has no emailed route — a prepared cancellation request.
--                       Never signs up, upgrades, pays or carries payment data.
--
-- Still rejected by name: purchases, payments, upgrades/sign-ups, clinical and
-- healthcare decisions, money movement, generic event edits, connector admin.
--
-- Also fixes the Phase C P2: a user could call apm_autopilot_record_result on their
-- own claimed run and mark it failed to free their daily cap. Results and undo are
-- now recorded ONLY by the Worker with the server-only key (service_role), after it
-- has seen the provider's answer; the authenticated RPCs are dropped.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;
grant usage on schema private to service_role;

-- ---------------------------------------------------------------------------
-- 1. Class catalogue
-- ---------------------------------------------------------------------------

do $$
declare v_name text;
begin
  for v_name in
    select conname from pg_catalog.pg_constraint
    where conrelid = 'public.autopilot_action_classes'::regclass and contype = 'c'
  loop
    execute format('alter table public.autopilot_action_classes drop constraint %I', v_name);
  end loop;
end $$;

alter table public.autopilot_action_classes
  add column connector_kind text,
  add column undo_label text,
  add column required_scopes jsonb not null default '{}'::jsonb;

update public.autopilot_action_classes set connector_kind = 'calendar', undo_label = 'Undo removes the event APM created.',
  required_scopes = '{"google":["https://www.googleapis.com/auth/calendar.events"],"microsoft":["Calendars.ReadWrite"]}'
  where class_key = 'calendar.create';
update public.autopilot_action_classes set connector_kind = 'email', undo_label = 'Undo deletes the draft APM prepared.',
  required_scopes = '{"google":["https://www.googleapis.com/auth/gmail.compose"],"microsoft":["Mail.ReadWrite"]}'
  where class_key = 'email.draft';

insert into public.autopilot_action_classes (class_key, domain, action_type, reversible, undo_method, connector_kind, undo_label, required_scopes) values
  ('email.send', 'email', 'email.send', false, 'none', 'email',
   'Can''t undo: a sent message cannot be recalled.',
   '{"google":["https://www.googleapis.com/auth/gmail.send"],"microsoft":["Mail.Send"]}'),
  ('calendar.reschedule', 'calendar', 'calendar.reschedule', true, 'restore_time', 'calendar',
   'Undo moves the meeting back to its original time (attendees are notified again).',
   '{"google":["https://www.googleapis.com/auth/calendar.events"],"microsoft":["Calendars.ReadWrite"]}'),
  ('calendar.decline', 'calendar', 'calendar.decline', true, 'reaccept', 'calendar',
   'Undo re-accepts the invitation; the organiser has already seen the decline note.',
   '{"google":["https://www.googleapis.com/auth/calendar.events"],"microsoft":["Calendars.ReadWrite"]}'),
  ('appointment.book', 'appointment', 'appointment.book', false, 'none', 'email',
   'Can''t undo: the request was emailed. Reply to the provider to cancel.',
   '{"google":["https://www.googleapis.com/auth/gmail.send"],"microsoft":["Mail.Send"]}'),
  ('subscription.cancel', 'subscription', 'subscription.cancel', false, 'none', 'email',
   'Can''t undo: the cancellation was emailed. Re-subscribing would spend money, so APM never does it.',
   '{"google":["https://www.googleapis.com/auth/gmail.send"],"microsoft":["Mail.Send"]}');

alter table public.autopilot_action_classes
  alter column connector_kind set not null,
  alter column undo_label set not null,
  add constraint autopilot_action_classes_class_key_check check (class_key in (
    'calendar.create','email.draft','email.send','calendar.reschedule','calendar.decline','appointment.book','subscription.cancel')),
  add constraint autopilot_action_classes_domain_check check (domain in ('calendar','email','appointment','subscription')),
  add constraint autopilot_action_classes_connector_check check (connector_kind in ('calendar','email')),
  add constraint autopilot_action_classes_undo_method_check check (undo_method in ('delete_event','delete_draft','restore_time','reaccept','none')),
  add constraint autopilot_action_classes_reversible_check check (reversible = (undo_method <> 'none')),
  add constraint autopilot_action_classes_undo_label_check check (char_length(undo_label) between 10 and 200),
  add constraint autopilot_action_classes_key_shape_check check (class_key = domain || '.' || split_part(action_type, '.', 2) and class_key = action_type),
  add constraint autopilot_action_classes_activation_check check (activation_status = 'inactive' or (evidence_ref is not null and activated_at is not null));

-- ---------------------------------------------------------------------------
-- 2. Execution ledger: what was targeted, so undo and caps are server-derived
-- ---------------------------------------------------------------------------

alter table public.autopilot_executions
  add column target_ref text check (target_ref is null or char_length(target_ref) <= 500),
  add column original_starts_at timestamptz,
  add column original_ends_at timestamptz,
  add column recipient text check (recipient is null or char_length(recipient) <= 320);
create index autopilot_executions_target_idx on public.autopilot_executions(user_id, action_class, target_ref) where target_ref is not null;
create index autopilot_executions_recipient_idx on public.autopilot_executions(user_id, rule_id, local_day, recipient) where recipient is not null;

-- ---------------------------------------------------------------------------
-- 3. Events the user marked flexible. Kept apart from calendar_events because a
--    sync replaces that snapshot; the mark survives re-sync by provider id.
-- ---------------------------------------------------------------------------

create table public.autopilot_flexible_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (char_length(provider) between 1 and 40),
  external_event_id text not null check (char_length(external_event_id) between 1 and 500),
  marked_at timestamptz not null default now(),
  primary key (user_id, provider, external_event_id)
);
alter table public.autopilot_flexible_events enable row level security;
revoke all on table public.autopilot_flexible_events from anon;
revoke insert, update, delete, truncate, references, trigger on table public.autopilot_flexible_events from authenticated;
grant select on table public.autopilot_flexible_events to authenticated;
create policy autopilot_flexible_events_select_autopilot
  on public.autopilot_flexible_events for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_autopilot_access((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 4. Constraint validation (the shapes are the whole contract)
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_weekdays(p_value jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_day jsonb;
  v_days integer[] := '{}';
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) not between 1 and 7 then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  for v_day in select value from jsonb_array_elements(p_value) loop
    v_days := v_days || private.apm_autopilot_int(v_day, 1, 7);
  end loop;
  if (select count(distinct d) from unnest(v_days) d) <> cardinality(v_days) then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  return (select jsonb_agg(d order by d) from unnest(v_days) d);
end;
$$;

-- A list of short lower-case strings (keywords, appointment types).
create or replace function private.apm_autopilot_text_list(p_value jsonb, p_min integer, p_max integer, p_max_len integer, p_lower boolean)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_out text[] := '{}';
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) not between p_min and p_max then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(v_item) <> 'string' then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    v_text := btrim(v_item #>> '{}');
    if p_lower then v_text := lower(v_text); end if;
    if char_length(v_text) not between 1 and p_max_len or v_text ~ '[[:cntrl:]]' then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    v_out := v_out || v_text;
  end loop;
  return coalesce((select jsonb_agg(distinct t) from unnest(v_out) t), '[]'::jsonb);
end;
$$;

create or replace function private.apm_autopilot_domain_list(p_value jsonb, p_min integer, p_max integer)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_domain jsonb;
  v_out text[] := '{}';
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) not between p_min and p_max then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  for v_domain in select value from jsonb_array_elements(p_value) loop
    if jsonb_typeof(v_domain) <> 'string'
       or char_length(v_domain #>> '{}') > 253
       or (v_domain #>> '{}') !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    v_out := v_out || (v_domain #>> '{}');
  end loop;
  return coalesce((select jsonb_agg(distinct d) from unnest(v_out) d), '[]'::jsonb);
end;
$$;

-- One lower-case mailbox, no display name, no list, no header characters.
create or replace function private.apm_autopilot_address(p_value jsonb, p_error text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    raise exception '%', p_error using errcode = '22023';
  end if;
  v := lower(btrim(p_value #>> '{}'));
  if char_length(v) > 320 or v ~ '[[:cntrl:]]'
     or v !~ '^[^@\s,;<>"()]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception '%', p_error using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Never carry payment data: a run of 13+ digits (card-number shaped, spaces or
-- dashes allowed) anywhere in outgoing text is refused.
create or replace function private.apm_autopilot_refuse_payment_data(p_text text)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_text is not null and p_text ~ '([0-9][ -]?){13,}' then
    raise exception 'autopilot_payment_data_refused' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.apm_autopilot_check_window(p_constraints jsonb, p_out jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_start time := private.apm_autopilot_hhmm(p_constraints->'windowStart');
  v_end time := private.apm_autopilot_hhmm(p_constraints->'windowEnd');
begin
  if v_end <= v_start then
    raise exception 'autopilot_invalid_constraints' using errcode = '22023';
  end if;
  return p_out || jsonb_build_object(
    'timezone', private.apm_autopilot_timezone(p_constraints->'timezone'),
    'weekdays', private.apm_autopilot_weekdays(p_constraints->'weekdays'),
    'windowStart', p_constraints->'windowStart',
    'windowEnd', p_constraints->'windowEnd'
  );
end;
$$;

-- Event-selection criteria shared by reschedule and decline.
create or replace function private.apm_autopilot_check_criteria(p_constraints jsonb)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object(
    'matchTitleKeywords', private.apm_autopilot_text_list(p_constraints->'matchTitleKeywords', 0, 10, 60, true),
    'maxAttendees', private.apm_autopilot_int(p_constraints->'maxAttendees', 0, 50),
    'protectedTitleKeywords', private.apm_autopilot_text_list(p_constraints->'protectedTitleKeywords', 0, 10, 60, true)
  );
end;
$$;

create or replace function private.apm_autopilot_check_constraints(p_class text, p_constraints jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb;
  v_item jsonb;
  v_list jsonb := '[]'::jsonb;
  v_ids text[] := '{}';
  v_kinds jsonb;
  v_duration integer;
  v_window_minutes integer;
begin
  if p_class = 'calendar.create' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxDurationMinutes','maxPerDay','horizonDays','collision'],
      array['timezone','weekdays','windowStart','windowEnd','maxDurationMinutes','maxPerDay','horizonDays','collision'],
      'autopilot_invalid_constraints');
    v_out := private.apm_autopilot_check_window(p_constraints, '{}'::jsonb);
    v_window_minutes := (extract(epoch from ((v_out->>'windowEnd')::time - (v_out->>'windowStart')::time)) / 60)::integer;
    v_duration := private.apm_autopilot_int(p_constraints->'maxDurationMinutes', 15, 240);
    if v_duration > v_window_minutes or p_constraints->'collision' <> to_jsonb('never_overlap_busy'::text) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return v_out || jsonb_build_object(
      'maxDurationMinutes', v_duration,
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 10),
      'horizonDays', private.apm_autopilot_int(p_constraints->'horizonDays', 1, 30),
      'collision', 'never_overlap_busy');

  elsif p_class = 'email.draft' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','allowedRecipientDomains'],
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','allowedRecipientDomains'],
      'autopilot_invalid_constraints');
    return private.apm_autopilot_check_window(p_constraints, '{}'::jsonb) || jsonb_build_object(
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 20),
      'allowedRecipientDomains', private.apm_autopilot_domain_list(p_constraints->'allowedRecipientDomains', 1, 10));

  elsif p_class = 'email.send' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','maxPerRecipientPerDay','allowedKinds','allowedRecipients','allowedRecipientDomains','templates'],
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','maxPerRecipientPerDay','allowedKinds','allowedRecipients','allowedRecipientDomains','templates'],
      'autopilot_invalid_constraints');
    v_kinds := private.apm_autopilot_text_list(p_constraints->'allowedKinds', 1, 4, 40, false);
    if exists (select 1 from jsonb_array_elements_text(v_kinds) k where k not in ('scheduling_reply','follow_up','confirmation','template')) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    if jsonb_typeof(p_constraints->'allowedRecipients') <> 'array' or jsonb_array_length(p_constraints->'allowedRecipients') > 25 then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(p_constraints->'allowedRecipients') loop
      v_list := v_list || to_jsonb(private.apm_autopilot_address(v_item, 'autopilot_invalid_constraints'));
    end loop;
    v_out := private.apm_autopilot_check_window(p_constraints, '{}'::jsonb) || jsonb_build_object(
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 20),
      'maxPerRecipientPerDay', private.apm_autopilot_int(p_constraints->'maxPerRecipientPerDay', 1, 3),
      'allowedKinds', v_kinds,
      'allowedRecipients', coalesce((select jsonb_agg(distinct r) from jsonb_array_elements_text(v_list) r), '[]'::jsonb),
      'allowedRecipientDomains', private.apm_autopilot_domain_list(p_constraints->'allowedRecipientDomains', 0, 10));
    if jsonb_array_length(v_out->'allowedRecipients') + jsonb_array_length(v_out->'allowedRecipientDomains') = 0 then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    -- Pre-approved templates: the user writes the exact subject and body.
    if jsonb_typeof(p_constraints->'templates') <> 'array' or jsonb_array_length(p_constraints->'templates') > 10 then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    v_list := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(p_constraints->'templates') loop
      perform private.apm_autopilot_check_keys(v_item, array['id','label','subject','body'], array['id','label','subject','body'], 'autopilot_invalid_constraints');
      if jsonb_typeof(v_item->'id') <> 'string' or (v_item->>'id') !~ '^[a-z0-9_-]{1,40}$'
         or jsonb_typeof(v_item->'label') <> 'string' or char_length(btrim(v_item->>'label')) not between 1 and 80 or (v_item->>'label') ~ '[[:cntrl:]]'
         or jsonb_typeof(v_item->'subject') <> 'string' or char_length(btrim(v_item->>'subject')) not between 1 and 300 or (v_item->>'subject') ~ '[[:cntrl:]]'
         or jsonb_typeof(v_item->'body') <> 'string' or char_length(v_item->>'body') not between 1 and 5000
         or (v_item->>'id') = any (v_ids) then
        raise exception 'autopilot_invalid_constraints' using errcode = '22023';
      end if;
      perform private.apm_autopilot_refuse_payment_data((v_item->>'subject') || ' ' || (v_item->>'body'));
      v_ids := v_ids || (v_item->>'id');
      v_list := v_list || jsonb_build_object('id', v_item->'id', 'label', btrim(v_item->>'label'), 'subject', btrim(v_item->>'subject'), 'body', v_item->'body');
    end loop;
    if (v_kinds ? 'template') <> (jsonb_array_length(v_list) > 0) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return v_out || jsonb_build_object('templates', v_list);

  elsif p_class = 'calendar.reschedule' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','maxShiftDays','collision','matchTitleKeywords','maxAttendees','protectedTitleKeywords'],
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','maxShiftDays','collision','matchTitleKeywords','maxAttendees','protectedTitleKeywords'],
      'autopilot_invalid_constraints');
    if p_constraints->'collision' <> to_jsonb('never_overlap_busy'::text) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return private.apm_autopilot_check_window(p_constraints, private.apm_autopilot_check_criteria(p_constraints)) || jsonb_build_object(
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 10),
      'horizonDays', private.apm_autopilot_int(p_constraints->'horizonDays', 1, 30),
      'maxShiftDays', private.apm_autopilot_int(p_constraints->'maxShiftDays', 0, 7),
      'collision', 'never_overlap_busy');

  elsif p_class = 'calendar.decline' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','maxPerDay','horizonDays','boundaries','declineNote','matchTitleKeywords','maxAttendees','protectedTitleKeywords'],
      array['timezone','maxPerDay','horizonDays','boundaries','matchTitleKeywords','maxAttendees','protectedTitleKeywords'],
      'autopilot_invalid_constraints');
    if jsonb_typeof(p_constraints->'boundaries') <> 'array' or jsonb_array_length(p_constraints->'boundaries') not between 1 and 10 then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(p_constraints->'boundaries') loop
      perform private.apm_autopilot_check_keys(v_item, array['weekdays','start','end'], array['weekdays','start','end'], 'autopilot_invalid_constraints');
      if private.apm_autopilot_hhmm(v_item->'end') <= private.apm_autopilot_hhmm(v_item->'start') then
        raise exception 'autopilot_invalid_constraints' using errcode = '22023';
      end if;
      v_list := v_list || jsonb_build_object('weekdays', private.apm_autopilot_weekdays(v_item->'weekdays'), 'start', v_item->'start', 'end', v_item->'end');
    end loop;
    if p_constraints ? 'declineNote' and (jsonb_typeof(p_constraints->'declineNote') <> 'string'
       or char_length(btrim(p_constraints->>'declineNote')) not between 10 and 500 or (p_constraints->>'declineNote') ~ '[[:cntrl:]]') then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return private.apm_autopilot_check_criteria(p_constraints) || jsonb_build_object(
      'timezone', private.apm_autopilot_timezone(p_constraints->'timezone'),
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 10),
      'horizonDays', private.apm_autopilot_int(p_constraints->'horizonDays', 1, 30),
      'boundaries', v_list,
      'declineNote', coalesce(btrim(p_constraints->>'declineNote'),
        'Thank you for the invitation. This time falls outside the hours I keep for meetings, so I won''t be able to join. I''m happy to find another time.'));

  elsif p_class = 'appointment.book' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','providers'],
      array['timezone','weekdays','windowStart','windowEnd','maxPerDay','horizonDays','providers'],
      'autopilot_invalid_constraints');
    if jsonb_typeof(p_constraints->'providers') <> 'array' or jsonb_array_length(p_constraints->'providers') not between 1 and 10 then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(p_constraints->'providers') loop
      perform private.apm_autopilot_check_keys(v_item, array['email','label','category','appointmentTypes'], array['email','label','category','appointmentTypes'], 'autopilot_invalid_constraints');
      if jsonb_typeof(v_item->'label') <> 'string' or char_length(btrim(v_item->>'label')) not between 1 and 80 or (v_item->>'label') ~ '[[:cntrl:]]'
         or jsonb_typeof(v_item->'category') <> 'string'
         or (v_item->>'category') not in ('medical','dental','vision','therapy','vet','personal_care','auto','home','other') then
        raise exception 'autopilot_invalid_constraints' using errcode = '22023';
      end if;
      v_list := v_list || jsonb_build_object(
        'email', private.apm_autopilot_address(v_item->'email', 'autopilot_invalid_constraints'),
        'label', btrim(v_item->>'label'),
        'category', v_item->'category',
        'appointmentTypes', private.apm_autopilot_text_list(v_item->'appointmentTypes', 1, 5, 80, false));
    end loop;
    if (select count(distinct p->>'email') from jsonb_array_elements(v_list) p) <> jsonb_array_length(v_list) then
      raise exception 'autopilot_invalid_constraints' using errcode = '22023';
    end if;
    return private.apm_autopilot_check_window(p_constraints, '{}'::jsonb) || jsonb_build_object(
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 3),
      'horizonDays', private.apm_autopilot_int(p_constraints->'horizonDays', 1, 60),
      'providers', v_list);

  elsif p_class = 'subscription.cancel' then
    perform private.apm_autopilot_check_keys(p_constraints,
      array['timezone','maxPerDay','allowedProviderDomains'],
      array['timezone','maxPerDay','allowedProviderDomains'],
      'autopilot_invalid_constraints');
    return jsonb_build_object(
      'timezone', private.apm_autopilot_timezone(p_constraints->'timezone'),
      'maxPerDay', private.apm_autopilot_int(p_constraints->'maxPerDay', 1, 5),
      'allowedProviderDomains', private.apm_autopilot_domain_list(p_constraints->'allowedProviderDomains', 1, 10));
  end if;
  raise exception 'autopilot_unsupported_action_class' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Shared claim checks
-- ---------------------------------------------------------------------------

-- The connection must be the user's own, connected, of the class's connector
-- kind, and carry the provider write scope the class needs (connecting a read
-- capability never implies a write one — docs/22).
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
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(v_class.required_scopes->v_ic.provider, '[]'::jsonb)) s
    where not (s = any (coalesce(v_ic.scopes, '{}'::text[])))
  ) then
    raise exception 'autopilot_connector_scope_missing' using errcode = '42501';
  end if;
  return v_conn;
end;
$$;

-- now() inside the rule's weekday/window (for sends that happen immediately).
create or replace function private.apm_autopilot_now_in_window(p_c jsonb)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_local timestamp := now() at time zone (p_c->>'timezone');
begin
  if not (extract(isodow from v_local)::integer in (select (jsonb_array_elements_text(p_c->'weekdays'))::integer))
     or v_local::time < (p_c->>'windowStart')::time
     or date_trunc('minute', v_local)::time > (p_c->>'windowEnd')::time then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  return v_local::date;
end;
$$;

-- A future slot on one local day, on a rule weekday, inside the rule window,
-- within the horizon; returns the local day.
create or replace function private.apm_autopilot_slot_in_window(p_c jsonb, p_starts timestamptz, p_ends timestamptz)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := p_c->>'timezone';
  v_ls timestamp := p_starts at time zone v_tz;
  v_le timestamp := p_ends at time zone v_tz;
begin
  if p_ends <= p_starts then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  if p_starts <= now() or p_starts > now() + make_interval(days => (p_c->>'horizonDays')::integer)
     or v_le::date <> v_ls::date
     or not (extract(isodow from v_ls)::integer in (select (jsonb_array_elements_text(p_c->'weekdays'))::integer))
     or v_ls::time < (p_c->>'windowStart')::time
     or v_le::time > (p_c->>'windowEnd')::time then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  return v_ls::date;
end;
$$;

-- Busy time: any non-free, non-deleted event (optionally ignoring one event)
-- or another live Autopilot slot.
create or replace function private.apm_autopilot_slot_busy(p_user_id uuid, p_starts timestamptz, p_ends timestamptz, p_ignore_event uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.calendar_events ce
    where ce.user_id = p_user_id and not ce.deleted and ce.availability <> 'free'
      and ce.starts_at < p_ends and ce.ends_at > p_starts
      and (p_ignore_event is null or ce.id <> p_ignore_event)
  ) or exists (
    select 1 from public.autopilot_executions e
    where e.user_id = p_user_id and e.status in ('claimed','verified')
      and e.proposed_starts_at < p_ends and e.proposed_ends_at > p_starts
  ) or exists (
    select 1 from public.personal_os p
    where p.user_id = p_user_id and p.active_mode = 'deep_work'
      and p.mode_started_at < p_ends and p.mode_ends_at > p_starts
  );
$$;

-- Protected blocks are never moved or declined: Deep Work / focus / foreground
-- by title (plus the rule's own protected keywords), anything overlapping a
-- declared Deep Work session, and the routine blocks Autopilot itself created.
create or replace function private.apm_autopilot_event_protected(p_user_id uuid, p_event public.calendar_events, p_c jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select lower(p_event.title) ~ '(deep[ -]?work|focus|foreground)'
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

-- Eligible = the user marked it flexible, or it matches the rule's criteria
-- (a title keyword AND no more attendees than the rule allows).
create or replace function private.apm_autopilot_event_eligible(p_user_id uuid, p_event public.calendar_events, p_c jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.autopilot_flexible_events f
      where f.user_id = p_user_id and f.provider = p_event.provider and f.external_event_id = p_event.external_event_id
    )
    or (
      exists (
        select 1 from jsonb_array_elements_text(coalesce(p_c->'matchTitleKeywords', '[]'::jsonb)) k
        where position(k in lower(p_event.title)) > 0
      )
      and (case when jsonb_typeof(p_event.attendees) = 'array' then jsonb_array_length(p_event.attendees) else 0 end) <= (p_c->>'maxAttendees')::integer
    );
$$;

-- The user's own calendar event, future, within horizon, from a write-capable
-- connection, not already targeted by a live move/decline.
create or replace function private.apm_autopilot_target_event(p_user_id uuid, p_c jsonb, p_payload jsonb, p_class text)
returns public.calendar_events
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ev public.calendar_events;
begin
  begin
    v_id := (p_payload->>'eventId')::uuid;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  select * into v_ev from public.calendar_events ce
  where ce.id = v_id and ce.user_id = p_user_id and not ce.deleted and ce.provider in ('google','microsoft');
  if not found or v_ev.connection_id is null then
    raise exception 'autopilot_event_not_found' using errcode = 'P0002';
  end if;
  perform private.apm_autopilot_require_connection(p_user_id, to_jsonb(v_ev.connection_id::text), p_class);
  if v_ev.all_day or v_ev.starts_at <= now() or v_ev.starts_at > now() + make_interval(days => (p_c->>'horizonDays')::integer) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  if private.apm_autopilot_event_protected(p_user_id, v_ev, p_c) then
    raise exception 'autopilot_event_protected' using errcode = '42501';
  end if;
  if not private.apm_autopilot_event_eligible(p_user_id, v_ev, p_c) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.autopilot_executions e
    where e.user_id = p_user_id and e.action_class in ('calendar.reschedule','calendar.decline')
      and e.target_ref = v_ev.external_event_id and e.status in ('claimed','verified')
  ) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  return v_ev;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Per-class proposal checks. Each returns the server-derived execution facts
--    and the exact content the Worker may send (`composed`). The Worker never
--    sends client-supplied ids or text that the database has not composed.
-- ---------------------------------------------------------------------------

create or replace function private.apm_autopilot_prepare_calendar_create(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_starts timestamptz;
  v_ends timestamptz;
  v_day date;
begin
  perform private.apm_autopilot_check_keys(p_payload,
    array['connectionId','title','startsAt','endsAt','location'],
    array['connectionId','title','startsAt','endsAt'],
    'autopilot_invalid_payload');
  if jsonb_typeof(p_payload->'title') <> 'string' or char_length(btrim(p_payload->>'title')) not between 1 and 200
     or (p_payload ? 'location' and (jsonb_typeof(p_payload->'location') <> 'string' or char_length(p_payload->>'location') > 300)) then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  begin
    v_starts := (p_payload->>'startsAt')::timestamptz;
    v_ends := (p_payload->>'endsAt')::timestamptz;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  if v_ends <= v_starts then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  if v_ends - v_starts > make_interval(mins => (p_c->>'maxDurationMinutes')::integer) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_day := private.apm_autopilot_slot_in_window(p_c, v_starts, v_ends);
  if private.apm_autopilot_slot_busy(p_user_id, v_starts, v_ends, null) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  perform private.apm_autopilot_require_connection(p_user_id, p_payload->'connectionId', 'calendar.create');
  return jsonb_build_object('localDay', v_day, 'startsAt', v_starts, 'endsAt', v_ends,
    'composed', jsonb_build_object('title', btrim(p_payload->>'title'), 'startsAt', v_starts, 'endsAt', v_ends,
      'location', p_payload->'location'));
end;
$$;

create or replace function private.apm_autopilot_prepare_email_draft(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to text;
  v_day date;
begin
  perform private.apm_autopilot_check_keys(p_payload,
    array['connectionId','to','subject','body'],
    array['connectionId','to','subject','body'],
    'autopilot_invalid_payload');
  if jsonb_typeof(p_payload->'subject') <> 'string' or jsonb_typeof(p_payload->'body') <> 'string'
     or char_length(btrim(p_payload->>'subject')) not between 1 and 300
     or (p_payload->>'subject') ~ '[[:cntrl:]]'
     or char_length(p_payload->>'body') > 10000 then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  v_to := private.apm_autopilot_address(p_payload->'to', 'autopilot_invalid_payload');
  if not (p_c->'allowedRecipientDomains' ? split_part(v_to, '@', 2)) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_day := private.apm_autopilot_now_in_window(p_c);
  perform private.apm_autopilot_require_connection(p_user_id, p_payload->'connectionId', 'email.draft');
  return jsonb_build_object('localDay', v_day, 'recipient', v_to,
    'composed', jsonb_build_object('to', v_to, 'subject', btrim(p_payload->>'subject'), 'body', p_payload->'body'));
end;
$$;

create or replace function private.apm_autopilot_prepare_email_send(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_to text;
  v_conn uuid;
  v_subject text;
  v_body text;
  v_template jsonb;
  v_ref uuid;
  v_day date;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or jsonb_typeof(p_payload->'kind') <> 'string' then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  v_kind := p_payload->>'kind';
  if v_kind = 'template' then
    perform private.apm_autopilot_check_keys(p_payload, array['connectionId','kind','to','templateId'], array['connectionId','kind','to','templateId'], 'autopilot_invalid_payload');
  elsif v_kind = 'follow_up' then
    perform private.apm_autopilot_check_keys(p_payload, array['connectionId','kind','to','subject','body','commitmentId'], array['connectionId','kind','to','subject','body','commitmentId'], 'autopilot_invalid_payload');
  elsif v_kind in ('scheduling_reply','confirmation') then
    perform private.apm_autopilot_check_keys(p_payload, array['connectionId','kind','to','subject','body','sourceSignalId'], array['connectionId','kind','to','subject','body','sourceSignalId'], 'autopilot_invalid_payload');
  else
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  if not (p_c->'allowedKinds' ? v_kind) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;

  v_to := private.apm_autopilot_address(p_payload->'to', 'autopilot_invalid_payload');
  if not (p_c->'allowedRecipients' ? v_to or p_c->'allowedRecipientDomains' ? split_part(v_to, '@', 2)) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_conn := private.apm_autopilot_require_connection(p_user_id, p_payload->'connectionId', 'email.send');

  if v_kind = 'template' then
    select t into v_template from jsonb_array_elements(p_c->'templates') t where t->>'id' = p_payload->>'templateId';
    if v_template is null then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    v_subject := v_template->>'subject';
    v_body := v_template->>'body';
  else
    if jsonb_typeof(p_payload->'subject') <> 'string' or jsonb_typeof(p_payload->'body') <> 'string'
       or char_length(btrim(p_payload->>'subject')) not between 1 and 300
       or (p_payload->>'subject') ~ '[[:cntrl:]]'
       or char_length(btrim(p_payload->>'body')) not between 1 and 5000 then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    v_subject := btrim(p_payload->>'subject');
    v_body := p_payload->>'body';
    begin
      v_ref := (coalesce(p_payload->>'commitmentId', p_payload->>'sourceSignalId'))::uuid;
    exception when others then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end;
    if v_kind = 'follow_up' then
      -- A chaser is only for something someone else owes the user, still open.
      if not exists (
        select 1 from public.commitments cm
        where cm.id = v_ref and cm.user_id = p_user_id and cm.owner = 'other'
          and cm.status not in ('executed','verified','closed','dismissed')
      ) then
        raise exception 'autopilot_outside_rule' using errcode = '42501';
      end if;
    else
      -- Scheduling replies and confirmations answer a scheduling message that
      -- arrived on this same mailbox.
      if not exists (
        select 1 from public.message_signals ms
        where ms.id = v_ref and ms.user_id = p_user_id and ms.connection_id = v_conn
          and ms.signal_type = any (case when v_kind = 'scheduling_reply'
            then array['meeting','request','cancellation'] else array['meeting','request','commitment'] end)
      ) then
        raise exception 'autopilot_outside_rule' using errcode = '42501';
      end if;
    end if;
  end if;
  perform private.apm_autopilot_refuse_payment_data(v_subject || ' ' || v_body);
  v_day := private.apm_autopilot_now_in_window(p_c);
  return jsonb_build_object('localDay', v_day, 'recipient', v_to,
    'composed', jsonb_build_object('to', v_to, 'subject', v_subject, 'body', v_body, 'kind', v_kind));
end;
$$;

create or replace function private.apm_autopilot_prepare_calendar_reschedule(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ev public.calendar_events;
  v_starts timestamptz;
  v_ends timestamptz;
  v_day date;
  v_others integer;
begin
  perform private.apm_autopilot_check_keys(p_payload, array['eventId','startsAt','endsAt'], array['eventId','startsAt','endsAt'], 'autopilot_invalid_payload');
  begin
    v_starts := (p_payload->>'startsAt')::timestamptz;
    v_ends := (p_payload->>'endsAt')::timestamptz;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  v_ev := private.apm_autopilot_target_event(p_user_id, p_c, p_payload, 'calendar.reschedule');
  -- Only the user's own meetings (organiser) or solo blocks may be moved.
  v_others := case when jsonb_typeof(v_ev.attendees) = 'array'
    then (select count(*) from jsonb_array_elements(v_ev.attendees) a where coalesce(a->>'self', 'false') <> 'true') else 0 end;
  if v_others > 0 and coalesce(v_ev.organizer->>'self', 'false') <> 'true' then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  if v_ends - v_starts <> v_ev.ends_at - v_ev.starts_at
     or abs(extract(epoch from (v_starts - v_ev.starts_at))) > ((p_c->>'maxShiftDays')::integer * 86400 + 86399)
     or v_starts = v_ev.starts_at then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_day := private.apm_autopilot_slot_in_window(p_c, v_starts, v_ends);
  if private.apm_autopilot_slot_busy(p_user_id, v_starts, v_ends, v_ev.id) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  return jsonb_build_object('localDay', v_day, 'startsAt', v_starts, 'endsAt', v_ends,
    'targetRef', v_ev.external_event_id, 'originalStartsAt', v_ev.starts_at, 'originalEndsAt', v_ev.ends_at,
    'connectionId', v_ev.connection_id,
    'composed', jsonb_build_object('externalEventId', v_ev.external_event_id, 'title', v_ev.title,
      'startsAt', v_starts, 'endsAt', v_ends, 'originalStartsAt', v_ev.starts_at, 'originalEndsAt', v_ev.ends_at));
end;
$$;

create or replace function private.apm_autopilot_prepare_calendar_decline(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ev public.calendar_events;
  v_tz text := p_c->>'timezone';
  v_ls timestamp;
  v_le timestamp;
begin
  perform private.apm_autopilot_check_keys(p_payload, array['eventId'], array['eventId'], 'autopilot_invalid_payload');
  v_ev := private.apm_autopilot_target_event(p_user_id, p_c, p_payload, 'calendar.decline');
  -- Never decline the user's own meeting; only an invitation from someone else.
  if coalesce(v_ev.organizer->>'self', 'false') = 'true'
     or jsonb_typeof(v_ev.attendees) <> 'array' or jsonb_array_length(v_ev.attendees) = 0 then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_ls := v_ev.starts_at at time zone v_tz;
  v_le := v_ev.ends_at at time zone v_tz;
  -- Decline only what violates a boundary the user declared in this rule.
  if v_le::date <> v_ls::date or not exists (
    select 1 from jsonb_array_elements(p_c->'boundaries') b
    where extract(isodow from v_ls)::integer in (select (jsonb_array_elements_text(b->'weekdays'))::integer)
      and v_ls::time < (b->>'end')::time and v_le::time > (b->>'start')::time
  ) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  return jsonb_build_object('localDay', (now() at time zone v_tz)::date,
    'targetRef', v_ev.external_event_id, 'originalStartsAt', v_ev.starts_at, 'originalEndsAt', v_ev.ends_at,
    'connectionId', v_ev.connection_id,
    'composed', jsonb_build_object('externalEventId', v_ev.external_event_id, 'title', v_ev.title, 'note', p_c->>'declineNote'));
end;
$$;

create or replace function private.apm_autopilot_prepare_appointment_book(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_provider jsonb;
  v_email text;
  v_type text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_day date;
  v_tz text := p_c->>'timezone';
  v_signal uuid;
  v_stop text;
begin
  perform private.apm_autopilot_check_keys(p_payload,
    array['connectionId','providerEmail','appointmentType','startsAt','endsAt','paymentRequired','sourceSignalId'],
    array['connectionId','providerEmail','appointmentType','startsAt','endsAt','paymentRequired'],
    'autopilot_invalid_payload');
  if jsonb_typeof(p_payload->'paymentRequired') <> 'boolean' or jsonb_typeof(p_payload->'appointmentType') <> 'string' then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  v_email := private.apm_autopilot_address(p_payload->'providerEmail', 'autopilot_invalid_payload');
  select p into v_provider from jsonb_array_elements(p_c->'providers') p where p->>'email' = v_email;
  v_type := btrim(p_payload->>'appointmentType');
  if v_provider is null or not (v_provider->'appointmentTypes' ? v_type) then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  begin
    v_starts := (p_payload->>'startsAt')::timestamptz;
    v_ends := (p_payload->>'endsAt')::timestamptz;
    v_signal := (p_payload->>'sourceSignalId')::uuid;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  if v_ends - v_starts > interval '4 hours' then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  v_day := private.apm_autopilot_slot_in_window(p_c, v_starts, v_ends);
  if private.apm_autopilot_slot_busy(p_user_id, v_starts, v_ends, null) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  perform private.apm_autopilot_require_connection(p_user_id, p_payload->'connectionId', 'appointment.book');
  if v_signal is not null and not exists (
    select 1 from public.message_signals ms where ms.id = v_signal and ms.user_id = p_user_id
  ) then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;

  -- FREE bookings only. A declared payment, or a booking message that mentions
  -- a card, deposit, prepayment or fee, stops the run: it becomes a prepared
  -- Life OS action for the user, never an automatic booking.
  if (p_payload->>'paymentRequired')::boolean or exists (
    select 1 from public.message_signals ms
    where ms.id = v_signal and ms.user_id = p_user_id
      and lower(ms.summary) ~ '(card|deposit|prepay|pre-pay|payment|pay now|fee|charge|\$|£|€)'
  ) then
    v_stop := 'payment_required';
  end if;

  return jsonb_build_object('localDay', v_day, 'startsAt', v_starts, 'endsAt', v_ends, 'recipient', v_email, 'stop', v_stop,
    'stopTitle', 'Book ' || v_type || ' with ' || (v_provider->>'label') || ' — it asks for payment, so it is yours to decide',
    'composed', jsonb_build_object(
      'to', v_email,
      'subject', 'Appointment request: ' || v_type,
      'body', 'Hello ' || (v_provider->>'label') || E',\n\n'
        || 'I would like to book a ' || v_type || ' appointment on '
        || to_char(v_starts at time zone v_tz, 'FMDay DD FMMonth YYYY "at" HH24:MI') || ' (' || v_tz || '). '
        || E'If that time is not available, please reply with the nearest free time.\n\n'
        || E'I can only accept a booking that needs no payment, card or deposit in advance.\n\n'
        || 'Thank you.',
      'appointmentType', v_type, 'providerLabel', v_provider->>'label', 'category', v_provider->>'category'));
end;
$$;

create or replace function private.apm_autopilot_prepare_subscription_cancel(p_user_id uuid, p_c jsonb, p_payload jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.life_admin_items;
  v_item_id uuid;
  v_email text;
  v_ref text;
  v_title text;
  v_stop text;
begin
  perform private.apm_autopilot_check_keys(p_payload,
    array['connectionId','lifeAdminItemId','route','cancelEmail','accountRef'],
    array['connectionId','lifeAdminItemId','route'],
    'autopilot_invalid_payload');
  if jsonb_typeof(p_payload->'route') <> 'string' or (p_payload->>'route') not in ('email','web') then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end if;
  begin
    v_item_id := (p_payload->>'lifeAdminItemId')::uuid;
  exception when others then
    raise exception 'autopilot_invalid_payload' using errcode = '22023';
  end;
  select * into v_item from public.life_admin_items i
  where i.id = v_item_id and i.user_id = p_user_id and i.kind = 'subscription' and i.status not in ('completed','cancelled');
  if not found then
    raise exception 'autopilot_outside_rule' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.autopilot_executions e
    where e.user_id = p_user_id and e.action_class = 'subscription.cancel'
      and e.target_ref = v_item.id::text and e.status in ('claimed','verified')
  ) then
    raise exception 'autopilot_collision' using errcode = '42501';
  end if;
  if p_payload ? 'accountRef' then
    if jsonb_typeof(p_payload->'accountRef') <> 'string' or char_length(btrim(p_payload->>'accountRef')) not between 1 and 120
       or (p_payload->>'accountRef') ~ '[[:cntrl:]]' then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    v_ref := btrim(p_payload->>'accountRef');
    perform private.apm_autopilot_refuse_payment_data(v_ref);
  end if;
  v_title := left(regexp_replace(v_item.title, '[[:cntrl:]]+', ' ', 'g'), 120);

  if p_payload->>'route' = 'web' then
    -- No emailed route: APM prepares the cancellation for the user to finish;
    -- it never logs in, fills a provider form or touches payment settings.
    if p_payload ? 'cancelEmail' then
      raise exception 'autopilot_invalid_payload' using errcode = '22023';
    end if;
    v_stop := 'needs_user';
  else
    v_email := private.apm_autopilot_address(p_payload->'cancelEmail', 'autopilot_invalid_payload');
    if not (p_c->'allowedProviderDomains' ? split_part(v_email, '@', 2)) then
      raise exception 'autopilot_outside_rule' using errcode = '42501';
    end if;
    perform private.apm_autopilot_require_connection(p_user_id, p_payload->'connectionId', 'subscription.cancel');
  end if;

  return jsonb_build_object('localDay', (now() at time zone (p_c->>'timezone'))::date, 'recipient', v_email,
    'targetRef', v_item.id::text, 'stop', v_stop,
    'stopTitle', 'Cancel "' || v_title || '" on the provider''s site — APM prepared it; it never logs in or touches payment',
    'composed', jsonb_build_object(
      'to', v_email,
      'subject', 'Cancellation request: ' || v_title,
      'body', E'Hello,\n\nPlease cancel my subscription "' || v_title || '"'
        || coalesce(' (account ' || v_ref || ')', '')
        || E' and stop all future charges. Please do not renew, upgrade or change the plan in any other way.\n\n'
        || E'Please confirm the cancellation by reply.\n\nThank you.',
      'itemTitle', v_title));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The claim: one authority check, then the class's own proposal check
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
  v_prep jsonb;
  v_local_day date;
  v_action public.actions;
  v_exec public.autopilot_executions;
  v_item_id uuid;
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

  -- Idempotent replay: same key, same rule, same proposal -> the original
  -- execution (or the original stopped, prepared action); never runs twice.
  select * into v_existing from public.autopilot_executions e
  where e.user_id = v_uid and e.idempotency_key = p_idempotency_key;
  if found then
    select * into v_existing_action from public.actions a where a.id = v_existing.action_id;
    if v_existing.rule_id <> p_rule_id or v_existing_action.id is null or (v_existing_action.payload - 'composed') <> p_payload then
      raise exception 'autopilot_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('replayed', true, 'execution', to_jsonb(v_existing), 'action', to_jsonb(v_existing_action));
  end if;
  select * into v_existing_action from public.actions a
  where a.user_id = v_uid and a.idempotency_key = 'autopilot:' || p_idempotency_key;
  if found then
    if v_existing_action.status = 'prepared' and v_existing_action.payload->'proposal' = p_payload
       and v_existing_action.payload->>'ruleId' = p_rule_id::text then
      return jsonb_build_object('replayed', true, 'stopped', v_existing_action.payload->>'stoppedReason', 'action', to_jsonb(v_existing_action));
    end if;
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
  v_prep := case v_class.class_key
    when 'calendar.create' then private.apm_autopilot_prepare_calendar_create(v_uid, v_c, p_payload)
    when 'email.draft' then private.apm_autopilot_prepare_email_draft(v_uid, v_c, p_payload)
    when 'email.send' then private.apm_autopilot_prepare_email_send(v_uid, v_c, p_payload)
    when 'calendar.reschedule' then private.apm_autopilot_prepare_calendar_reschedule(v_uid, v_c, p_payload)
    when 'calendar.decline' then private.apm_autopilot_prepare_calendar_decline(v_uid, v_c, p_payload)
    when 'appointment.book' then private.apm_autopilot_prepare_appointment_book(v_uid, v_c, p_payload)
    when 'subscription.cancel' then private.apm_autopilot_prepare_subscription_cancel(v_uid, v_c, p_payload)
  end;
  if v_prep is null then
    raise exception 'autopilot_unsupported_action_class' using errcode = '22023';
  end if;
  v_local_day := (v_prep->>'localDay')::date;

  -- A stop is not a run: it becomes a prepared action (and, for a booking, a Life
  -- OS appointment item) that needs the user. Nothing reaches a provider.
  if v_prep->>'stop' is not null then
    insert into public.actions (
      user_id, domain, action_type, status, payload, reason, permission_id,
      idempotency_key, requires_approval, updated_at
    ) values (
      v_uid, v_class.domain, v_class.action_type, 'prepared',
      jsonb_build_object('proposal', p_payload, 'ruleId', v_rule.id, 'stoppedReason', v_prep->>'stop', 'title', v_prep->>'stopTitle'),
      p_reason, v_permission_id, 'autopilot:' || p_idempotency_key, true, now()
    ) returning * into v_action;
    if v_class.class_key = 'appointment.book' then
      insert into public.life_admin_items (user_id, kind, title, status, importance, starts_at, ends_at, details, provenance_kind, source_type)
      values (v_uid, 'appointment', left(v_prep->>'stopTitle', 500), 'open', 3,
        (v_prep->>'startsAt')::timestamptz, (v_prep->>'endsAt')::timestamptz,
        jsonb_build_object('preparedActionId', v_action.id, 'stoppedReason', v_prep->>'stop'), 'inferred', 'system')
      returning id into v_item_id;
    end if;
    perform private.apm_autopilot_audit(
      v_uid, 'autopilot.execution_stopped', 'action', v_action.id,
      jsonb_build_object('actionClass', v_class.class_key, 'ruleId', v_rule.id, 'ruleVersion', v_rule.version,
        'reason', v_prep->>'stop', 'lifeAdminItemId', v_item_id),
      'system', 'autopilot_rule:' || v_rule.id::text
    );
    return jsonb_build_object('replayed', false, 'stopped', v_prep->>'stop', 'action', to_jsonb(v_action));
  end if;

  -- Rate rules: failed attempts do not count; claimed, verified and reverted do.
  if (
    select count(*) from public.autopilot_executions e
    where e.user_id = v_uid and e.rule_id = v_rule.id and e.local_day = v_local_day
      and e.status in ('claimed','verified','reverted')
  ) >= (v_c->>'maxPerDay')::integer then
    raise exception 'autopilot_rate_limited' using errcode = '42501';
  end if;
  if v_c ? 'maxPerRecipientPerDay' and (
    select count(*) from public.autopilot_executions e
    where e.user_id = v_uid and e.rule_id = v_rule.id and e.local_day = v_local_day
      and e.recipient = v_prep->>'recipient' and e.status in ('claimed','verified','reverted')
  ) >= (v_c->>'maxPerRecipientPerDay')::integer then
    raise exception 'autopilot_rate_limited' using errcode = '42501';
  end if;

  insert into public.actions (
    user_id, domain, action_type, status, payload, reason, permission_id,
    idempotency_key, requires_approval, approved_at, updated_at
  ) values (
    v_uid, v_class.domain, v_class.action_type, 'executing',
    p_payload || jsonb_build_object('composed', (v_prep->'composed') || jsonb_build_object(
      'connectionId', coalesce(v_prep->>'connectionId', p_payload->>'connectionId'))),
    p_reason, v_permission_id, 'autopilot:' || p_idempotency_key, false, now(), now()
  ) returning * into v_action;

  insert into public.autopilot_executions (
    user_id, rule_id, rule_version, action_class, action_id, status, idempotency_key,
    proposed_starts_at, proposed_ends_at, local_day, target_ref, original_starts_at, original_ends_at, recipient
  ) values (
    v_uid, v_rule.id, v_rule.version, v_class.class_key, v_action.id, 'claimed', p_idempotency_key,
    (v_prep->>'startsAt')::timestamptz, (v_prep->>'endsAt')::timestamptz, v_local_day,
    v_prep->>'targetRef', (v_prep->>'originalStartsAt')::timestamptz, (v_prep->>'originalEndsAt')::timestamptz,
    v_prep->>'recipient'
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

-- ---------------------------------------------------------------------------
-- 8. Results and undo are recorded by the Worker only (Phase C P2 fix)
-- ---------------------------------------------------------------------------

drop function if exists public.apm_autopilot_record_result(uuid, text, text, text);
drop function if exists private.apm_autopilot_record_result(uuid, text, text, text);
drop function if exists public.apm_autopilot_record_undo(uuid);
drop function if exists private.apm_autopilot_record_undo(uuid);

create or replace function private.apm_service_autopilot_record_result(
  p_user_id uuid,
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
  v_exec public.autopilot_executions;
begin
  if p_user_id is null or p_outcome not in ('verified','failed') then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_outcome = 'verified' and (p_external_ref is null or char_length(p_external_ref) not between 1 and 500) then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_outcome = 'failed' and (p_failure_code is null or p_failure_code !~ '^[A-Za-z0-9_:.-]{1,120}$') then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;

  select * into v_exec from public.autopilot_executions e
  where e.id = p_execution_id and e.user_id = p_user_id
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
  where a.id = v_exec.action_id and a.user_id = p_user_id;

  insert into public.action_attempts (user_id, action_id, attempt, status, external_ref, error_code, completed_at)
  values (
    p_user_id, v_exec.action_id,
    coalesce((select max(aa.attempt) from public.action_attempts aa where aa.action_id = v_exec.action_id), 0) + 1,
    case when p_outcome = 'verified' then 'succeeded' else 'failed' end,
    case when p_outcome = 'verified' then p_external_ref else null end,
    case when p_outcome = 'failed' then p_failure_code else null end,
    now()
  );

  perform private.apm_autopilot_audit(
    p_user_id, 'autopilot.execution_' || p_outcome, 'autopilot_execution', v_exec.id,
    jsonb_build_object('actionClass', v_exec.action_class, 'ruleId', v_exec.rule_id, 'actionId', v_exec.action_id,
      'failureCode', case when p_outcome = 'failed' then p_failure_code else null end, 'recordedBy', 'worker'),
    'system', 'autopilot_rule:' || v_exec.rule_id::text
  );
  return to_jsonb(v_exec);
end;
$$;

create or replace function private.apm_service_autopilot_record_undo(p_user_id uuid, p_execution_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_exec public.autopilot_executions;
  v_class public.autopilot_action_classes;
begin
  select * into v_exec from public.autopilot_executions e
  where e.id = p_execution_id and e.user_id = p_user_id
  for update;
  if not found then
    raise exception 'autopilot_execution_not_found' using errcode = 'P0002';
  end if;
  if v_exec.status = 'reverted' then
    return to_jsonb(v_exec);
  end if;
  select * into v_class from public.autopilot_action_classes c where c.class_key = v_exec.action_class;
  if v_exec.status <> 'verified' or not v_class.reversible then
    raise exception 'autopilot_invalid_execution_state' using errcode = '22023';
  end if;

  update public.autopilot_executions e set status = 'reverted', reverted_at = now()
  where e.id = v_exec.id
  returning e.* into v_exec;
  update public.actions a set status = 'cancelled', updated_at = now()
  where a.id = v_exec.action_id and a.user_id = p_user_id;

  perform private.apm_autopilot_audit(
    p_user_id, 'autopilot.execution_reverted', 'autopilot_execution', v_exec.id,
    jsonb_build_object('actionClass', v_exec.action_class, 'ruleId', v_exec.rule_id, 'actionId', v_exec.action_id, 'recordedBy', 'worker')
  );
  return to_jsonb(v_exec);
end;
$$;

-- Undo target: owner-only (works after downgrade), verified + reversible only.
-- Everything the Worker needs to reverse the write comes from the ledger.
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
  if not v_class.reversible then
    raise exception 'autopilot_cannot_undo' using errcode = '22023';
  end if;
  if v_exec.status <> 'verified' or v_exec.action_id is null then
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
    'connectorKind', v_class.connector_kind,
    'undoMethod', v_class.undo_method,
    'externalRef', coalesce(v_exec.target_ref, v_exec.external_ref),
    'connectionId', coalesce(v_action.payload->'composed'->>'connectionId', v_action.payload->>'connectionId'),
    'originalStartsAt', v_exec.original_starts_at,
    'originalEndsAt', v_exec.original_ends_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Flexible marks, the daily done-list, and the export
-- ---------------------------------------------------------------------------

-- Marking an event flexible widens what a rule may touch, so it needs the
-- entitlement; un-marking narrows it and is owner-only.
create or replace function private.apm_autopilot_set_event_flexible(p_event_id uuid, p_flexible boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
  v_ev public.calendar_events;
begin
  if p_flexible is null then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  if p_flexible then
    perform private.apm_autopilot_require_access();
  end if;
  select * into v_ev from public.calendar_events ce where ce.id = p_event_id and ce.user_id = v_uid;
  if not found then
    raise exception 'autopilot_event_not_found' using errcode = 'P0002';
  end if;
  if p_flexible then
    insert into public.autopilot_flexible_events (user_id, provider, external_event_id)
    values (v_uid, v_ev.provider, v_ev.external_event_id)
    on conflict do nothing;
  else
    delete from public.autopilot_flexible_events f
    where f.user_id = v_uid and f.provider = v_ev.provider and f.external_event_id = v_ev.external_event_id;
  end if;
  perform private.apm_autopilot_audit(v_uid, 'autopilot.event_flexibility_set', 'calendar_event', v_ev.id,
    jsonb_build_object('flexible', p_flexible));
  return jsonb_build_object('eventId', v_ev.id, 'flexible', p_flexible);
end;
$$;

-- What Autopilot did (or stopped on) for the user on one local day. Owner-only so
-- the list and its Undo buttons survive a downgrade, like every off switch.
create or replace function private.apm_autopilot_done_list(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_autopilot_require_owner();
begin
  if p_day is null then
    raise exception 'autopilot_invalid_request' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(x.item order by x.at desc)
    from (
      select e.claimed_at as at, jsonb_build_object(
        'kind', 'run',
        'executionId', e.id,
        'actionId', e.action_id,
        'actionClass', e.action_class,
        'status', e.status,
        'at', e.claimed_at,
        'summary', case e.action_class
          when 'calendar.create' then 'Scheduled "' || coalesce(a.payload->'composed'->>'title', a.payload->>'title', 'a block') || '"'
          when 'email.draft' then 'Drafted to ' || coalesce(e.recipient, '') || ': ' || coalesce(a.payload->'composed'->>'subject', a.payload->>'subject', '')
          when 'email.send' then 'Sent to ' || coalesce(e.recipient, '') || ': ' || coalesce(a.payload->'composed'->>'subject', '')
          when 'calendar.reschedule' then 'Moved "' || coalesce(a.payload->'composed'->>'title', 'a meeting') || '"'
          when 'calendar.decline' then 'Declined "' || coalesce(a.payload->'composed'->>'title', 'a meeting') || '" with a note'
          when 'appointment.book' then 'Requested ' || coalesce(a.payload->'composed'->>'appointmentType', 'an appointment') || ' with ' || coalesce(a.payload->'composed'->>'providerLabel', '')
          when 'subscription.cancel' then 'Asked to cancel "' || coalesce(a.payload->'composed'->>'itemTitle', '') || '"'
        end,
        'reversible', c.reversible,
        'canUndo', c.reversible and e.status = 'verified',
        'undoLabel', c.undo_label,
        'failureCode', e.failure_code
      ) as item
      from public.autopilot_executions e
      join public.autopilot_rules r on r.id = e.rule_id and r.user_id = e.user_id
      join public.autopilot_action_classes c on c.class_key = e.action_class
      left join public.actions a on a.id = e.action_id and a.user_id = e.user_id
      where e.user_id = v_uid
        and (e.claimed_at at time zone coalesce(r.constraints->>'timezone', 'UTC'))::date = p_day
      union all
      select a.created_at, jsonb_build_object(
        'kind', 'stopped',
        'actionId', a.id,
        'actionClass', a.action_type,
        'status', 'needs_you',
        'at', a.created_at,
        'summary', a.payload->>'title',
        'stoppedReason', a.payload->>'stoppedReason',
        'reversible', false,
        'canUndo', false,
        'undoLabel', 'Nothing was done: this one needs you.'
      )
      from public.actions a
      join public.autopilot_rules r on r.id::text = a.payload->>'ruleId' and r.user_id = a.user_id
      where a.user_id = v_uid and a.idempotency_key like 'autopilot:%' and a.payload ? 'stoppedReason'
        and (a.created_at at time zone coalesce(r.constraints->>'timezone', 'UTC'))::date = p_day
    ) x
  ), '[]'::jsonb);
end;
$$;

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
    ),
    'autopilot_flexible_events', coalesce((
      select jsonb_agg(to_jsonb(f) order by f.marked_at)
      from public.autopilot_flexible_events f where f.user_id = v_uid
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Public surface + grants
-- ---------------------------------------------------------------------------

create or replace function public.apm_autopilot_set_event_flexible(p_event_id uuid, p_flexible boolean)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_autopilot_set_event_flexible(p_event_id, p_flexible); $$;

create or replace function public.apm_autopilot_done_list(p_day date)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_autopilot_done_list(p_day); $$;

create or replace function public.apm_service_autopilot_record_result(p_user_id uuid, p_execution_id uuid, p_outcome text, p_external_ref text default null, p_failure_code text default null)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_autopilot_record_result(p_user_id, p_execution_id, p_outcome, p_external_ref, p_failure_code); $$;

create or replace function public.apm_service_autopilot_record_undo(p_user_id uuid, p_execution_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_autopilot_record_undo(p_user_id, p_execution_id); $$;

-- Internal helpers: callable only from the definer bodies.
revoke all on function private.apm_autopilot_weekdays(jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_text_list(jsonb, integer, integer, integer, boolean) from public, anon, authenticated;
revoke all on function private.apm_autopilot_domain_list(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.apm_autopilot_address(jsonb, text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_refuse_payment_data(text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_window(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_criteria(jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_check_constraints(text, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_require_connection(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_now_in_window(jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_slot_in_window(jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.apm_autopilot_slot_busy(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function private.apm_autopilot_event_protected(uuid, public.calendar_events, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_event_eligible(uuid, public.calendar_events, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_target_event(uuid, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_calendar_create(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_email_draft(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_email_send(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_calendar_reschedule(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_calendar_decline(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_appointment_book(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.apm_autopilot_prepare_subscription_cancel(uuid, jsonb, jsonb) from public, anon, authenticated;

revoke all on function private.apm_autopilot_claim(uuid, text, jsonb, text) from public, anon;
grant execute on function private.apm_autopilot_claim(uuid, text, jsonb, text) to authenticated;
revoke all on function private.apm_autopilot_undo_target(uuid) from public, anon;
grant execute on function private.apm_autopilot_undo_target(uuid) to authenticated;
revoke all on function private.apm_autopilot_data_rights_export() from public, anon;
grant execute on function private.apm_autopilot_data_rights_export() to authenticated;

revoke all on function private.apm_autopilot_set_event_flexible(uuid, boolean) from public, anon;
revoke all on function private.apm_autopilot_done_list(date) from public, anon;
grant execute on function private.apm_autopilot_set_event_flexible(uuid, boolean) to authenticated;
grant execute on function private.apm_autopilot_done_list(date) to authenticated;
revoke all on function public.apm_autopilot_set_event_flexible(uuid, boolean) from public, anon;
revoke all on function public.apm_autopilot_done_list(date) from public, anon;
grant execute on function public.apm_autopilot_set_event_flexible(uuid, boolean) to authenticated;
grant execute on function public.apm_autopilot_done_list(date) to authenticated;

-- Service-only: the Worker's server key records outcomes; no client can.
revoke all on function private.apm_service_autopilot_record_result(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function private.apm_service_autopilot_record_undo(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apm_service_autopilot_record_result(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.apm_service_autopilot_record_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function private.apm_service_autopilot_record_result(uuid, uuid, text, text, text) to service_role;
grant execute on function private.apm_service_autopilot_record_undo(uuid, uuid) to service_role;
grant execute on function public.apm_service_autopilot_record_result(uuid, uuid, text, text, text) to service_role;
grant execute on function public.apm_service_autopilot_record_undo(uuid, uuid) to service_role;
