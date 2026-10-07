-- 0090: coaching route candidates (docs/05 "conversational coaching", docs/23).
-- Numbered 0090 on purpose so it cannot collide with the daily-loop series
-- (0021+). Migrations are applied by name through the Supabase Management API
-- and lexically in the PGlite tests; neither requires contiguous numbering.
--
-- CANDIDATE != APPROVED. This migration adds two low-cost paid ZDR endpoints as
-- `candidate` and records the coaching_v1 request fix on the free route. It
-- never promotes: promotion needs the human review recorded in docs/23 and a
-- separate reviewed migration. A re-run never downgrades or upgrades a status.

insert into public.model_routes (
  route_id, model_id, provider_id, status, cost_class, capabilities,
  data_classes_allowed, training_allowed, retention, approved_for_highly_sensitive,
  quality_score, reliability_score, latency_score, policy_notes, last_policy_reviewed_at
) values
(
  'or_mistral_small_3_2_24b_deepinfra',
  'mistralai/mistral-small-3.2-24b-instruct',
  'DeepInfra',
  'candidate',
  'low',
  array['classification','extraction','reasoning','planning','conversation','structured_output'],
  array['public_synthetic','low_personal','private_life'],
  false,
  'zero',
  false,
  0, 0, 0,
  '2026-10-06 (0090) policy check: OpenRouter /api/v1/endpoints/zdr lists the DeepInfra fp8 endpoint as ZDR; requested with zdr: true, data_collection: deny, allow_fallbacks: false. US-headquartered (deepinfra.com/privacy). $0.075/M input, $0.20/M output; supports response_format json_schema. Coaching eval evidence: docs/reference/coaching-route-eval-2026-10-06.md. Remains candidate until human review per docs/23.',
  now()
),
(
  'or_gemma_4_31b_it_deepinfra',
  'google/gemma-4-31b-it',
  'DeepInfra',
  'candidate',
  'low',
  array['classification','extraction','reasoning','planning','conversation','structured_output'],
  array['public_synthetic','low_personal','private_life'],
  false,
  'zero',
  false,
  0, 0, 0,
  '2026-10-06 (0090) policy check: OpenRouter /api/v1/endpoints/zdr lists both DeepInfra endpoints (turbo fp4, fp8) as ZDR; requested with zdr: true, data_collection: deny, allow_fallbacks: false. $0.09-$0.20/M input, $0.34-$0.40/M output; supports response_format json_schema. Coaching eval evidence: docs/reference/coaching-route-eval-2026-10-06.md. Remains candidate until human review per docs/23.',
  now()
)
on conflict (route_id) do update set
  model_id = excluded.model_id,
  provider_id = excluded.provider_id,
  cost_class = excluded.cost_class,
  capabilities = excluded.capabilities,
  data_classes_allowed = excluded.data_classes_allowed,
  training_allowed = excluded.training_allowed,
  retention = excluded.retention,
  policy_notes = excluded.policy_notes,
  last_policy_reviewed_at = excluded.last_policy_reviewed_at,
  updated_at = now();

-- The free route stays candidate; record why its first coaching_v1 run failed.
update public.model_routes
   set policy_notes = coalesce(policy_notes, '') ||
         ' | 2026-10-06 (0090): first coaching_v1 run failed with HTTP 400 on every case: Novita rejects response_format json_schema '
         || '("Supported formats: json_object") although OpenRouter lists structured_outputs. Evaluated with json_object + schema in the prompt; '
         || 'reasoning model needs a large max_tokens or content is null. Free capacity (20 req/min, daily cap) is not a production SLA (docs/02). '
         || 'Evidence: docs/reference/coaching-route-eval-2026-10-06.md.',
       updated_at = now()
 where route_id = 'or_apodex_1_1_mini_novita_free'
   and status = 'candidate'
   and position('(0090)' in coalesce(policy_notes, '')) = 0;
