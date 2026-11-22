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
  -- greatest(): a signed-in client may insert its own usage rows, so a negative cost it writes
  -- can never lower its own month (abuse case, review of #98).
  select coalesce(sum(greatest(cost_microusd, 0)), 0)::bigint
    from public.ai_usage_events
   where user_id = p_user_id
     and created_at >= p_since;
$$;

revoke all on function public.apm_ai_cost_microusd_since(uuid, timestamptz) from public;
revoke all on function public.apm_ai_cost_microusd_since(uuid, timestamptz) from anon, authenticated;
grant execute on function public.apm_ai_cost_microusd_since(uuid, timestamptz) to service_role;

-- DeepSeek V4.1 Flash for coaching, the current route (Mistral Small 3.2) as its fallback (owner
-- plan 21 Nov 2026: "DeepSeek with fallback ... if it passes APM's test set"; the Peace Be Still
-- precedent, seq23/peace-be-still #89). Evidence: Model Eval run 44977455899, coaching_v1, 3
-- repeats: DeepSeek 100 % pass / 100 % safety-critical / 100 % reliability, 0 guard fallbacks,
-- p50 0.89 s, p95 1.70 s, $0.0567 per 1K turns; Mistral (current) 100 / 100 / 100, p50 0.98 s,
-- p95 3.02 s, $0.0491 per 1K turns. Scope is exactly what was evaluated: coaching capabilities
-- for private_life. Policy: DeepInfra (US) endpoint, ZDR-listed on OpenRouter, requested with
-- zdr: true, data_collection: deny, allow_fallbacks: false; never DeepSeek's own API. Thinking
-- off (reasoning_disabled). It outranks Mistral on latency only, so Mistral stays next in line.
alter table public.model_routes add column if not exists reasoning_disabled boolean not null default false;

insert into public.model_routes (
  route_id, model_id, provider_id, status, cost_class, capabilities,
  data_classes_allowed, training_allowed, retention, approved_for_highly_sensitive,
  quality_score, reliability_score, latency_score, policy_notes, last_policy_reviewed_at,
  last_eval_run_at, reasoning_disabled
) values (
  'or_deepseek_v4_1_flash_deepinfra',
  'deepseek/deepseek-v4.1-flash',
  'DeepInfra',
  'approved',
  'low',
  array['conversation','reasoning','structured_output'],
  array['public_synthetic','low_personal','private_life'],
  false,
  'zero',
  false,
  100, 100, 96,
  '(0107) APPROVED for coaching, first in line, Mistral Small 3.2 (or_mistral_small_3_2_24b_deepinfra) its fallback. '
  || 'coaching_v1 run 44977455899: 100 % pass / 100 % safety-critical / 100 % reliability, p50 0.89 s, $0.0567 per 1K turns. '
  || 'DeepInfra US endpoint, ZDR on OpenRouter, zdr: true, data_collection: deny, allow_fallbacks: false; never DeepSeek''s own API. '
  || 'Prices $0.45/M in, $1.80/M out at the dearest US host (PBS #89); the ledger records OpenRouter''s billed cost.',
  now(),
  '2026-11-22T02:49:29Z',
  true
)
on conflict (route_id) do nothing;
