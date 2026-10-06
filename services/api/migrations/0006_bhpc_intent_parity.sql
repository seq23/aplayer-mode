-- BHPC v2.1 intent-parity expansion.

alter table public.personal_os
  add column morning_sequence jsonb not null default '[]'::jsonb,
  add column scheduling_preference text not null default 'ordered_stack',
  add column hard_boundaries jsonb not null default '[]'::jsonb,
  add column scoring_config jsonb not null default '{"enabled":true,"showSevenDaySnapshot":true}'::jsonb,
  add column stabilization_started_at date not null default current_date;

alter table public.personal_os drop constraint if exists personal_os_active_mode_check;
alter table public.personal_os add constraint personal_os_active_mode_check
  check (active_mode in ('standard','recovery','high_pressure','executive_review','sprint','deep_work'));

alter table public.tracks drop constraint if exists tracks_key_check;
alter table public.tracks add constraint tracks_key_check
  check (key in ('billionaire_mindset','operator_discipline','strategic_patience','manifestation_mastery','investor_ai_leverage','resilience'));

alter table public.operating_modes drop constraint if exists operating_modes_key_check;
alter table public.operating_modes add constraint operating_modes_key_check
  check (key in ('standard','recovery','high_pressure','executive_review','sprint','deep_work'));

create or replace function public.apm_set_operating_mode(p_mode text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review','sprint','deep_work') then
    raise exception 'invalid_mode';
  end if;
  update public.personal_os set active_mode = p_mode, updated_at = now() where user_id = v_user_id;
  update public.operating_modes set active = (key = p_mode) where user_id = v_user_id;
end;
$$;
grant execute on function public.apm_set_operating_mode(text) to authenticated;

create or replace function public.apm_close_day(p_verdict text, p_note text default null)
returns public.day_records
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.day_records;
begin
  if v_user_id is null then raise exception 'unauthorized'; end if;
  if p_verdict not in ('full_day','mvd','miss') then raise exception 'invalid_verdict'; end if;
  insert into public.day_records(user_id, day, mode, verdict, completed_action_ids, note, closed_at, updated_at)
  values (
    v_user_id,
    current_date,
    coalesce((select active_mode from public.personal_os where user_id = v_user_id), 'standard'),
    p_verdict,
    coalesce((select array_agg(id) from public.next_actions where user_id=v_user_id and status='done' and updated_at::date=current_date), '{}'),
    nullif(trim(coalesce(p_note,'')), ''),
    now(), now()
  )
  on conflict (user_id, day) do update set
    verdict = excluded.verdict,
    completed_action_ids = excluded.completed_action_ids,
    note = excluded.note,
    closed_at = excluded.closed_at,
    updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.apm_close_day(text,text) to authenticated;
