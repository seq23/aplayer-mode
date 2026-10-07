-- 0032: the rest of the BHPC daily loop.
--
--  A. Diary (BHPC "silent logging": the reply is "Logged.", no coaching).
--  B. Weekly debrief / Executive Review records (Prompt #7).
--  C. OS edits through a governed change flow (BHPC Chat C, the Drafting Room): a change
--     is drafted, then applied explicitly; Week 1 blocks customising; applied changes are
--     audited and never rewrite a day already locked.
--  D. Phase Bridge pacing, Return/Reset re-entry and REPRINT on the day record.
--  E. The Body red-flag pause persists until the user records clinician clearance; a body
--     plan saved while it is active must carry the referral stop.
--  F. Track floors (Body Foundation movement floor, Home Front touchpoint) are completable
--     agenda items when the Track is active; Track settings (hard stop, touchpoint,
--     buffer, debt order) live on the Personal OS.
--  G. The data-rights export covers diary, weekly reviews and OS changes.

alter table public.personal_os
  add column track_settings jsonb not null default '{}'::jsonb check (jsonb_typeof(track_settings) = 'object'),
  add column body_referral_at timestamptz,
  add column body_referral_source text check (body_referral_source is null or body_referral_source in ('intake','diary','day_close','check_in','os_change')),
  add column clinician_cleared_at timestamptz;

alter table public.day_records
  add column phase text check (phase is null or phase in ('first_hour','executing')),
  add column returned_at timestamptz,
  add column reprint_count integer not null default 0 check (reprint_count between 0 and 10);

-- ---------------------------------------------------------------- A. diary
create table public.diary_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'diary' check (kind in ('diary','breakthrough','slip')),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  local_day date not null,
  created_at timestamptz not null default now()
);
create index diary_entries_user_day_idx on public.diary_entries(user_id, local_day desc);

-- ---------------------------------------------------------------- B. weekly reviews
create table public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  summary jsonb not null check (jsonb_typeof(summary) = 'object' and pg_catalog.octet_length(summary::text) <= 16384),
  adjustment text check (adjustment is null or char_length(adjustment) between 3 and 500),
  completed_at timestamptz not null default now(),
  unique (user_id, week_start)
);

-- ---------------------------------------------------------------- C. OS change requests
create table public.os_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  field text not null check (field in (
    'morning_sequence','coaching_firmness','day_start','coaching_reminder_days','show_seven_day_snapshot',
    'review_day','recovery_day','hard_boundaries','non_negotiables','core_values','north_star','pillar','tracks','track_settings')),
  proposed jsonb not null,
  previous jsonb,
  reason text check (reason is null or char_length(reason) <= 500),
  status text not null default 'draft' check (status in ('draft','applied','discarded')),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  effective_from date
);
create index os_change_requests_user_idx on public.os_change_requests(user_id, created_at desc);

alter table public.diary_entries enable row level security;
alter table public.weekly_reviews enable row level security;
alter table public.os_change_requests enable row level security;
create policy diary_entries_select_entitled on public.diary_entries for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_core_access((select auth.uid())));
create policy weekly_reviews_select_entitled on public.weekly_reviews for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_core_access((select auth.uid())));
create policy os_change_requests_select_entitled on public.os_change_requests for select to authenticated
  using ((select auth.uid()) = user_id and private.apm_has_core_access((select auth.uid())));
revoke all on table public.diary_entries from anon;
revoke all on table public.weekly_reviews from anon;
revoke all on table public.os_change_requests from anon;
revoke insert, update, delete, truncate, references, trigger on table public.diary_entries from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.weekly_reviews from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.os_change_requests from authenticated;
grant select on table public.diary_entries to authenticated;
grant select on table public.weekly_reviews to authenticated;
grant select on table public.os_change_requests to authenticated;

