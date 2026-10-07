-- 0064: permissions are written only through a governed function (backend review follow-up,
-- the same pattern as 0043 for personal_os / tracks / pillar_settings).
--
-- Until now a client could INSERT / UPDATE / DELETE its own `permissions` rows directly
-- (0005 own-row policies), so a modified app could grant itself autonomy above its plan's
-- ceiling or switch a permission on without the API's checks or an audit row. Now:
--  * no direct client writes (policies dropped, privileges revoked); SELECT stays own-row;
--  * private.apm_set_permission (SECURITY DEFINER, search_path '') is the one writer: the
--    caller's own row only, the domain list, a bounded action type and constraints, and the
--    plan's autonomy ceiling re-checked in the database (mirrors @apm/policy
--    maxAutonomyForPlan and private.apm_has_core_access: no usable plan → level 0 only);
--  * every change is audited (`permission.changed`) inside the same transaction.
-- Buying a tier still never grants autonomy: nothing here is called by billing.

drop policy if exists permissions_insert_own on public.permissions;
drop policy if exists permissions_update_own on public.permissions;
drop policy if exists permissions_delete_own on public.permissions;
revoke insert, update, delete, truncate, references, trigger on table public.permissions from anon, authenticated;

create or replace function private.apm_permission_ceiling(p_user_id uuid, p_domain text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.apm_has_core_access(p_user_id) then 0
    else coalesce((
      select case e.plan
        when 'beta' then 3
        when 'chief_of_staff' then 3
        when 'life_os' then 4
        when 'autopilot' then case when p_domain = 'purchase' then 2 else 5 end
        else 0
      end
      from public.subscription_entitlements e where e.user_id = p_user_id
    ), 0)
  end;
$$;

create or replace function private.apm_set_permission(
  p_domain text,
  p_action_type text,
  p_autonomy_level integer,
  p_constraints jsonb,
  p_enabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_level integer := case when coalesce(p_enabled, true) then p_autonomy_level else 0 end;
  v_ceiling integer;
  v_row public.permissions;
begin
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_domain is null or p_domain not in ('calendar','email','routine','life_graph','purchase','notification','connector','appointment','subscription')
     or p_action_type is null or p_action_type !~ '^[A-Za-z0-9_.:-]{1,120}$'
     or p_autonomy_level is null or p_autonomy_level not between 0 and 5
     or (p_constraints is not null and (jsonb_typeof(p_constraints) <> 'object' or octet_length(p_constraints::text) > 8192)) then
    raise exception 'permission_invalid_request' using errcode = '22023';
  end if;
  v_ceiling := private.apm_permission_ceiling(v_uid, p_domain);
  if v_level > v_ceiling then
    raise exception 'permission_above_plan_ceiling' using errcode = '42501';
  end if;

  insert into public.permissions (user_id, domain, action_type, autonomy_level, constraints, enabled, granted_at, updated_at)
  values (v_uid, p_domain, p_action_type, v_level, coalesce(p_constraints, '{}'::jsonb), v_level > 0,
          case when v_level > 0 then now() end, now())
  on conflict (user_id, domain, action_type) do update set
    autonomy_level = excluded.autonomy_level,
    constraints = excluded.constraints,
    enabled = excluded.enabled,
    granted_at = case when excluded.autonomy_level > 0 then coalesce(public.permissions.granted_at, now()) else null end,
    updated_at = now()
  returning * into v_row;

  insert into public.audit_events (user_id, event_type, actor_type, object_type, object_id, metadata)
  values (v_uid, 'permission.changed', 'user', 'permission', v_row.id::text,
          jsonb_build_object('domain', p_domain, 'actionType', p_action_type, 'autonomyLevel', v_level, 'ceiling', v_ceiling));
  return to_jsonb(v_row);
end;
$$;

create or replace function public.apm_set_permission(p_domain text, p_action_type text, p_autonomy_level integer, p_constraints jsonb, p_enabled boolean)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.apm_set_permission(p_domain, p_action_type, p_autonomy_level, p_constraints, p_enabled); $$;

revoke all on function private.apm_permission_ceiling(uuid, text) from public, anon, authenticated;
revoke all on function private.apm_set_permission(text, text, integer, jsonb, boolean) from public, anon;
grant execute on function private.apm_set_permission(text, text, integer, jsonb, boolean) to authenticated;
revoke all on function public.apm_set_permission(text, text, integer, jsonb, boolean) from public, anon;
grant execute on function public.apm_set_permission(text, text, integer, jsonb, boolean) to authenticated;
