-- Dynamic candidate snapshot researched 2026-10-06.
-- CANDIDATE != APPROVED. No row below may process production private data
-- until the APM evaluation suite has run and the row is explicitly promoted.

insert into public.model_routes (
  route_id, model_id, provider_id, status, cost_class, capabilities,
  data_classes_allowed, training_allowed, retention, approved_for_highly_sensitive,
  quality_score, reliability_score, latency_score, policy_notes, last_policy_reviewed_at
) values
(
  'or_apodex_1_1_mini_novita_free',
  'apodex/apodex-1.1-mini:free',
  'Novita',
  'candidate',
  'zero',
  array['classification','extraction','reasoning','planning','conversation','structured_output','tool_planning'],
  array['public_synthetic','low_personal','private_life'],
  false,
  'zero',
  false,
  0, 0, 0,
  '2026-10-06 research: model is free and supports response_format structured outputs; current OpenRouter provider page lists NovitaAI as no-training/zero-retention. Quality/eval approval still required.',
  now()
),
(
  'or_ling_3_1_flash_novita_free',
  'inclusionai/ling-3.1-flash',
  'Novita',
  'candidate',
  'zero',
  array['classification','reasoning','planning','conversation','tool_planning'],
  array['public_synthetic','low_personal','private_life'],
  false,
  'zero',
  false,
  0, 0, 0,
  '2026-10-06 research: model is free on NovitaAI; current provider page lists NovitaAI no-training/zero-retention. Model does not support response_format, so it is not a structured-output candidate. Quality/eval approval still required.',
  now()
),
(
  'or_nemotron_3_5_lightning_free_restricted',
  'nvidia/nemotron-3.5-lightning:free',
  'NVIDIA',
  'restricted',
  'zero',
  array['reasoning','planning','conversation'],
  array['public_synthetic'],
  true,
  'unknown',
  false,
  0, 0, 0,
  'Restricted to public/synthetic workloads. Current OpenRouter provider directory lists NVIDIA as training and retaining prompts; free-model terms warn against confidential/personal data.',
  now()
)
on conflict (route_id) do update set
  model_id = excluded.model_id,
  provider_id = excluded.provider_id,
  status = excluded.status,
  cost_class = excluded.cost_class,
  capabilities = excluded.capabilities,
  data_classes_allowed = excluded.data_classes_allowed,
  training_allowed = excluded.training_allowed,
  retention = excluded.retention,
  approved_for_highly_sensitive = excluded.approved_for_highly_sensitive,
  policy_notes = excluded.policy_notes,
  last_policy_reviewed_at = excluded.last_policy_reviewed_at,
  updated_at = now();
