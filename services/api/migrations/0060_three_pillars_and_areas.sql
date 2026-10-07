-- 0060: three pillars (Mind, Body, Spirit) with AREAS inside them (owner decision 7 Oct 2026).
--
-- Supersedes the four-pillar model (wealth, body, spirit, execution; docs/20) and the
-- plan-only `family` floor (0021/0022). The engine keeps critical/flexible, floors, MVD and
-- scoring at AREA level (BHPC needs that granularity); the app rolls areas up to the three
-- pillars for display and the day verdict.
--
--   Mind   = work, money, learning, focus, mental_health
--   Body   = movement, food, sleep, weight, health_routines
--   Spirit = faith, meditation, gratitude, nature, service, family
--
-- A. Existing data is migrated without loss: execution→work, wealth→money, body→movement,
--    family→family, spirit→an area read from the floor/title text (prayer → faith,
--    gratitude → gratitude, outside → nature, volunteering → service, else meditation).
--    Stored plans, agendas, day reviews and OS-change records are rewritten the same way.
-- B. Every pillar check (pillar_settings, goals, routines, goal_plans, plan check, goal
--    creation, day close review, OS-change validation) now takes the area list.
-- C. pillar_settings gains `pillar` (generated from the area). personal_os gains
--    `pillars_enabled` (all three by default; a pillar can be switched off) and
--    `intake_profile` (the structured first-run profile: ids, numbers, times; never the
--    catch-all text).
-- D. The intake write becomes the established governed pattern: SECURITY DEFINER in
--    `private` (search_path '', ownership from auth.uid(), audited) behind a thin public RPC.

-- ---------------------------------------------------------------- helpers
create or replace function private.apm_area_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$ select array['work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family']::text[]; $$;

