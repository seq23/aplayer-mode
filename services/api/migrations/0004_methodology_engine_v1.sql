create table public.personal_os (
  user_id uuid primary key references auth.users(id) on delete cascade,
  north_star text,
  core_values jsonb not null default '[]'::jsonb,
  non_negotiables jsonb not null default '[]'::jsonb,
  failure_patterns jsonb not null default '[]'::jsonb,
  body_context text,
  work_money_context text,
  mind_spirit_learning_context text,
  weekly_cadence jsonb not null default '{"heavyDays":[],"lightDays":[]}'::jsonb,
  coaching_style jsonb not null default '{"firmness":"direct"}'::jsonb,
  accountability jsonb not null default '{"dayStart":"guided"}'::jsonb,
  active_mode text not null default 'standard' check (active_mode in ('standard','recovery','high_pressure','executive_review')),
  foreground_goal_id uuid references public.goals(id) on delete set null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pillar_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (name in ('wealth','body','spirit','execution')),
  active boolean not null default true,
  critical boolean not null default false,
  minimum_floor text,
  primary key (user_id, name)
);

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key in ('billionaire_mindset','operator_discipline','strategic_patience','manifestation_mastery','investor_ai_leverage')),
  name text not null,
  active boolean not null default true,
  foreground boolean not null default false,
  provenance_kind text not null default 'stated' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'manual' check (source_type in ('conversation','gmail','calendar','manual','system')),
  source_ref text,
  confidence double precision not null default 1 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  unique(user_id, key)
);
create index tracks_user_id_idx on public.tracks(user_id);

create table public.operating_modes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key in ('standard','recovery','high_pressure','executive_review')),
  name text not null,
  active boolean not null default false,
  provenance_kind text not null default 'system' check (provenance_kind in ('stated','observed','inferred','imported')),
  source_type text not null default 'system' check (source_type in ('conversation','gmail','calendar','manual','system')),
  source_ref text,
  confidence double precision not null default 1 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  unique(user_id, key)
);
create index operating_modes_user_id_idx on public.operating_modes(user_id);

alter table public.personal_os enable row level security;
alter table public.pillar_settings enable row level security;
alter table public.tracks enable row level security;
alter table public.operating_modes enable row level security;

create policy "personal_os_select_own" on public.personal_os for select to authenticated using (auth.uid() = user_id);
create policy "personal_os_insert_own" on public.personal_os for insert to authenticated with check (auth.uid() = user_id);
create policy "personal_os_update_own" on public.personal_os for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "personal_os_delete_own" on public.personal_os for delete to authenticated using (auth.uid() = user_id);

create policy "pillar_settings_select_own" on public.pillar_settings for select to authenticated using (auth.uid() = user_id);
create policy "pillar_settings_insert_own" on public.pillar_settings for insert to authenticated with check (auth.uid() = user_id);
create policy "pillar_settings_update_own" on public.pillar_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pillar_settings_delete_own" on public.pillar_settings for delete to authenticated using (auth.uid() = user_id);

create policy "tracks_select_own" on public.tracks for select to authenticated using (auth.uid() = user_id);
create policy "tracks_insert_own" on public.tracks for insert to authenticated with check (auth.uid() = user_id);
create policy "tracks_update_own" on public.tracks for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tracks_delete_own" on public.tracks for delete to authenticated using (auth.uid() = user_id);

create policy "operating_modes_select_own" on public.operating_modes for select to authenticated using (auth.uid() = user_id);
create policy "operating_modes_insert_own" on public.operating_modes for insert to authenticated with check (auth.uid() = user_id);
create policy "operating_modes_update_own" on public.operating_modes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "operating_modes_delete_own" on public.operating_modes for delete to authenticated using (auth.uid() = user_id);

