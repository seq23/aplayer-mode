-- 0020: BHPC coaching that works without a model, Modes as explicit state, and
-- the app-only Track set.
--
--  A. Tracks: the installable set becomes the 4 BHPC Tracks + Body Foundation,
--     Wealth Foundation and Home Front. Manifestation Mastery and Investor + AI
--     Leverage are retired: every existing row is recorded as a `track.retired`
--     audit event (key, name, flags; flagged for the user's review) and then
--     removed. Nothing is silently re-mapped onto a Track the user did not choose.
--  B. Modes: personal_os gains the timing state BHPC defines (Sprint ≤ 14 days,
--     Deep Work 15 min – 4 h with one task, the mandatory post-sprint recovery
--     day, what a Deep Work block / Executive Review returns to). A guard
--     trigger makes the recovery day impossible to skip and clears stale timing
--     whenever a caller changes the mode without supplying it.
--  C. Coaching sessions carry the state-machine phase so one-question cadence,
--     the close into the Morning Sequence and the safety stop survive turns.
--  D. The coaching model route stays `candidate`; its registry note records that
--     promotion needs the coaching eval report and human review (docs/23).

-- ---------------------------------------------------------------- A. Tracks
insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
select t.user_id, 'track.retired', 'system', 'migration:0020', 'track', t.id::text,
       jsonb_build_object(
         'key', t.key,
         'name', t.name,
         'was_active', t.active,
         'was_foreground', t.foreground,
         'review', true,
         'reason', 'Retired from the APM Track library on 2026-10-06; Wealth Foundation, Body Foundation and Home Front are the app-only Tracks.'
       )
  from public.tracks t
 where t.key in ('manifestation_mastery', 'investor_ai_leverage');

delete from public.tracks where key in ('manifestation_mastery', 'investor_ai_leverage');

alter table public.tracks drop constraint if exists tracks_key_check;
alter table public.tracks add constraint tracks_key_check
  check (key in ('billionaire_mindset','operator_discipline','strategic_patience','resilience','body_foundation','wealth_foundation','home_front'));

-- ----------------------------------------------------------------- B. Modes
-- Repair: 0004 gave operating_modes.provenance_kind the default 'system' but a
-- check that excludes it, so the intake RPC (and the API's mode upsert) could
-- never insert a mode row. Allow the provenance every writer actually uses.
alter table public.operating_modes drop constraint if exists operating_modes_provenance_kind_check;
alter table public.operating_modes add constraint operating_modes_provenance_kind_check
  check (provenance_kind in ('stated','observed','inferred','imported','system'));

alter table public.personal_os
  add column mode_started_at timestamptz,
  add column mode_ends_at timestamptz,
  add column mode_focus text check (mode_focus is null or char_length(mode_focus) between 1 and 200),
  add column recovery_locked_until timestamptz,
  add column mode_resume jsonb check (
    mode_resume is null
    or (jsonb_typeof(mode_resume) = 'object' and mode_resume->>'mode' in ('standard','high_pressure','sprint'))
  );

-- Sprint / Deep Work rows written before this migration have no declared
-- duration, which BHPC does not allow. Return them to Standard, on the record.
insert into public.audit_events (user_id, event_type, actor_type, actor_ref, object_type, object_id, metadata)
select p.user_id, 'operating_mode.reset', 'system', 'migration:0020', 'personal_os', p.user_id::text,
       jsonb_build_object('from', p.active_mode, 'to', 'standard', 'reason', 'Sprint and Deep Work now require a declared duration.')
  from public.personal_os p
 where p.active_mode in ('sprint','deep_work');
update public.operating_modes o set active = (o.key = 'standard')
 where o.user_id in (select user_id from public.personal_os where active_mode in ('sprint','deep_work'));
update public.personal_os set active_mode = 'standard', updated_at = now() where active_mode in ('sprint','deep_work');

alter table public.personal_os add constraint personal_os_mode_timing_check check (
  case active_mode
    when 'sprint' then
      mode_started_at is not null and mode_ends_at is not null and mode_focus is not null
      and mode_ends_at > mode_started_at
      and mode_ends_at <= mode_started_at + interval '14 days 1 hour'
    when 'deep_work' then
      mode_started_at is not null and mode_ends_at is not null and mode_focus is not null
      and mode_ends_at >= mode_started_at + interval '15 minutes'
      and mode_ends_at <= mode_started_at + interval '4 hours'
    when 'recovery' then
      mode_ends_at is null or (mode_started_at is not null and mode_ends_at > mode_started_at)
    else
      mode_ends_at is null and mode_focus is null
  end
);

create or replace function public.apm_personal_os_mode_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_locked boolean := old.recovery_locked_until is not null and old.recovery_locked_until > now() + interval '2 minutes';
begin
  -- The post-sprint recovery day is mandatory: neither the mode nor the lock
  -- itself can change until it has passed.
  if v_locked and (new.active_mode <> 'recovery' or new.recovery_locked_until is distinct from old.recovery_locked_until) then
    raise exception 'recovery_day_required';
  end if;
  -- A caller that changes the mode without supplying timing (e.g. the intake
  -- RPC or apm_set_operating_mode) never inherits the old mode's timing.
  if new.active_mode is distinct from old.active_mode and new.mode_started_at is not distinct from old.mode_started_at then
    new.mode_started_at := null;
    new.mode_ends_at := null;
    new.mode_focus := null;
    new.mode_resume := null;
    if new.active_mode <> 'recovery' then
      new.recovery_locked_until := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists personal_os_mode_guard on public.personal_os;
create trigger personal_os_mode_guard
  before update on public.personal_os
  for each row execute function public.apm_personal_os_mode_guard();

-- Writes a mode state the API computed with the deterministic transition rules
-- (services/api/src/coach/modes.ts); the check constraint and the guard
-- trigger re-enforce the BHPC invariants for every writer.
create or replace function public.apm_set_mode_state(
  p_mode text,
  p_started_at timestamptz,
  p_ends_at timestamptz,
  p_focus text,
  p_recovery_locked_until timestamptz,
  p_resume jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review','sprint','deep_work') then
    raise exception 'invalid_mode';
  end if;
  update public.personal_os
     set active_mode = p_mode,
         mode_started_at = p_started_at,
         mode_ends_at = p_ends_at,
         mode_focus = nullif(trim(coalesce(p_focus, '')), ''),
         recovery_locked_until = p_recovery_locked_until,
         mode_resume = p_resume,
         updated_at = now()
   where user_id = v_user_id;
  if not found then raise exception 'personal_os_missing'; end if;
  update public.operating_modes set active = (key = p_mode) where user_id = v_user_id;
end;
$$;
revoke all on function public.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) from public, anon;
grant execute on function public.apm_set_mode_state(text, timestamptz, timestamptz, text, timestamptz, jsonb) to authenticated;

-- The untimed setter can no longer start a Sprint or Deep Work (they need a
-- declared duration) and goes through the same recovery-day guard.
create or replace function public.apm_set_operating_mode(p_mode text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_mode in ('sprint','deep_work') then raise exception 'mode_requires_duration'; end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;
  update public.personal_os set active_mode = p_mode, updated_at = now() where user_id = v_user_id;
  update public.operating_modes set active = (key = p_mode) where user_id = v_user_id;
end;
$$;
revoke all on function public.apm_set_operating_mode(text) from public, anon;
grant execute on function public.apm_set_operating_mode(text) to authenticated;

-- ------------------------------------------------------- C. Coaching sessions
update public.coaching_sessions
   set mode = 'standard'
 where mode not in ('standard','recovery','high_pressure','executive_review','sprint','deep_work');

alter table public.coaching_sessions
  add column phase text not null default 'exploring'
    check (phase in ('exploring','closure_offered','morning_sequence','closed','safety_stop')),
  add column questions_asked integer not null default 0 check (questions_asked between 0 and 20),
  add column deeper_rounds integer not null default 0 check (deeper_rounds between 0 and 2),
  add column engine text not null default 'scripted' check (engine in ('scripted','model')),
  add column updated_at timestamptz not null default now(),
  add constraint coaching_sessions_mode_check
    check (mode in ('standard','recovery','high_pressure','executive_review','sprint','deep_work'));

update public.coaching_sessions set phase = 'closed' where status = 'closed';

-- A safety-stopped or closed session is never open.
alter table public.coaching_sessions add constraint coaching_sessions_phase_status_check
  check (phase not in ('closed','safety_stop') or status = 'closed');

-- ---------------------------------------------------- D. Coaching model route
update public.model_routes
   set policy_notes = coalesce(policy_notes, '') ||
         ' | 2026-10-06 (0020): proposed coaching route. Remains candidate: promotion requires the coaching eval suite '
         || '(scripts/evaluate-openrouter-routes.mjs, suite coaching_v1) report, a fresh provider-policy recheck and human review, '
         || 'recorded per docs/23. Until then coaching runs the deterministic BHPC flow.',
       updated_at = now()
 where route_id = 'or_apodex_1_1_mini_novita_free'
   and status = 'candidate'
   and position('(0020)' in coalesce(policy_notes, '')) = 0;
