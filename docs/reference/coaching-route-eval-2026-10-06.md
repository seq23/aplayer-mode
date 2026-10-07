# Coaching route eval evidence — `coaching_v1`, 2026-10-06

**Status: EVIDENCE FOR HUMAN REVIEW. Nothing is approved by this file.** Every route below is
`candidate` in `public.model_routes` (migrations 0007, 0090). Promotion follows docs/23: a human
reviewer reads this note, rechecks the provider policy, and records the change in a separate
reviewed migration.

## Run

- Suite `coaching_v1` (scripts/coaching-eval-cases.mjs), 8 cases × 3 repeats = 24 calls per route,
  public synthetic personas only; crisis language verified to stop before inference.
- Local run 2026-10-07T02:01Z UTC on commit `64cb8d3` (branch `fix/coaching-model-route`);
  the Model Eval workflow re-runs it on `main` and uploads the full JSON report.
- Provider controls on every call: `only: [provider]`, `allow_fallbacks: false`,
  `data_collection: deny`, `zdr: true`, `require_parameters: true`.
- Cost is OpenRouter's measured `usage.cost`, averaged per call and scaled to 1,000 coaching turns
  (one turn = one question or synthesis slot, ~410 prompt tokens).

## Why the first run failed (HTTP 400 on every case)

Novita's endpoint for `apodex/apodex-1.1-mini:free` rejects `response_format: json_schema`:
*"Model 'apodex/apodex-1.1-mini' does not support 'json_schema' response format. Supported formats:
json_object."* OpenRouter's endpoint data lists `structured_outputs` for it anyway, so
`require_parameters` does not filter it out. The script now sends a per-endpoint response format
(json_object + the schema in the prompt for this route), logs OpenRouter's error message (never the
key or content), paces free routes under 20 requests/min with a bounded 429 back-off, and records
cost. apodex is a reasoning model: at 700 max tokens all of the budget went to reasoning and
`content` was null, so the route gets 4,000.

## Results

| Route | Model / provider | Price $/M in·out | Pass | Safety-critical | Reliability | p50 / p95 latency | Cost / 1K turns | Gate |
|---|---|---|---:|---:|---:|---:|---:|---|
| `or_apodex_1_1_mini_novita_free` | apodex-1.1-mini:free / Novita | 0 · 0 | 75 % | 78 % | 75 % | 0.66 s / 1.04 s | $0.00 | **fail** |
| `or_mistral_small_3_2_24b_deepinfra` | mistral-small-3.2-24b-instruct / DeepInfra (fp8) | 0.075 · 0.20 | **100 %** | **100 %** | **100 %** | 0.22 s / 0.39 s | **$0.042** | **eligible for human review** |
| `or_gemma_4_31b_it_deepinfra` | gemma-4-31b-it / DeepInfra | 0.09 · 0.34 | 87.5 % | 83 % | 87.5 % | 0.20 s / 0.51 s | $0.043 | fail |

Failures:

- **apodex**: 6/24 calls hit `finish_reason: length` with no content — ~2,700 completion tokens of
  reasoning per call even at `reasoning.effort: low`. Every scored output passed the judges; the
  route fails on reliability. Free capacity (20 req/min, daily cap) is also not a production SLA
  (docs/02).
- **gemma-4-31b-it**: `synthesis_statements_only` returned empty content on all 3 repeats.

## Data policy as checked (2026-10-06)

- **DeepInfra** (US): both models' DeepInfra endpoints are on OpenRouter's ZDR endpoint list
  (`/api/v1/endpoints/zdr`). DeepInfra's data-privacy page (deepinfra.com/docs/data) says inference
  inputs are not stored on disk, with a no-training and no-sharing section; it carves out Google- and
  Anthropic-*operated* models, whose output those vendors store — a reviewer should confirm Gemma
  served by DeepInfra is not in that carve-out before Gemma is considered.
- **Novita** (US): the apodex endpoint is on the ZDR list; Novita listed as no-training/zero-retention
  (0007 snapshot).
- The Mistral first-party endpoint for mistral-small-3.2 is ZDR-listed but OpenRouter would not route
  to it under these controls (HTTP 404, "No allowed providers"), so it was not evaluated.

## Recommendation

**`or_mistral_small_3_2_24b_deepinfra`** — the only route that meets every gate (100 % overall and
safety-critical, 100 % reliability, 0.22 s median). At $0.042 per 1,000 coaching turns, even a heavy
user (≈1,500 turns a month) costs about $0.06 a month in coaching inference — far inside the
$2–4 per user per month all-in target, and with none of the free-tier rate-limit risk. Keep the
deterministic BHPC flow as the fallback. Reviewer checklist before promotion: recheck the DeepInfra
ZDR listing and privacy page, read the workflow's report artifact for this commit on `main`, then
record the promotion (status, scores, `last_eval_run_at`, `last_policy_reviewed_at`) in a reviewed
migration that links the report.
