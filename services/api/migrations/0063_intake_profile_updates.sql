-- 0063: answers given after install ("2 quick taps to sharpen your plan", docs/34 §4.6).
--
-- Quick-start users answer the rest of the setup on Today, at most 2 a day from Day 2. Those
-- answers update the structured profile (personal_os.intake_profile) through this governed
-- writer. BHPC Week-1 rules hold: before Day 8 the update is refused (the client keeps it as
-- a draft and sends it on Day 8). The body safety answer is never held: the API applies it at
-- once through the governed body-referral path, whatever the day.

create or replace function private.apm_update_intake_profile(p_profile jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.personal_os;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' or p_profile ? 'catchAll'
     or octet_length(p_profile::text) > 32768 then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;
  select * into v_row from public.personal_os p where p.user_id = v_uid for update;
  if v_row.user_id is null then
    raise exception 'personal_os_missing' using errcode = '55000';
  end if;
  if private.apm_loop_week_one_locked(v_uid) then
    raise exception 'loop_week_one_lock' using errcode = '55000';
  end if;
  update public.personal_os
     set intake_profile = p_profile, updated_at = now()
   where user_id = v_uid
  returning * into v_row;
  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (v_uid, 'personal_os.profile_updated', 'user', 'personal_os', v_uid::text,
          jsonb_build_object('deferred', coalesce(jsonb_array_length(p_profile->'deferredQuestionIds'), 0)));
  return jsonb_build_object('updated', true);
end;
$$;

create or replace function public.apm_update_intake_profile(p_profile jsonb)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_update_intake_profile(p_profile); $$;

revoke all on function private.apm_update_intake_profile(jsonb) from public, anon;
grant execute on function private.apm_update_intake_profile(jsonb) to authenticated;
revoke all on function public.apm_update_intake_profile(jsonb) from public, anon;
grant execute on function public.apm_update_intake_profile(jsonb) to authenticated;
