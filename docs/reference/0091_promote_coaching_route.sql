-- PENDING — NOT APPLIED. Do not copy into services/api/migrations until the owner
-- has signed off as the human reviewer (docs/23 "Human review" gate). The
-- coordinator applies it after sign-off as services/api/migrations/0091_promote_coaching_route.sql.
--
-- 0091: promote the coaching route (docs/05 "conversational coaching", docs/23).
-- Evidence: docs/reference/coaching-route-eval-2026-10-06.md and the docs/23
-- coaching review note — coaching_v1 on the production prompt + No Catch-Up
-- output guard: 100 % pass, 100 % safety-critical, 100 % reliability, 0 guard
-- fallbacks on every run after the guard landed.
--
-- Scope of the approval is exactly what was evaluated: coaching capabilities
-- (conversation, reasoning, structured_output) for private_life coaching. The
-- unevaluated capabilities seeded in 0090 (classification, extraction, planning)
-- are dropped until their own task evaluations pass. Never highly sensitive.
-- Fallback policy: none — allow_fallbacks: false, exact provider; if the route
-- is unavailable, coaching keeps the deterministic BHPC flow.
--
-- Idempotent and one-way: it only promotes a row that is still `candidate`
-- with the reviewed model/provider, so a re-run never re-promotes a route that
-- was since restricted or disabled.

update public.model_routes
   set status = 'approved',
       capabilities = array['conversation','reasoning','structured_output'],
       data_classes_allowed = array['public_synthetic','low_personal','private_life'],
       training_allowed = false,
       retention = 'zero',
       approved_for_highly_sensitive = false,
       quality_score = 100,
       reliability_score = 100,
       latency_score = 95,
       last_eval_run_at = '2026-10-07T02:36:27Z',
       last_policy_reviewed_at = now(),
       policy_notes = coalesce(policy_notes, '') ||
         ' | (0091) APPROVED for coaching after human review (owner sign-off; review date = last_policy_reviewed_at). '
         || 'coaching_v1 with the BHPC No Catch-Up prompt rule + output guard: 100 % pass / 100 % safety-critical / 100 % reliability, '
         || '0 guard fallbacks, p50 ≈ 0.15 s, ≈ $0.049 per 1K coaching turns. Policy: DeepInfra endpoint ZDR-listed on OpenRouter, '
         || 'no storage of inference inputs, no training; requested with zdr: true, data_collection: deny, allow_fallbacks: false. '
         || 'Fallback: none (deterministic BHPC flow). Evidence: docs/reference/coaching-route-eval-2026-10-06.md.',
       updated_at = now()
 where route_id = 'or_mistral_small_3_2_24b_deepinfra'
   and model_id = 'mistralai/mistral-small-3.2-24b-instruct'
   and provider_id = 'DeepInfra'
   and status = 'candidate'
   and position('(0091)' in coalesce(policy_notes, '')) = 0;
