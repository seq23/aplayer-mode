-- 0107: one user's billed model cost since a time, for the hidden monthly backstop (21 Nov 2026).
-- Additive only. src/paidCalls.ts (claimPaidCall) calls it with the service key before every
-- billed model call; a failed read refuses the call. Sums cost_microusd (OpenRouter's own
-- charge) over the existing (user_id, created_at) index. Only the service role may call it.
create or replace function public.apm_ai_cost_microusd_since(p_user_id uuid, p_since timestamptz)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(cost_microusd), 0)::bigint
    from public.ai_usage_events
   where user_id = p_user_id
     and created_at >= p_since;
$$;

revoke all on function public.apm_ai_cost_microusd_since(uuid, timestamptz) from public;
revoke all on function public.apm_ai_cost_microusd_since(uuid, timestamptz) from anon, authenticated;
grant execute on function public.apm_ai_cost_microusd_since(uuid, timestamptz) to service_role;
