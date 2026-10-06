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
    v_goal_id, v_user_id, p_primary_goal, 'active', 'unknown', p_pillar, 1,
    'stated', 'manual', 1
  );

  insert into public.next_actions (
    user_id, goal_id, title, status, estimated_minutes
  ) values (
    v_user_id, v_goal_id,
    'Spend 45 focused minutes advancing: ' || p_primary_goal,
    'open', 45
  );
end;
$$;

grant execute on function public.apm_save_onboarding(text, text[], text, text, text, text) to authenticated;

create or replace function public.apm_complete_next_action(p_action_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_action public.next_actions%rowtype;
  v_evidence public.evidence%rowtype;
begin
  if v_user_id is null then
    raise exception 'unauthorized';
  end if;

  select * into v_action
    from public.next_actions
   where id = p_action_id and user_id = v_user_id
   for update;

  if not found then
    return null;
  end if;

  update public.next_actions
     set status = 'done', updated_at = now()
   where id = p_action_id and user_id = v_user_id
   returning * into v_action;

  insert into public.evidence (
    user_id, kind, summary, source_type, related_goal_id, related_action_id
  ) values (
    v_user_id, 'user_completion', 'User marked complete: ' || v_action.title,
    'manual', v_action.goal_id, v_action.id
  ) returning * into v_evidence;

  return jsonb_build_object(
    'action', to_jsonb(v_action),
    'evidence', to_jsonb(v_evidence)
  );
end;
$$;

grant execute on function public.apm_complete_next_action(uuid) to authenticated;
