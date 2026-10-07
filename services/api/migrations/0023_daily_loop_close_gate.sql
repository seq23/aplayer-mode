-- 0023: daily-loop hardening, second Codex pass on PR #14.
--
--  1. Evidence before verdict: once a live goal plan exists, a Full Day or MVD close
--     needs today's check-in (the opening step). A Miss can always be recorded.
--  2. The legacy next-action completion only completes an action printed on today's
--     locked agenda; a Minimum Viable Day holds the backlog, so it cannot be cleared
--     around the one-action rule.

create or replace function private.apm_loop_day_opened(p_user_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.goal_plans gp where gp.user_id = p_user_id and gp.status <> 'superseded')
      or exists (select 1 from public.day_records d where d.user_id = p_user_id and d.day = p_day and d.checked_in_at is not null);
$$;
revoke all on function private.apm_loop_day_opened(uuid, date) from public, anon;
grant execute on function private.apm_loop_day_opened(uuid, date) to authenticated;

create or replace function private.apm_close_day(p_verdict text, p_note text default null)
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
  if p_verdict not in ('full_day','mvd','miss') or char_length(coalesce(p_note, '')) > 1000 then
    raise exception 'loop_invalid_request' using errcode = '22023';
  end if;
  -- Evidence before verdict: once the daily loop runs, a Full Day or an MVD needs the
  -- check-in (the opening step). Without it, the day can still be closed as a Miss.
  if p_verdict <> 'miss' and not private.apm_loop_day_opened(v_uid, v_today) then
    raise exception 'loop_opening_step_required' using errcode = '55000';
  end if;
  insert into public.day_records (user_id, day, mode, verdict, completed_action_ids, note, closed_at, updated_at)
  values (
    v_uid, v_today,
    coalesce((select p.active_mode from public.personal_os p where p.user_id = v_uid), 'standard'),
    p_verdict,
    coalesce((select array_agg(c.id) from public.plan_action_completions c where c.user_id = v_uid and c.day = v_today), '{}'),
    nullif(btrim(coalesce(p_note, '')), ''),
    now(), now()
  )
  on conflict (user_id, day) do update set
    verdict = excluded.verdict,
    completed_action_ids = excluded.completed_action_ids,
    note = excluded.note,
    closed_at = excluded.closed_at,
    updated_at = now()
  returning * into v_row;
  perform private.apm_loop_audit(v_uid, 'day.closed', 'day_record', v_row.id::text, jsonb_build_object('verdict', p_verdict, 'day', v_today));
  return to_jsonb(v_row);
end;
$$;


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
  v_day public.day_records%rowtype;
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

  -- Once the daily loop runs, execution starts after the opening step and stops at the close.
  if exists (select 1 from public.goal_plans gp where gp.user_id = v_user_id and gp.status <> 'superseded') then
    select * into v_day from public.day_records d where d.user_id = v_user_id and d.day = private.apm_local_today(v_user_id);
    if v_day.id is null or v_day.checked_in_at is null then
      raise exception 'loop_opening_step_required' using errcode = '55000';
    end if;
    if v_day.closed_at is not null then
      raise exception 'loop_day_closed' using errcode = '55000';
    end if;
    -- Only an action printed on today's locked agenda (an MVD holds the backlog).
    if not exists (
      select 1 from jsonb_array_elements(coalesce(v_day.agenda->'dailyStack', '[]'::jsonb)) e
       where e->>'nextActionId' = p_action_id::text
    ) and coalesce(v_day.agenda->'firstHour'->'priority'->>'nextActionId', '') <> p_action_id::text then
      raise exception 'loop_not_on_agenda' using errcode = 'P0002';
    end if;
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

revoke all on function public.apm_complete_next_action(uuid) from public, anon;
grant execute on function public.apm_complete_next_action(uuid) to authenticated;
