-- 0037: a Drafting Room pillar-floor change regenerates plans on its EFFECTIVE date
-- (Codex P2 on PR #24).
--
-- apm_apply_os_change records effective_from = tomorrow and promises that today is not
-- changed. 0035's Worker rebuilt the affected plans at apply time, so an unlocked Today
-- already used tomorrow's floor. Now the Worker reconciles on read: every applied pillar
-- change whose effective date has arrived and whose plans have not been rebuilt is
-- rebuilt once (in place, 0036) and marked. Failures are retried on the next read, so a
-- partially failed rebuild can never strand an applied change (the earlier P2).

alter table public.os_change_requests
  add column plans_rebuilt_at timestamptz;

create or replace function private.apm_service_pending_pillar_rebuilds(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'pillar', r.proposed->>'name') order by r.applied_at, r.id), '[]'::jsonb)
  from public.os_change_requests r
  where r.user_id = p_user_id and r.field = 'pillar' and r.status = 'applied'
    and r.plans_rebuilt_at is null and r.effective_from <= private.apm_local_today(p_user_id);
$$;

create or replace function private.apm_service_mark_pillar_rebuilt(p_user_id uuid, p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_found uuid;
begin
  update public.os_change_requests r set plans_rebuilt_at = now()
   where r.id = p_id and r.user_id = p_user_id and r.field = 'pillar' and r.status = 'applied'
     and r.plans_rebuilt_at is null and r.effective_from <= private.apm_local_today(p_user_id)
  returning r.id into v_found;
  if v_found is not null then
    perform private.apm_loop_audit(p_user_id, 'os_change.plans_rebuilt', 'os_change_request', p_id::text, '{}'::jsonb);
  end if;
  return v_found is not null;
end;
$$;

create or replace function public.apm_service_pending_pillar_rebuilds(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.apm_service_pending_pillar_rebuilds(p_user_id); $$;
create or replace function public.apm_service_mark_pillar_rebuilt(p_user_id uuid, p_id uuid)
returns boolean language sql volatile security invoker set search_path = ''
as $$ select private.apm_service_mark_pillar_rebuilt(p_user_id, p_id); $$;

revoke all on function private.apm_service_pending_pillar_rebuilds(uuid) from public, anon, authenticated;
revoke all on function private.apm_service_mark_pillar_rebuilt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apm_service_pending_pillar_rebuilds(uuid) from public, anon, authenticated;
revoke all on function public.apm_service_mark_pillar_rebuilt(uuid, uuid) from public, anon, authenticated;
grant execute on function private.apm_service_pending_pillar_rebuilds(uuid) to service_role;
grant execute on function private.apm_service_mark_pillar_rebuilt(uuid, uuid) to service_role;
grant execute on function public.apm_service_pending_pillar_rebuilds(uuid) to service_role;
grant execute on function public.apm_service_mark_pillar_rebuilt(uuid, uuid) to service_role;