create or replace function public.apm_save_methodology_intake(p_payload jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_goal_id uuid;
  v_role text;
  v_track_key text;
  v_track_name text;
  v_pillar text;
  v_primary_goal text := nullif(trim(p_payload->>'primary_goal'), '');
  v_first_action text := nullif(trim(p_payload->>'first_next_action'), '');
  v_active_mode text := coalesce(nullif(p_payload->>'active_mode', ''), 'standard');
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;
  if v_primary_goal is null then
    raise exception 'primary_goal_required';
  end if;
  if v_active_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;

  insert into public.user_profiles (user_id, display_name, timezone, current_season, becoming, updated_at)
  values (
    v_user_id,
    coalesce(p_payload->>'display_name', ''),
    nullif(p_payload->>'timezone', ''),
    nullif(p_payload->>'current_season', ''),
    nullif(p_payload->>'becoming', ''),
    now()
  )
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    timezone = excluded.timezone,
    current_season = excluded.current_season,
    becoming = excluded.becoming,
    updated_at = now();

  delete from public.roles where user_id = v_user_id;
  for v_role in select jsonb_array_elements_text(coalesce(p_payload->'roles', '[]'::jsonb))
  loop
    if trim(v_role) <> '' then
      insert into public.roles (user_id, name, active, provenance_kind, source_type, confidence)
      values (v_user_id, trim(v_role), true, 'stated', 'manual', 1)
      on conflict (user_id, name) do update set active = true;
    end if;
  end loop;

  select id into v_goal_id
    from public.goals
   where user_id = v_user_id and status = 'active' and priority = 1
   order by updated_at desc
   limit 1;

  if v_goal_id is null then
    v_goal_id := gen_random_uuid();
    update public.goals
       set priority = priority + 1, updated_at = now()
     where user_id = v_user_id;

    insert into public.goals (
      id, user_id, title, outcome, status, health, pillar, target_date, priority,
      provenance_kind, source_type, confidence
    ) values (
      v_goal_id,
      v_user_id,
      v_primary_goal,
      nullif(p_payload->>'goal_outcome', ''),
      'active',
      'unknown',
      nullif(p_payload->>'pillar', ''),
      nullif(p_payload->>'goal_target_date', '')::date,
      1,
      'stated',
      'manual',
      1
    );
  else
    update public.goals
       set title = v_primary_goal,
           outcome = nullif(p_payload->>'goal_outcome', ''),
           pillar = nullif(p_payload->>'pillar', ''),
           target_date = nullif(p_payload->>'goal_target_date', '')::date,
           updated_at = now()
     where id = v_goal_id and user_id = v_user_id;
  end if;

  if v_first_action is not null then
    update public.next_actions
       set status = 'dismissed', updated_at = now()
     where user_id = v_user_id and goal_id = v_goal_id and status = 'open';

    insert into public.next_actions (user_id, goal_id, title, status, estimated_minutes)
    values (v_user_id, v_goal_id, v_first_action, 'open', 45);
  elsif not exists (
    select 1 from public.next_actions
     where user_id = v_user_id and goal_id = v_goal_id and status = 'open'
  ) then
    insert into public.next_actions (user_id, goal_id, title, status, estimated_minutes)
    values (v_user_id, v_goal_id, 'Spend 45 focused minutes advancing: ' || v_primary_goal, 'open', 45);
  end if;

  insert into public.personal_os (
    user_id, north_star, core_values, non_negotiables, failure_patterns,
    body_context, work_money_context, mind_spirit_learning_context,
    weekly_cadence, coaching_style, accountability, active_mode, foreground_goal_id,
    installed_at, updated_at
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
    updated_at = now();

  delete from public.pillar_settings where user_id = v_user_id;
  foreach v_pillar in array array['wealth','body','spirit','execution']
  loop
    insert into public.pillar_settings (user_id, name, active, critical, minimum_floor)
    values (
      v_user_id,
      v_pillar,
      true,
      exists (
        select 1
          from jsonb_array_elements_text(coalesce(p_payload->'critical_pillars', '[]'::jsonb)) as cp(value)
         where cp.value = v_pillar
      ),
      nullif(p_payload->'minimum_floors'->>v_pillar, '')
    );
  end loop;

  delete from public.tracks where user_id = v_user_id;
  for v_track_key in select jsonb_array_elements_text(coalesce(p_payload->'track_keys', '[]'::jsonb))
  loop
    v_track_name := case v_track_key
      when 'billionaire_mindset' then 'Billionaire Mindset'
      when 'operator_discipline' then 'Operator Discipline'
      when 'strategic_patience' then 'Strategic Patience'
      when 'manifestation_mastery' then 'Manifestation Mastery'
      when 'investor_ai_leverage' then 'Investor + AI Leverage'
      else null
    end;
    if v_track_name is not null then
      insert into public.tracks (user_id, key, name, active, foreground, provenance_kind, source_type, confidence)
      values (v_user_id, v_track_key, v_track_name, true, false, 'stated', 'manual', 1);
    end if;
  end loop;

  delete from public.operating_modes where user_id = v_user_id;
  insert into public.operating_modes (user_id, key, name, active, provenance_kind, source_type, confidence)
  values
    (v_user_id, 'standard', 'Standard', v_active_mode = 'standard', 'system', 'system', 1),
    (v_user_id, 'recovery', 'Recovery', v_active_mode = 'recovery', 'system', 'system', 1),
    (v_user_id, 'high_pressure', 'High-Pressure Coaching', v_active_mode = 'high_pressure', 'system', 'system', 1),
    (v_user_id, 'executive_review', 'Executive Review', v_active_mode = 'executive_review', 'system', 'system', 1);
end;
$$;

grant execute on function public.apm_save_methodology_intake(jsonb) to authenticated;

create or replace function public.apm_set_operating_mode(p_mode text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;
  if p_mode not in ('standard','recovery','high_pressure','executive_review') then
    raise exception 'invalid_mode';
  end if;

  update public.personal_os
     set active_mode = p_mode, updated_at = now()
   where user_id = v_user_id;

  update public.operating_modes
     set active = (key = p_mode)
   where user_id = v_user_id;
end;
$$;

grant execute on function public.apm_set_operating_mode(text) to authenticated;