-- ---------------------------------------------------------------- F. track floors
create or replace function private.apm_loop_track_floor_allowed(p_user_id uuid, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_action_key
    when 'track:body_floor' then exists (select 1 from public.tracks t where t.user_id = p_user_id and t.key = 'body_foundation' and t.active)
                              and not exists (select 1 from public.personal_os p where p.user_id = p_user_id and p.body_referral_at is not null)
    when 'track:home_touchpoint' then exists (select 1 from public.tracks t where t.user_id = p_user_id and t.key = 'home_front' and t.active)
    else false
  end;
$$;

create or replace function private.apm_loop_check_agenda_items(p_user_id uuid, p_agenda jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_plan jsonb;
begin
  for v_item in
    select item from (
      select p_agenda->'firstHour'->'priority' as item
      union all
      select e from jsonb_array_elements(p_agenda->'dailyStack') e
    ) items
    where item is not null and jsonb_typeof(item) = 'object' and item ? 'planId'
  loop
    select gp.plan into v_plan
      from public.goal_plans gp
     where gp.user_id = p_user_id and gp.status <> 'superseded' and gp.id::text = v_item->>'planId';
    if v_plan is null then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
    if not (v_item->>'kind' = 'carry_forward' and v_item->>'actionKey' = 'carry_forward')
       and not (v_item->>'kind' = 'track_floor' and private.apm_loop_track_floor_allowed(p_user_id, v_item->>'actionKey'))
       and not (coalesce(v_item->>'actionKey', '') = any (private.apm_loop_allowed_actions(v_plan, (p_agenda->>'date')::date))) then
      raise exception 'loop_invalid_agenda' using errcode = '22023';
    end if;
  end loop;
end;
$$;


create or replace function private.apm_complete_plan_action(p_plan_id uuid, p_action_key text, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_plan public.goal_plans;
  v_day public.day_records;
  v_item jsonb;
  v_row public.plan_action_completions;
  v_evidence uuid;
begin
  if char_length(coalesce(p_note, '')) > 500 or char_length(coalesce(p_action_key, '')) not between 1 and 120 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  select * into v_plan from public.goal_plans gp where gp.id = p_plan_id and gp.user_id = v_uid and gp.status <> 'superseded';
  if v_plan.id is null then
    raise exception 'loop_plan_not_found' using errcode = 'P0002';
  end if;
  -- The stored plan, not the agenda JSON, is the source of truth for what can be done.
  if p_action_key <> 'carry_forward' and not private.apm_loop_track_floor_allowed(v_uid, p_action_key)
     and not (p_action_key = any (private.apm_loop_allowed_actions(v_plan.plan, v_today))) then
    raise exception 'loop_not_on_agenda' using errcode = 'P0002';
  end if;
  select * into v_day from public.day_records d where d.user_id = v_uid and d.day = v_today;
  if v_day.id is null or v_day.checked_in_at is null then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  if v_day.closed_at is not null then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  select item into v_item
    from (
      select v_day.agenda->'firstHour'->'priority' as item
      union all
      select e from jsonb_array_elements(v_day.agenda->'dailyStack') e
    ) items
   where item->>'planId' = p_plan_id::text and item->>'actionKey' = p_action_key
   limit 1;
  if v_item is null then
    raise exception 'loop_not_on_agenda' using errcode = 'P0002';
  end if;

  insert into public.plan_action_completions (user_id, plan_id, day, action_key, instance_id, scope, role, note)
  values (
    v_uid, p_plan_id, v_today, p_action_key,
    v_plan.plan_key || ':' || v_today::text || ':' || p_action_key,
    case when v_item->>'scope' = 'mvd' then 'mvd' else 'standard' end,
    case when v_item->>'kind' = 'plan_action' then 'foreground' else 'floor' end,
    nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (plan_id, day, action_key) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.plan_action_completions c where c.plan_id = p_plan_id and c.day = v_today and c.action_key = p_action_key;
    return jsonb_build_object('completion', to_jsonb(v_row), 'replayed', true);
  end if;

  insert into public.evidence (user_id, kind, summary, source_type, source_ref, related_goal_id)
  values (v_uid, 'user_completion', left('Completed: ' || coalesce(v_item->>'title', p_action_key), 500), 'manual',
          'plan:' || p_plan_id::text || ':' || v_today::text || ':' || p_action_key, v_plan.goal_id)
  returning id into v_evidence;
  update public.plan_action_completions set evidence_id = v_evidence where id = v_row.id returning * into v_row;
  update public.day_records set completed_action_ids = array_append(completed_action_ids, v_row.id), updated_at = now() where id = v_day.id;

  perform private.apm_loop_audit(v_uid, 'plan_action.completed', 'goal_plan', p_plan_id::text,
    jsonb_build_object('actionKey', p_action_key, 'day', v_today, 'scope', v_row.scope, 'role', v_row.role));
  return jsonb_build_object('completion', to_jsonb(v_row), 'replayed', false);
end;
$$;


create or replace function private.apm_service_save_goal_plan(p_user_id uuid, p_goal_id uuid, p_plan jsonb, p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_previous uuid;
  v_row public.goal_plans;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  if p_source not in ('intake','goals','backfill','clearance','referral','os_change') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  perform private.apm_loop_check_plan(p_plan);
  -- Body red-flag pause (Body Foundation): until clinician clearance is recorded, a body
  -- plan must carry the referral stop.
  if p_plan->'persona'->>'foregroundPersona' = 'weight_loss'
     and coalesce((p_plan->'safety'->>'referral')::boolean, false) = false
     and exists (select 1 from public.personal_os p where p.user_id = v_uid and p.body_referral_at is not null) then
    raise exception 'loop_body_referral_active' using errcode = '55000';
  end if;
  if p_goal_id is null or not exists (select 1 from public.goals g where g.id = p_goal_id and g.user_id = v_uid) then
    raise exception 'loop_goal_not_found' using errcode = 'P0002';
  end if;

  update public.goal_plans
     set status = 'superseded', updated_at = now()
   where user_id = v_uid and goal_id = p_goal_id and status <> 'superseded'
  returning id into v_previous;

  insert into public.goal_plans (
    user_id, goal_id, plan_key, template_key, persona, foreground_pillar,
    start_date, end_date, timezone, plan
  ) values (
    v_uid, p_goal_id, p_plan->>'id', p_plan->'provenance'->>'templateKey', p_plan->'persona'->>'key',
    p_plan->'foreground'->>'pillar', (p_plan->>'startDate')::date, (p_plan->>'endDate')::date,
    nullif(p_plan->>'timezone', ''), p_plan
  )
  returning * into v_row;

  perform private.apm_loop_audit(
    v_uid,
    case when v_previous is null then 'goal_plan.created' else 'goal_plan.replaced' end,
    'goal_plan', v_row.id::text,
    jsonb_build_object('goalId', p_goal_id, 'templateKey', v_row.template_key, 'persona', v_row.persona,
                       'source', p_source, 'replaced', v_previous, 'referral', (p_plan->'safety'->>'referral')::boolean)
  );
  return to_jsonb(v_row);
end;
$$;


-- ---------------------------------------------------------------- A. diary write
create or replace function private.apm_log_diary(p_kind text, p_body text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.diary_entries;
begin
  if coalesce(p_kind, '') not in ('diary','breakthrough','slip') or char_length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  insert into public.diary_entries (user_id, kind, body, local_day)
  values (v_uid, p_kind, btrim(p_body), private.apm_local_today(v_uid))
  returning * into v_row;
  -- Content never enters the audit trail.
  perform private.apm_loop_audit(v_uid, 'diary.logged', 'diary_entry', v_row.id::text, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('entry', to_jsonb(v_row), 'reply', 'Logged.');
end;
$$;

-- ---------------------------------------------------------------- B. weekly review write
create or replace function private.apm_save_weekly_review(p_week_start date, p_summary jsonb, p_adjustment text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_row public.weekly_reviews;
begin
  if p_week_start is null or p_week_start > v_today or p_week_start < v_today - 13
     or p_summary is null or jsonb_typeof(p_summary) <> 'object'
     or (p_adjustment is not null and char_length(btrim(p_adjustment)) not between 3 and 500) then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  insert into public.weekly_reviews (user_id, week_start, summary, adjustment)
  values (v_uid, p_week_start, p_summary, nullif(btrim(coalesce(p_adjustment, '')), ''))
  on conflict (user_id, week_start) do update set summary = excluded.summary, adjustment = excluded.adjustment, completed_at = now()
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'weekly_review.completed', 'weekly_review', v_row.id::text, jsonb_build_object('weekStart', p_week_start, 'adjustment', v_row.adjustment is not null));
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------- C. OS change flow
create or replace function private.apm_os_change_validate(p_field text, p_value jsonb)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_text text;
  v_key text;
  v_max integer;
begin
  case p_field
    when 'morning_sequence', 'hard_boundaries', 'non_negotiables', 'core_values' then
      v_max := 20;
      if p_field = 'morning_sequence' then v_max := 5; end if;
      if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) > v_max then
        raise exception 'loop_invalid_request' using errcode = '22023';
      end if;
      for v_text in select jsonb_array_elements_text(p_value) loop
        if char_length(btrim(v_text)) not between 1 and 300 then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
      end loop;
    when 'coaching_firmness' then
      if coalesce(p_value #>> '{}', '') not in ('gentle','direct','high_pressure') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
    when 'day_start' then
      if coalesce(p_value #>> '{}', '') not in ('guided','hard') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
    when 'coaching_reminder_days' then
      if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 1 and 60 then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
    when 'show_seven_day_snapshot' then
      if jsonb_typeof(p_value) <> 'boolean' then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
    when 'review_day', 'recovery_day' then
      if lower(coalesce(p_value #>> '{}', '')) not in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday') then
        raise exception 'loop_invalid_request' using errcode = '22023';
      end if;
    when 'north_star' then
      if jsonb_typeof(p_value) <> 'string' or char_length(p_value #>> '{}') > 1000 then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
    when 'pillar' then
      if jsonb_typeof(p_value) <> 'object' or coalesce(p_value->>'name', '') not in ('wealth','body','spirit','execution')
         or jsonb_typeof(p_value->'critical') <> 'boolean' or char_length(coalesce(p_value->>'minimumFloor', '')) > 300 then
        raise exception 'loop_invalid_request' using errcode = '22023';
      end if;
    when 'tracks' then
      if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) > 7 then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
      for v_text in select jsonb_array_elements_text(p_value) loop
        if v_text not in ('billionaire_mindset','operator_discipline','strategic_patience','resilience','body_foundation','wealth_foundation','home_front') then
          raise exception 'loop_invalid_request' using errcode = '22023';
        end if;
      end loop;
    when 'track_settings' then
      if jsonb_typeof(p_value) <> 'object' then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
      for v_key in select jsonb_object_keys(p_value) loop
        if v_key not in ('hardStop','homeTouchpoint','movementFloor','bufferMonths','bufferTarget','highInterestDebt','debtOrder') then
          raise exception 'loop_field_not_allowed' using errcode = '22023';
        end if;
      end loop;
      if p_value ? 'hardStop' and coalesce(p_value->>'hardStop', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
      if (p_value ? 'homeTouchpoint' and char_length(coalesce(p_value->>'homeTouchpoint', '')) not between 5 and 200)
         or (p_value ? 'movementFloor' and char_length(coalesce(p_value->>'movementFloor', '')) not between 5 and 200) then
        raise exception 'loop_invalid_request' using errcode = '22023';
      end if;
      if (p_value ? 'bufferMonths' and (jsonb_typeof(p_value->'bufferMonths') <> 'number' or (p_value->>'bufferMonths')::numeric not between 0 and 120))
         or (p_value ? 'bufferTarget' and (jsonb_typeof(p_value->'bufferTarget') <> 'number' or (p_value->>'bufferTarget')::numeric not between 0 and 120))
         or (p_value ? 'highInterestDebt' and jsonb_typeof(p_value->'highInterestDebt') <> 'boolean')
         or (p_value ? 'debtOrder' and (jsonb_typeof(p_value->'debtOrder') <> 'array' or jsonb_array_length(p_value->'debtOrder') > 20)) then
        raise exception 'loop_invalid_request' using errcode = '22023';
      end if;
    else
      raise exception 'loop_invalid_request' using errcode = '22023';
  end case;
end;
$$;

create or replace function private.apm_draft_os_change(p_field text, p_value jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.os_change_requests;
begin
  if not exists (select 1 from public.personal_os p where p.user_id = v_uid) then
    raise exception 'loop_personal_os_missing' using errcode = 'P0002';
  end if;
  if char_length(coalesce(p_reason, '')) > 500 then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
  perform private.apm_os_change_validate(p_field, p_value);
  insert into public.os_change_requests (user_id, field, proposed, reason) values (v_uid, p_field, p_value, nullif(btrim(coalesce(p_reason, '')), ''))
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'os_change.drafted', 'os_change_request', v_row.id::text, jsonb_build_object('field', p_field));
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_apply_os_change(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.os_change_requests;
  v_os public.personal_os;
  v_prev jsonb;
  v_val jsonb;
begin
  select * into v_row from public.os_change_requests c where c.id = p_id and c.user_id = v_uid for update;
  if v_row.id is null then raise exception 'loop_change_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'draft' then raise exception 'loop_change_not_draft' using errcode = '55000'; end if;
  if private.apm_loop_week_one_locked(v_uid) then raise exception 'loop_week_one_lock' using errcode = '55000'; end if;
  perform private.apm_os_change_validate(v_row.field, v_row.proposed);
  select * into v_os from public.personal_os p where p.user_id = v_uid for update;
  v_val := v_row.proposed;
  case v_row.field
    when 'morning_sequence' then
      v_prev := v_os.morning_sequence;
      update public.personal_os set morning_sequence = (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from jsonb_array_elements_text(v_val) x), updated_at = now() where user_id = v_uid;
    when 'hard_boundaries' then
      v_prev := v_os.hard_boundaries;
      update public.personal_os set hard_boundaries = (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from jsonb_array_elements_text(v_val) x), updated_at = now() where user_id = v_uid;
    when 'non_negotiables' then
      v_prev := v_os.non_negotiables;
      update public.personal_os set non_negotiables = (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from jsonb_array_elements_text(v_val) x), updated_at = now() where user_id = v_uid;
    when 'core_values' then
      v_prev := v_os.core_values;
      update public.personal_os set core_values = (select coalesce(jsonb_agg(btrim(x)), '[]'::jsonb) from jsonb_array_elements_text(v_val) x), updated_at = now() where user_id = v_uid;
    when 'north_star' then
      v_prev := to_jsonb(v_os.north_star);
      update public.personal_os set north_star = nullif(btrim(v_val #>> '{}'), ''), updated_at = now() where user_id = v_uid;
    when 'coaching_firmness' then
      v_prev := v_os.coaching_style->'firmness';
      update public.personal_os set coaching_style = coalesce(coaching_style, '{}'::jsonb) || jsonb_build_object('firmness', v_val #>> '{}'), updated_at = now() where user_id = v_uid;
    when 'day_start' then
      v_prev := v_os.accountability->'dayStart';
      update public.personal_os set accountability = coalesce(accountability, '{}'::jsonb) || jsonb_build_object('dayStart', v_val #>> '{}'), updated_at = now() where user_id = v_uid;
    when 'coaching_reminder_days' then
      v_prev := v_os.accountability->'coachingReminderAfterDays';
      update public.personal_os set accountability = coalesce(accountability, '{}'::jsonb) || jsonb_build_object('coachingReminderAfterDays', (v_val #>> '{}')::integer), updated_at = now() where user_id = v_uid;
    when 'show_seven_day_snapshot' then
      v_prev := v_os.scoring_config->'showSevenDaySnapshot';
      update public.personal_os set scoring_config = coalesce(scoring_config, '{}'::jsonb) || jsonb_build_object('showSevenDaySnapshot', v_val), updated_at = now() where user_id = v_uid;
    when 'review_day' then
      v_prev := v_os.weekly_cadence->'reviewDay';
      update public.personal_os set weekly_cadence = coalesce(weekly_cadence, '{}'::jsonb) || jsonb_build_object('reviewDay', initcap(v_val #>> '{}')), updated_at = now() where user_id = v_uid;
    when 'recovery_day' then
      v_prev := v_os.weekly_cadence->'recoveryDay';
      update public.personal_os set weekly_cadence = coalesce(weekly_cadence, '{}'::jsonb) || jsonb_build_object('recoveryDay', initcap(v_val #>> '{}')), updated_at = now() where user_id = v_uid;
    when 'track_settings' then
      v_prev := v_os.track_settings;
      update public.personal_os set track_settings = track_settings || v_val, updated_at = now() where user_id = v_uid;
    when 'pillar' then
      select to_jsonb(ps) into v_prev from public.pillar_settings ps where ps.user_id = v_uid and ps.name = v_val->>'name';
      insert into public.pillar_settings (user_id, name, active, critical, minimum_floor)
      values (v_uid, v_val->>'name', true, (v_val->>'critical')::boolean, nullif(btrim(coalesce(v_val->>'minimumFloor', '')), ''))
      on conflict (user_id, name) do update set active = true, critical = excluded.critical, minimum_floor = excluded.minimum_floor;
    when 'tracks' then
      select coalesce(jsonb_agg(t.key order by t.key), '[]'::jsonb) into v_prev from public.tracks t where t.user_id = v_uid and t.active;
      delete from public.tracks t where t.user_id = v_uid and not (t.key = any (array(select jsonb_array_elements_text(v_val))));
      insert into public.tracks (user_id, key, name, active, foreground, provenance_kind, source_type, confidence)
      select v_uid, k, k, true, false, 'stated', 'manual', 1 from jsonb_array_elements_text(v_val) k
      on conflict (user_id, key) do update set active = true;
  end case;
  update public.os_change_requests
     set status = 'applied', previous = v_prev, applied_at = now(), effective_from = private.apm_local_today(v_uid) + 1
   where id = p_id
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'os_change.applied', 'os_change_request', p_id::text, jsonb_build_object('field', v_row.field, 'effectiveFrom', v_row.effective_from));
  return to_jsonb(v_row);
end;
$$;

create or replace function private.apm_discard_os_change(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.os_change_requests;
begin
  update public.os_change_requests set status = 'discarded' where id = p_id and user_id = v_uid and status = 'draft' returning * into v_row;
  if v_row.id is null then raise exception 'loop_change_not_found' using errcode = 'P0002'; end if;
  perform private.apm_loop_audit(v_uid, 'os_change.discarded', 'os_change_request', p_id::text, jsonb_build_object('field', v_row.field));
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------- D. day pacing, return/reset, reprint
create or replace function private.apm_set_day_phase(p_phase text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_row public.day_records;
begin
  if coalesce(p_phase, '') not in ('first_hour','executing') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
  update public.day_records d
     set phase = case when d.phase = 'executing' then 'executing' else p_phase end, updated_at = now()
   where d.user_id = v_uid and d.day = private.apm_local_today(v_uid) and d.checked_in_at is not null and d.closed_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'loop_opening_step_required' using errcode = '55000'; end if;
  perform private.apm_loop_audit(v_uid, 'day.phase', 'day_record', v_row.id::text, jsonb_build_object('phase', v_row.phase));
  return to_jsonb(v_row);
end;
$$;

-- "Welcome back. Want me to print today's agenda and restart the day?" No gap analysis.
create or replace function private.apm_day_return_reset()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_row public.day_records;
begin
  insert into public.day_records (user_id, day, mode, returned_at, updated_at)
  values (v_uid, v_today, coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'), now(), now())
  on conflict (user_id, day) do update set returned_at = coalesce(public.day_records.returned_at, now()), updated_at = now()
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.return_reset', 'day_record', v_row.id::text, '{}'::jsonb);
  return to_jsonb(v_row);
end;
$$;

-- REPRINT (Invalid Agenda clause): a generic or invalid agenda is a system failure and is
-- reprinted; the scope never changes (a reprint is not a renegotiation).
-- Service-role only, like the check-in (0028): the Worker computes the reprint.
create or replace function private.apm_service_day_reprint(p_user_id uuid, p_day date, p_agenda jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_row public.day_records;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  if p_day is distinct from private.apm_local_today(v_uid) then raise exception 'loop_day_not_today' using errcode = '22023'; end if;
  perform private.apm_loop_check_agenda(p_agenda, p_day);
  perform private.apm_loop_check_agenda_items(v_uid, p_agenda);
  select * into v_row from public.day_records d where d.user_id = v_uid and d.day = p_day for update;
  if v_row.id is null or v_row.agenda_status is distinct from 'locked' then raise exception 'loop_day_not_locked' using errcode = '55000'; end if;
  if v_row.closed_at is not null then raise exception 'loop_day_closed' using errcode = '55000'; end if;
  if v_row.reprint_count >= 5 then raise exception 'loop_reprint_limit' using errcode = '55000'; end if;
  if (p_agenda->>'mode') is distinct from (v_row.agenda->>'mode') or (p_agenda->>'state') is distinct from (v_row.agenda->>'state') then
    raise exception 'loop_invalid_agenda' using errcode = '22023';
  end if;
  update public.day_records set agenda = p_agenda, reprint_count = reprint_count + 1, updated_at = now() where id = v_row.id returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'agenda.reprinted', 'day_record', v_row.id::text, jsonb_build_object('count', v_row.reprint_count));
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------- E. body red-flag pause
create or replace function private.apm_flag_body_referral(p_source text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_os public.personal_os;
begin
  if coalesce(p_source, '') not in ('intake','diary','day_close','check_in','os_change') then raise exception 'loop_invalid_request' using errcode = '22023'; end if;
  update public.personal_os
     set body_referral_at = coalesce(body_referral_at, now()), body_referral_source = coalesce(body_referral_source, p_source),
         clinician_cleared_at = null, updated_at = now()
   where user_id = v_uid
  returning * into v_os;
  if v_os.user_id is null then raise exception 'loop_personal_os_missing' using errcode = 'P0002'; end if;
  perform private.apm_loop_audit(v_uid, 'body.referral_paused', 'personal_os', v_uid::text, jsonb_build_object('source', p_source));
  return jsonb_build_object('bodyReferralAt', v_os.body_referral_at, 'source', v_os.body_referral_source);
end;
$$;

create or replace function private.apm_record_clinician_clearance()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_os public.personal_os;
begin
  update public.personal_os
     set clinician_cleared_at = now(), body_referral_at = null, body_referral_source = null, updated_at = now()
   where user_id = v_uid and body_referral_at is not null
  returning * into v_os;
  if v_os.user_id is null then raise exception 'loop_no_referral' using errcode = '55000'; end if;
  perform private.apm_loop_audit(v_uid, 'body.clinician_cleared', 'personal_os', v_uid::text, '{}'::jsonb);
  return jsonb_build_object('clinicianClearedAt', v_os.clinician_cleared_at);
end;
$$;

-- ---------------------------------------------------------------- G. export
create or replace function private.apm_daily_loop_data_rights_export()
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
    raise exception 'loop_unauthenticated' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'goalPlans', coalesce((select jsonb_agg(to_jsonb(gp) order by gp.created_at) from public.goal_plans gp where gp.user_id = v_uid), '[]'::jsonb),
    'planActionCompletions', coalesce((select jsonb_agg(to_jsonb(c) order by c.day, c.created_at) from public.plan_action_completions c where c.user_id = v_uid), '[]'::jsonb),
    'dayRecords', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from public.day_records d where d.user_id = v_uid), '[]'::jsonb),
    'diaryEntries', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.diary_entries e where e.user_id = v_uid), '[]'::jsonb),
    'weeklyReviews', coalesce((select jsonb_agg(to_jsonb(w) order by w.week_start) from public.weekly_reviews w where w.user_id = v_uid), '[]'::jsonb),
    'osChangeRequests', coalesce((select jsonb_agg(to_jsonb(o) order by o.created_at) from public.os_change_requests o where o.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------- public RPC surface
create or replace function public.apm_log_diary(p_kind text, p_body text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_log_diary(p_kind, p_body); $$;
create or replace function public.apm_save_weekly_review(p_week_start date, p_summary jsonb, p_adjustment text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_save_weekly_review(p_week_start, p_summary, p_adjustment); $$;
create or replace function public.apm_draft_os_change(p_field text, p_value jsonb, p_reason text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_draft_os_change(p_field, p_value, p_reason); $$;
create or replace function public.apm_apply_os_change(p_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_apply_os_change(p_id); $$;
create or replace function public.apm_discard_os_change(p_id uuid)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_discard_os_change(p_id); $$;
create or replace function public.apm_set_day_phase(p_phase text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_set_day_phase(p_phase); $$;
create or replace function public.apm_day_return_reset()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_day_return_reset(); $$;
create or replace function public.apm_service_day_reprint(p_user_id uuid, p_day date, p_agenda jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_day_reprint(p_user_id, p_day, p_agenda); $$;
create or replace function public.apm_flag_body_referral(p_source text)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_flag_body_referral(p_source); $$;
create or replace function public.apm_record_clinician_clearance()
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_record_clinician_clearance(); $$;

-- ---------------------------------------------------------------- grants
revoke all on function private.apm_log_diary(text, text) from public, anon;
grant execute on function private.apm_log_diary(text, text) to authenticated;
revoke all on function public.apm_log_diary(text, text) from public, anon;
grant execute on function public.apm_log_diary(text, text) to authenticated;
revoke all on function private.apm_save_weekly_review(date, jsonb, text) from public, anon;
grant execute on function private.apm_save_weekly_review(date, jsonb, text) to authenticated;
revoke all on function public.apm_save_weekly_review(date, jsonb, text) from public, anon;
grant execute on function public.apm_save_weekly_review(date, jsonb, text) to authenticated;
revoke all on function private.apm_draft_os_change(text, jsonb, text) from public, anon;
grant execute on function private.apm_draft_os_change(text, jsonb, text) to authenticated;
revoke all on function public.apm_draft_os_change(text, jsonb, text) from public, anon;
grant execute on function public.apm_draft_os_change(text, jsonb, text) to authenticated;
revoke all on function private.apm_apply_os_change(uuid) from public, anon;
grant execute on function private.apm_apply_os_change(uuid) to authenticated;
revoke all on function public.apm_apply_os_change(uuid) from public, anon;
grant execute on function public.apm_apply_os_change(uuid) to authenticated;
revoke all on function private.apm_discard_os_change(uuid) from public, anon;
grant execute on function private.apm_discard_os_change(uuid) to authenticated;
revoke all on function public.apm_discard_os_change(uuid) from public, anon;
grant execute on function public.apm_discard_os_change(uuid) to authenticated;
revoke all on function private.apm_set_day_phase(text) from public, anon;
grant execute on function private.apm_set_day_phase(text) to authenticated;
revoke all on function public.apm_set_day_phase(text) from public, anon;
grant execute on function public.apm_set_day_phase(text) to authenticated;
revoke all on function private.apm_day_return_reset() from public, anon;
grant execute on function private.apm_day_return_reset() to authenticated;
revoke all on function public.apm_day_return_reset() from public, anon;
grant execute on function public.apm_day_return_reset() to authenticated;
revoke all on function private.apm_service_day_reprint(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function private.apm_service_day_reprint(uuid, date, jsonb) to service_role;
revoke all on function public.apm_service_day_reprint(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.apm_service_day_reprint(uuid, date, jsonb) to service_role;
revoke all on function private.apm_flag_body_referral(text) from public, anon;
grant execute on function private.apm_flag_body_referral(text) to authenticated;
revoke all on function public.apm_flag_body_referral(text) from public, anon;
grant execute on function public.apm_flag_body_referral(text) to authenticated;
revoke all on function private.apm_record_clinician_clearance() from public, anon;
grant execute on function private.apm_record_clinician_clearance() to authenticated;
revoke all on function public.apm_record_clinician_clearance() from public, anon;
grant execute on function public.apm_record_clinician_clearance() to authenticated;
revoke all on function private.apm_loop_track_floor_allowed(uuid, text) from public, anon;
grant execute on function private.apm_loop_track_floor_allowed(uuid, text) to authenticated;
revoke all on function private.apm_os_change_validate(text, jsonb) from public, anon;
grant execute on function private.apm_os_change_validate(text, jsonb) to authenticated;
grant execute on function private.apm_loop_track_floor_allowed(uuid, text) to service_role;