create or replace function private.apm_area_pillar(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_area in ('work','money','learning','focus','mental_health') then 'mind'
    when p_area in ('movement','food','sleep','weight','health_routines') then 'body'
    when p_area in ('faith','meditation','gratitude','nature','service','family') then 'spirit'
  end;
$$;

-- Legacy pillar key → area. Area keys pass through unchanged (the rewrite is idempotent).
create or replace function private.apm_legacy_area(p_key text, p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'execution' then 'work'
    when 'wealth' then 'money'
    when 'body' then 'movement'
    when 'family' then 'family'
    when 'spirit' then case
      when lower(coalesce(p_text, '')) ~ '(pray|scripture|bible|quran|torah|church|mosque|temple|synagogue|worship|devotion|god)' then 'faith'
      when lower(coalesce(p_text, '')) ~ '(gratitude|grateful|thankful)' then 'gratitude'
      when lower(coalesce(p_text, '')) ~ '(nature|outside|outdoors|stillness|sunlight)' then 'nature'
      when lower(coalesce(p_text, '')) ~ '(volunteer|serve|service|giving|donat)' then 'service'
      else 'meditation'
    end
    else p_key
  end;
$$;

-- Rewrites every "pillar" value (and the "name" of pillar-setting objects) in a JSON tree.
create or replace function private.apm_remap_pillar_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out jsonb;
  v_key text;
  v_val jsonb;
  v_text text;
begin
  if p_value is null then return null; end if;
  if jsonb_typeof(p_value) = 'object' then
    v_out := '{}'::jsonb;
    v_text := coalesce(p_value->>'minimumFloor', p_value->>'minimum_floor', p_value->>'title', '');
    for v_key, v_val in select e.key, e.value from jsonb_each(p_value) e loop
      if v_key = 'pillar' and jsonb_typeof(v_val) = 'string' then
        v_out := v_out || jsonb_build_object(v_key, private.apm_legacy_area(v_val #>> '{}', v_text));
      elsif v_key = 'name' and jsonb_typeof(v_val) = 'string' and p_value ? 'critical' then
        v_out := v_out || jsonb_build_object(v_key, private.apm_legacy_area(v_val #>> '{}', v_text));
      else
        v_out := v_out || jsonb_build_object(v_key, private.apm_remap_pillar_json(v_val));
      end if;
    end loop;
    return v_out;
  elsif jsonb_typeof(p_value) = 'array' then
    select coalesce(jsonb_agg(private.apm_remap_pillar_json(t.e) order by t.o), '[]'::jsonb) into v_out
      from jsonb_array_elements(p_value) with ordinality as t(e, o);
    return v_out;
  end if;
  return p_value;
end;
$$;

revoke all on function private.apm_area_keys() from public, anon;
revoke all on function private.apm_area_pillar(text) from public, anon;
revoke all on function private.apm_legacy_area(text, text) from public, anon;
grant execute on function private.apm_legacy_area(text, text) to authenticated, service_role;
revoke all on function private.apm_remap_pillar_json(jsonb) from public, anon, authenticated;
grant execute on function private.apm_area_keys() to authenticated, service_role;
grant execute on function private.apm_area_pillar(text) to authenticated, service_role;

-- ---------------------------------------------------------------- A. data, B. checks
alter table public.pillar_settings drop constraint if exists pillar_settings_name_check;
alter table public.goals drop constraint if exists goals_pillar_check;
alter table public.routines drop constraint if exists routines_pillar_check;
alter table public.goal_plans drop constraint if exists goal_plans_foreground_pillar_check;

update public.pillar_settings set name = private.apm_legacy_area(name, minimum_floor) where name in ('wealth','body','spirit','execution','family');
update public.goals set pillar = private.apm_legacy_area(pillar, title) where pillar in ('wealth','body','spirit','execution','family');
update public.routines set pillar = private.apm_legacy_area(pillar, title) where pillar in ('wealth','body','spirit','execution','family');
update public.goal_plans
   set plan = private.apm_remap_pillar_json(plan),
       foreground_pillar = private.apm_legacy_area(foreground_pillar, plan->'foreground'->>'label')
 where foreground_pillar in ('wealth','body','spirit','execution','family') or plan::text ~ '"pillar": ?"(wealth|body|spirit|execution)"';
update public.day_records
   set agenda = private.apm_remap_pillar_json(agenda),
       replans = private.apm_remap_pillar_json(replans),
       pillar_review = private.apm_remap_pillar_json(pillar_review)
 where coalesce(agenda::text, '') || replans::text || coalesce(pillar_review::text, '') ~ '"pillar": ?"(wealth|body|spirit|execution)"';
update public.os_change_requests
   set proposed = private.apm_remap_pillar_json(proposed),
       previous = private.apm_remap_pillar_json(previous)
 where field = 'pillar';

alter table public.pillar_settings add constraint pillar_settings_name_check check (name in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family'));
alter table public.goals add constraint goals_pillar_check check (pillar is null or pillar in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family'));
alter table public.routines add constraint routines_pillar_check check (pillar is null or pillar in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family'));
alter table public.goal_plans add constraint goal_plans_foreground_pillar_check check (foreground_pillar in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family'));

-- ---------------------------------------------------------------- C. pillar roll-up + Personal OS fields
alter table public.pillar_settings
  add column pillar text generated always as (
    case
      when name in ('work','money','learning','focus','mental_health') then 'mind'
      when name in ('movement','food','sleep','weight','health_routines') then 'body'
      else 'spirit'
    end
  ) stored;

alter table public.personal_os
  add column pillars_enabled text[] not null default array['mind','body','spirit']::text[]
    check (pillars_enabled <@ array['mind','body','spirit']::text[]),
  add column intake_profile jsonb
    check (intake_profile is null or (jsonb_typeof(intake_profile) = 'object' and octet_length(intake_profile::text) <= 32768 and not (intake_profile ? 'catchAll')));

-- ---------------------------------------------------------------- B. functions carried forward with the area list

create or replace function private.apm_loop_check_plan(p_plan jsonb)
returns void
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_key text;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_plan::text) > 262144 then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if coalesce(p_plan->>'version', '') <> '1'
     or coalesce(p_plan->'provenance'->>'source', '') <> 'deterministic_template'
     or char_length(coalesce(p_plan->>'id', '')) not between 1 and 120
     or char_length(coalesce(p_plan->'provenance'->>'templateKey', '')) not between 1 and 120
     or coalesce(p_plan->'persona'->>'key', '') not in ('weight_loss','wealth_building','founder','operator_promotion','parent_plus','generic')
     or coalesce(p_plan->'foreground'->>'pillar', '') not in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family')
     or jsonb_typeof(p_plan->'gates') <> 'array' or jsonb_array_length(p_plan->'gates') <> 3
     or jsonb_typeof(p_plan->'actions') <> 'object'
     or jsonb_typeof(p_plan->'floors') <> 'array'
     or jsonb_typeof(p_plan->'setup') <> 'array'
     or jsonb_typeof(p_plan->'safety') <> 'object'
     or jsonb_typeof(p_plan->'safety'->'referral') <> 'boolean'
  then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  begin
    v_start := (p_plan->>'startDate')::date;
    v_end := (p_plan->>'endDate')::date;
  exception when others then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end;
  if v_end <> v_start + 89 then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  if not (p_plan->'actions' ? coalesce(p_plan->'decision'->>'actionKey', '')) then
    raise exception 'loop_invalid_plan' using errcode = '22023';
  end if;
  for v_key in select jsonb_array_elements_text(p_plan->'floors') loop
    if not (p_plan->'actions' ? v_key) then
      raise exception 'loop_invalid_plan' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function private.apm_service_create_goal(p_user_id uuid, p_goal jsonb, p_plan jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := p_user_id;
  v_key text;
  v_title text := btrim(coalesce(p_goal->>'title', ''));
  v_pillar text := nullif(p_goal->>'pillar', '');
  v_target date;
  v_goal public.goals;
  v_plan jsonb;
begin
  if p_user_id is null or not private.apm_has_core_access(p_user_id) then
    raise exception 'loop_entitlement_required' using errcode = '42501';
  end if;
  if p_goal is null or jsonb_typeof(p_goal) <> 'object' then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_goal) loop
    if v_key not in ('title','outcome','pillar','targetDate') then
      raise exception 'loop_field_not_allowed' using errcode = '22023';
    end if;
  end loop;
  if char_length(v_title) not between 3 and 300 or char_length(coalesce(p_goal->>'outcome', '')) > 800 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if v_pillar is not null and v_pillar not in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family') then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  begin
    v_target := nullif(p_goal->>'targetDate', '')::date;
  exception when others then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end;
  if private.apm_loop_week_one_locked(v_uid) then
    raise exception 'loop_week_one_lock' using errcode = '55000';
  end if;

  insert into public.goals (user_id, title, outcome, status, health, pillar, target_date, priority, provenance_kind, source_type, confidence)
  values (
    v_uid, v_title, nullif(btrim(coalesce(p_goal->>'outcome', '')), ''), 'active', 'unknown', v_pillar, v_target,
    coalesce((select max(g.priority) from public.goals g where g.user_id = v_uid and g.status = 'active'), 0) + 1,
    'stated', 'manual', 1
  )
  returning * into v_goal;

  perform private.apm_loop_audit(v_uid, 'goal.created', 'goal', v_goal.id::text, jsonb_build_object('pillar', v_pillar, 'priority', v_goal.priority));
  v_plan := private.apm_service_save_goal_plan(v_uid, v_goal.id, p_plan, 'goals');
  return jsonb_build_object('goal', to_jsonb(v_goal), 'plan', v_plan);
end;
$$;

create or replace function private.apm_close_day_review(
  p_verdict text,
  p_computed_verdict text,
  p_pillar_review jsonb,
  p_note text,
  p_carry_forward text,
  p_insight text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.apm_loop_require_access();
  v_today date := private.apm_local_today(v_uid);
  v_entry jsonb;
  v_key text;
  v_row public.day_records;
begin
  if p_verdict not in ('full_day','mvd','miss') or p_computed_verdict not in ('full_day','mvd','miss')
     or char_length(coalesce(p_note, '')) > 1000 or char_length(coalesce(p_insight, '')) > 300
     or (p_carry_forward is not null and char_length(btrim(p_carry_forward)) not between 5 and 200) then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  if p_pillar_review is null or jsonb_typeof(p_pillar_review) <> 'array' or jsonb_array_length(p_pillar_review) > 16 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  for v_entry in select e from jsonb_array_elements(p_pillar_review) e loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception 'loop_invalid_request' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(v_entry) loop
      if v_key not in ('pillar','score','completed') then
        raise exception 'loop_field_not_allowed' using errcode = '22023';
      end if;
    end loop;
    if coalesce(v_entry->>'pillar', '') not in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family')
       or coalesce(v_entry->>'score', '') not in ('hit','partial','miss')
       or char_length(coalesce(v_entry->>'completed', '')) > 300 then
      raise exception 'loop_invalid_request' using errcode = '22023';
    end if;
  end loop;

  -- Evidence before verdict (as 0023/0024): no Full Day / MVD without today's check-in
  -- and completion evidence; a closed day stays closed.
  if p_verdict <> 'miss' and not private.apm_loop_day_opened(v_uid, v_today) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  if exists (select 1 from public.day_records d where d.user_id = v_uid and d.day = v_today and d.closed_at is not null) then
    raise exception 'loop_day_closed' using errcode = '55000';
  end if;
  if p_verdict <> 'miss' and not private.apm_loop_has_evidence(v_uid, v_today) then
    raise exception 'loop_verdict_needs_evidence' using errcode = '55000';
  end if;
  if p_verdict = 'full_day' and private.apm_loop_max_verdict(v_uid, v_today) <> 'full_day' then
    raise exception 'loop_verdict_needs_evidence' using errcode = '55000';
  end if;

  insert into public.day_records (user_id, day, mode, verdict, computed_verdict, pillar_review, completed_action_ids, note, carry_forward, insight, closed_at, updated_at)
  values (
    v_uid, v_today,
    coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
    p_verdict, p_computed_verdict, p_pillar_review,
    coalesce((select array_agg(c.id) from public.plan_action_completions c where c.user_id = v_uid and c.day = v_today), '{}'),
    nullif(btrim(coalesce(p_note, '')), ''), nullif(btrim(coalesce(p_carry_forward, '')), ''), nullif(btrim(coalesce(p_insight, '')), ''),
    now(), now()
  )
  on conflict (user_id, day) do update set
    verdict = excluded.verdict, computed_verdict = excluded.computed_verdict, pillar_review = excluded.pillar_review,
    completed_action_ids = excluded.completed_action_ids, note = excluded.note, carry_forward = excluded.carry_forward,
    insight = excluded.insight, closed_at = excluded.closed_at, updated_at = now()
  returning * into v_row;

  perform private.apm_loop_audit(v_uid, 'day.closed', 'day_record', v_row.id::text, jsonb_build_object(
    'verdict', p_verdict, 'computed', p_computed_verdict, 'overridden', p_verdict <> p_computed_verdict,
    'carried', v_row.carry_forward is not null, 'day', v_today));
  return to_jsonb(v_row);
end;
$$;

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
      if jsonb_typeof(p_value) <> 'object' or coalesce(p_value->>'name', '') not in ('work','money','learning','focus','mental_health','movement','food','sleep','weight','health_routines','faith','meditation','gratitude','nature','service','family')
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

-- Older clients may still send a legacy pillar key: mapped to its area, never refused.
create or replace function public.apm_save_onboarding(
  p_display_name text,
  p_roles text[],
  p_primary_goal text,
  p_current_season text default null,
  p_becoming text default null,
  p_pillar text default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid := gen_random_uuid();
  v_role text;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  insert into public.user_profiles (user_id, display_name, current_season, becoming, updated_at)
  values (v_user_id, p_display_name, p_current_season, p_becoming, now())
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  foreach v_role in array p_roles loop
    insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
    values (v_user_id, v_role, true, 'stated', 'manual', 1);
  end loop;

  update public.goals
     set priority = priority + 1,
         updated_at = now()
   where user_id = v_user_id;

  insert into public.goals (
    id, user_id, title, status, health, pillar, priority,
    provenance_kind, source_type, confidence
  ) values (
    v_goal_id, v_user_id, p_primary_goal, 'active', 'unknown', private.apm_legacy_area(nullif(p_pillar, ''), p_primary_goal), 1,
    'stated', 'manual', 1
  );

  -- next_actions are RPC-only (0035): the seed goes through the governed writer.
  perform private.apm_seed_next_action(v_goal_id, 'Spend 45 focused minutes advancing: ' || p_primary_goal, false);
end;
$$;

-- ---------------------------------------------------------------- D. the intake write (governed)
-- Same contract as 0043 (governed: personal_os / pillar_settings / tracks have no client
-- writes) plus: areas (`active_areas`, `critical_pillars` and `minimum_floors`
-- keyed by area; legacy pillar keys are mapped), `pillars_enabled` and `intake_profile`.
-- A payload without `active_areas` (an older client) keeps the 0035 behaviour: the four
-- legacy pillars' areas, all active.

create or replace function private.apm_save_methodology_intake(p_payload jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid;
  v_role text;
  v_track_key text;
  v_track_name text;
  v_area text;
  v_areas text[];
  v_critical text[];
  v_floors jsonb := '{}'::jsonb;
  v_key text;
  v_enabled text[];
  v_primary_goal text := nullif(btrim(coalesce(p_payload->>'primary_goal', '')), '');
  v_first_action text := nullif(btrim(coalesce(p_payload->>'first_next_action', '')), '');
  v_active_mode text := coalesce(nullif(p_payload->>'active_mode', ''), 'standard');
  v_goal_area text;
  v_existing boolean;
  v_track jsonb;
begin
  if v_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_catalog.octet_length(p_payload::text) > 131072 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  if v_primary_goal is null then
    raise exception 'primary_goal_required' using errcode = '22023';
  end if;
  if v_active_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if p_payload ? 'intake_profile' and p_payload->'intake_profile' <> 'null'::jsonb
     and (jsonb_typeof(p_payload->'intake_profile') <> 'object' or p_payload->'intake_profile' ? 'catchAll') then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Areas: active, critical, floors (legacy pillar keys mapped, unknown keys refused).
  if p_payload ? 'active_areas' then
    select coalesce(array_agg(distinct private.apm_legacy_area(a.value, null)), '{}') into v_areas
      from jsonb_array_elements_text(p_payload->'active_areas') a(value);
  else
    -- An older client: the four legacy pillars' areas (spirit's area read from its floor).
    v_areas := array['work','money','movement', private.apm_legacy_area('spirit', p_payload->'minimum_floors'->>'spirit')];
  end if;
  select coalesce(array_agg(distinct private.apm_legacy_area(c.value, p_payload->'minimum_floors'->>c.value)), '{}') into v_critical
    from jsonb_array_elements_text(coalesce(p_payload->'critical_pillars', '[]'::jsonb)) c(value);
  for v_key in select jsonb_object_keys(coalesce(p_payload->'minimum_floors', '{}'::jsonb)) loop
    v_area := private.apm_legacy_area(v_key, p_payload->'minimum_floors'->>v_key);
    if nullif(btrim(coalesce(p_payload->'minimum_floors'->>v_key, '')), '') is not null then
      v_floors := v_floors || jsonb_build_object(v_area, left(btrim(p_payload->'minimum_floors'->>v_key), 300));
    end if;
  end loop;
  if not (v_areas <@ private.apm_area_keys()) or not (v_critical <@ private.apm_area_keys())
     or exists (select 1 from jsonb_object_keys(v_floors) k where not (k = any (private.apm_area_keys()))) then
    raise exception 'invalid_area' using errcode = '22023';
  end if;
  v_areas := array(select distinct x from unnest(v_areas || v_critical || array(select jsonb_object_keys(v_floors))) x);

  if p_payload ? 'pillars_enabled' then
    if exists (select 1 from jsonb_array_elements_text(p_payload->'pillars_enabled') e(value) where e.value not in ('mind','body','spirit')) then
      raise exception 'invalid_pillar' using errcode = '22023';
    end if;
    -- Canonical order: Mind, Body, Spirit.
    v_enabled := array(select p from unnest(array['mind','body','spirit']) with ordinality as t(p, o)
                        where p_payload->'pillars_enabled' ? p order by o);
  else
    v_enabled := array['mind','body','spirit'];
  end if;

  v_goal_area := private.apm_legacy_area(nullif(p_payload->>'pillar', ''), v_primary_goal);
  if v_goal_area is not null and not (v_goal_area = any (private.apm_area_keys())) then
    raise exception 'invalid_area' using errcode = '22023';
  end if;

  select exists (select 1 from public.personal_os p where p.user_id = v_user_id) into v_existing;

  insert into public.user_profiles (user_id, display_name, timezone, current_season, becoming, updated_at)
  values (
    v_user_id,
    left(coalesce(p_payload->>'display_name', ''), 120),
    nullif(p_payload->>'timezone', ''),
    nullif(p_payload->>'current_season', ''),
    nullif(p_payload->>'becoming', ''),
    now()
  )
  on conflict (user_id) do update set
    -- An empty name (a quick-start install before the account step) never erases one.
    display_name = coalesce(nullif(excluded.display_name, ''), public.user_profiles.display_name),
    timezone = excluded.timezone,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  for v_role in select jsonb_array_elements_text(coalesce(p_payload->'roles', '[]'::jsonb))
  loop
    if btrim(v_role) <> '' then
      insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
      values (v_user_id, left(btrim(v_role), 120), true, 'stated', 'manual', 1)
      on conflict (user_id, name) do update set active = true;
    end if;
  end loop;

  select g.id into v_goal_id
    from public.goals g
   where g.user_id = v_user_id and g.status = 'active' and g.priority = 1
   order by g.updated_at desc
   limit 1;

  if v_goal_id is null then
    v_goal_id := gen_random_uuid();
    update public.goals set priority = priority + 1, updated_at = now() where user_id = v_user_id;
    insert into public.goals (
      id, user_id, title, outcome, status, health, pillar, target_date, priority,
      provenance_kind, source_type, confidence
    ) values (
      v_goal_id, v_user_id, v_primary_goal, nullif(p_payload->>'goal_outcome', ''), 'active', 'unknown',
      v_goal_area, nullif(p_payload->>'goal_target_date', '')::date, 1, 'stated', 'manual', 1
    );
  else
    update public.goals
       set title = v_primary_goal,
           outcome = nullif(p_payload->>'goal_outcome', ''),
           pillar = v_goal_area,
           target_date = nullif(p_payload->>'goal_target_date', '')::date,
           updated_at = now()
     where id = v_goal_id and user_id = v_user_id;
  end if;

  -- next_actions are RPC-only (0035): seeds go through the governed writer.
  if v_first_action is not null then
    perform private.apm_seed_next_action(v_goal_id, v_first_action, true);
  elsif not exists (
    select 1 from public.next_actions n where n.user_id = v_user_id and n.goal_id = v_goal_id and n.status = 'open'
  ) then
    perform private.apm_seed_next_action(v_goal_id, 'Spend 45 focused minutes advancing: ' || v_primary_goal, false);
  end if;

  insert into public.personal_os (
    user_id, north_star, core_values, non_negotiables, failure_patterns,
    body_context, work_money_context, mind_spirit_learning_context,
    weekly_cadence, coaching_style, accountability, active_mode, foreground_goal_id,
    pillars_enabled, intake_profile, installed_at, updated_at
  ) values (
    v_user_id,
    nullif(p_payload->>'north_star', ''),
    coalesce(p_payload->'values', '[]'::jsonb),
    coalesce(p_payload->'non_negotiables', '[]'::jsonb),
    coalesce(p_payload->'failure_patterns', '[]'::jsonb),
    nullif(p_payload->>'body_context', ''),
    nullif(p_payload->>'work_money_context', ''),
    nullif(p_payload->>'mind_spirit_learning_context', ''),
    coalesce(p_payload->'weekly_cadence', '{"heavyDays":[],"lightDays":[]}'::jsonb),
    coalesce(p_payload->'coaching_style', '{"firmness":"direct"}'::jsonb),
    coalesce(p_payload->'accountability', '{"dayStart":"guided"}'::jsonb),
    v_active_mode,
    v_goal_id,
    v_enabled,
    case when jsonb_typeof(p_payload->'intake_profile') = 'object' then p_payload->'intake_profile' end,
    now(),
    now()
  )
  on conflict (user_id) do update set
    north_star = excluded.north_star,
    core_values = excluded.core_values,
    non_negotiables = excluded.non_negotiables,
    failure_patterns = excluded.failure_patterns,
    body_context = excluded.body_context,
    work_money_context = excluded.work_money_context,
    mind_spirit_learning_context = excluded.mind_spirit_learning_context,
    weekly_cadence = excluded.weekly_cadence,
    coaching_style = excluded.coaching_style,
    accountability = excluded.accountability,
    active_mode = excluded.active_mode,
    foreground_goal_id = excluded.foreground_goal_id,
    pillars_enabled = excluded.pillars_enabled,
    intake_profile = coalesce(excluded.intake_profile, public.personal_os.intake_profile),
    updated_at = now();

  -- As 0043: never stabilization_started_at, body_referral_* or clinician_cleared_at here.
  if jsonb_typeof(coalesce(p_payload->'morning_sequence', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload->'morning_sequence', '[]'::jsonb)) > 5
     or jsonb_typeof(coalesce(p_payload->'hard_boundaries', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload->'hard_boundaries', '[]'::jsonb)) > 20
     or coalesce(p_payload->>'scheduling_preference', 'ordered_stack') not in ('strict_blocks','loose_dayparts','ordered_stack')
     or jsonb_typeof(coalesce(p_payload->'scoring_config', '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_request';
  end if;
  update public.personal_os set
    morning_sequence = coalesce(p_payload->'morning_sequence', '[]'::jsonb),
    scheduling_preference = coalesce(p_payload->>'scheduling_preference', 'ordered_stack'),
    hard_boundaries = coalesce(p_payload->'hard_boundaries', '[]'::jsonb),
    scoring_config = coalesce(p_payload->'scoring_config', '{"enabled":true,"showSevenDaySnapshot":true}'::jsonb),
    updated_at = now()
  where user_id = v_user_id;

  -- One row per area she has (active or switched off with her pillar); critical and floor per area.
  delete from public.pillar_settings where user_id = v_user_id;
  foreach v_area in array v_areas
  loop
    insert into public.pillar_settings (user_id, name, active, critical, minimum_floor)
    values (
      v_user_id,
      v_area,
      private.apm_area_pillar(v_area) = any (v_enabled) or v_area = v_goal_area,
      v_area = any (v_critical),
      nullif(v_floors->>v_area, '')
    );
  end loop;

  -- The full Track set the user chose, with the display names the Worker passes (0043).
  if jsonb_typeof(coalesce(p_payload->'tracks', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_payload->'tracks', '[]'::jsonb)) > 7 then
    raise exception 'invalid_tracks';
  end if;
  delete from public.tracks where user_id = v_user_id;
  for v_track in select jsonb_array_elements(coalesce(p_payload->'tracks', '[]'::jsonb))
  loop
    v_track_key := v_track->>'key';
    v_track_name := btrim(coalesce(v_track->>'name', ''));
    if v_track_key is null or char_length(v_track_name) not between 1 and 120 then
      raise exception 'invalid_tracks';
    end if;
    insert into public.tracks (user_id, key, name, active, foreground, provenance_kind, source_type, confidence)
    values (v_user_id, v_track_key, v_track_name, true, false, 'stated', 'manual', 1)
    on conflict (user_id, key) do update set name = excluded.name, active = true;
  end loop;

  delete from public.operating_modes where user_id = v_user_id;
  insert into public.operating_modes (user_id, key, name, active, provenance_kind, source_type, confidence)
  values
    (v_user_id, 'standard', 'Standard', v_active_mode = 'standard', 'system', 'system', 1),
    (v_user_id, 'recovery', 'Recovery', v_active_mode = 'recovery', 'system', 'system', 1),
    (v_user_id, 'high_pressure', 'High-Pressure Coaching', v_active_mode = 'high_pressure', 'system', 'system', 1),
    (v_user_id, 'executive_review', 'Executive Review', v_active_mode = 'executive_review', 'system', 'system', 1),
    (v_user_id, 'sprint', 'Sprint', false, 'system', 'system', 1),
    (v_user_id, 'deep_work', 'Deep Work', false, 'system', 'system', 1);

  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (v_user_id, case when v_existing then 'personal_os.reinstalled' else 'personal_os.intake_saved' end, 'user', 'personal_os', v_user_id::text,
          jsonb_build_object('areas', cardinality(v_areas), 'critical', cardinality(v_critical), 'pillarsEnabled', to_jsonb(v_enabled),
                             'profile', jsonb_typeof(p_payload->'intake_profile') = 'object'));
end;
$$;

create or replace function public.apm_save_methodology_intake(p_payload jsonb)
returns void language sql volatile security invoker set search_path = ''
as $$ select private.apm_save_methodology_intake(p_payload); $$;

revoke all on function private.apm_save_methodology_intake(jsonb) from public, anon;
grant execute on function private.apm_save_methodology_intake(jsonb) to authenticated;
revoke all on function public.apm_save_methodology_intake(jsonb) from public, anon;
grant execute on function public.apm_save_methodology_intake(jsonb) to authenticated;
