# A Player Mode — Model Evaluation & Promotion

**Status: LOCKED AI RELEASE GATE**  
**Updated: 2026-10-06**

A `$0` OpenRouter route is economically attractive. It is not automatically safe or useful.

## Promotion pipeline

```mermaid
flowchart LR
  DISC[Discover candidate] --> PRIV[Privacy review]
  PRIV --> SYN[Public/synthetic benchmark]
  SYN --> TASK[Task-specific evaluation]
  TASK --> HUMAN[Human review]
  HUMAN --> REG[Registry promotion]
  REG --> PROD[Eligible production route]
```

A candidate may process production private data **only** after all required gates pass and its registry status is explicitly changed to `approved`.

## Locked ordering

```text
PRIVACY ELIGIBILITY
  -> REQUIRED CAPABILITY
  -> RELIABILITY
  -> QUALITY
  -> COST
  -> LATENCY
```

Cost never precedes privacy or capability.

## Current route states

The database model registry is the user-visible source for the Trust Center. Current free routes are seeded as `candidate` or `restricted`; seed data is not approval.

| Status | Meaning |
|---|---|
| `candidate` | Potential route; may be evaluated but is not production-private-data eligible |
| `approved` | Passed policy/evaluation for its declared data classes and capabilities |
| `restricted` | Allowed only for narrower classes/tasks such as public/synthetic workloads |
| `disabled` | No routing |

## Evaluation suite

The repo includes `scripts/evaluate-openrouter-routes.mjs` and a manual GitHub workflow. The initial benchmark uses **public synthetic data only** and checks at least:

- commitment classification;
- deadline/action extraction;
- schedule reasoning;
- prompt-injection resistance;
- APM continuity-law adherence.

This benchmark is a screening tool, not sufficient by itself for promotion.

### Coaching suite `coaching_v1`

`APM_EVAL_SUITE=coaching_v1` runs the coaching task evaluation required below. It builds every request with the production `buildCoachingSlotTask` and judges outputs with the production validators (one question ending in `?`; statements-only synthesis; numbered High-Pressure synthesis; executable next move), plus case judges for prompt-injection resistance, no diagnosis (not-therapy boundary), no catch-up in Recovery and Strategic Patience adherence. Personas are public synthetic and span several games. Crisis language is verified to stop before inference. The report's `evidence.eligibleForHumanReview` is the gate into human review; `autoPromotion` is always false. `node scripts/evaluate-openrouter-routes.mjs --self-check` (run in CI) proves every judge accepts its known-good samples and rejects its known-bad ones without a key.

**BHPC No Catch-Up guard.** Every coaching prompt carries `NO_CATCH_UP_INSTRUCTION` (speak only of today and moving forward; never "catch up" phrasing, not even negated), and `acceptModelSlot` (services/api/src/coaching.ts) is the single acceptance step for a model rewrite in production and in `coaching_v1`: format validators first, then `hasCatchUpPhrasing` (services/api/src/coach/machine.ts) — any catch-up phrasing, negated or not, delivers the scripted line instead. The eval's strict no-catch-up judge is unchanged and judges what the user receives; every report also carries the unguarded `rawPassRate` / `rawSafetyCriticalPassRate` and `guardFallbacks`, and a route the guard rescues on more than 5 % of calls (`guardFallbackRateMax`) is not eligible.

Each route in the suite carries its own request shape (`COACHING_CANDIDATE_ROUTES`): the response format the endpoint actually accepts, a reasoning-sized `max_tokens` for reasoning models, and a pace under its rate limit (free routes ≥ 3.5 s between calls, one bounded 429 back-off). Failed calls record OpenRouter's error message (never the key or content), and every report carries measured cost per 1,000 coaching turns and p95 latency.

### Coaching review note — 2026-10-06 (APPROVED 2026-10-07 by owner sign-off)

| Route | Pass | Safety-critical | Reliability | p50 latency | Cost / 1K turns | Gate |
|---|---:|---:|---:|---:|---:|---|
| `or_apodex_1_1_mini_novita_free` | 75 % | 78 % | 75 % | 0.66 s | $0.00 | fail (reasoning ran out of tokens on 6/24) |
| `or_mistral_small_3_2_24b_deepinfra` | 100 % | 100 % | 100 % | 0.22 s | $0.042 | eligible for human review |
| `or_gemma_4_31b_it_deepinfra` | 87.5 % | 83 % | 87.5 % | 0.20 s | $0.043 | fail (empty synthesis output) |

Run 2 (Model Eval workflow on `main`, run 37561039809): apodex 71 % / 78 %; mistral 96 % / 94 % (one negated "no pressure to catch up" rejected by the strict judge); gemma 100 % / 100 %. Combined over both runs neither paid route holds 100 % safety-critical; mistral is 47/48 with zero errors, gemma 45/48 with three empty outputs.

**After the No Catch-Up prompt rule + output guard (commit `1ce86e2`, Mistral only):**

| Run | Where | Pass | Safety-critical | Unguarded pass / SC | Guard fallbacks | Reliability | p50 / p95 | Cost / 1K turns | Gate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 3 | local, 2026-10-07T02:35Z | 100 % | 100 % | 100 % / 100 % | 0 / 24 | 100 % | 0.17 s / 0.38 s | $0.049 | eligible for human review |
| 4 | local, 2026-10-07T02:36Z | 100 % | 100 % | 100 % / 100 % | 0 / 24 | 100 % | 0.13 s / 0.33 s | $0.049 | eligible for human review |
| 5 | Model Eval workflow on `main` (run 37563235227, `3507f9a`) | — | — | — | — | — | — | — | cancelled: a call with no timeout hung the job to its 20-min limit before any route reported; fixed with a 45 s per-call timeout and a 5-min per-route budget (pinned against the job timeout), then re-run (run 6) |
| 6 | Model Eval workflow on `main` (run 37565242204, `ae0b16b`) | 100 % | 100 % | 100 % / 100 % | 0 / 24 | 100 % | 0.11 s / 0.39 s | $0.049 | eligible for human review |

The tightened prompt removed the catch-up phrasing at source: the guard did not have to fire on any of the 72 calls across runs 3, 4 and 6, so the 100 % holds on the unguarded replies too. In run 6 gemma also scored 100 % / 100 % (0 guard fallbacks, $0.047 / 1K turns); apodex got HTTP 429 (free-tier cap) on every call and hit its 5-minute budget — 0 % reliability. Cost per 1K turns rose from $0.042 to $0.049 with the longer system prompt.

**Recommended: `or_mistral_small_3_2_24b_deepinfra`** (DeepInfra: ZDR-listed on OpenRouter; no storage of inference inputs, no training, per its data-privacy page as checked 2026-10-06). **Human review: APPROVED 2026-10-07** — the owner signed off as the human reviewer. Promotion is migration [`0091_promote_coaching_route.sql`](../services/api/migrations/0091_promote_coaching_route.sql), applied to Supabase the same day; a PGlite test pins that it promotes only this route, only for the evaluated coaching capabilities, once. Gemma and apodex stay non-approved. Full evidence and the reviewer checklist: [coaching route eval evidence](reference/coaching-route-eval-2026-10-06.md).

Executive Review, Sprint, Deep Work and Recovery state changes and the closure into the Morning Sequence are deterministic and never use a model.

## Required task evaluations before launch

| APM job | Required evidence |
|---|---|
| Classification | precision/recall on labeled synthetic + approved test corpus |
| Commitment extraction | owner/action/due-date accuracy and false-positive rate |
| Radar semantic judgment | useful-hit rate and suppression quality |
| Planning | executable next-action rate; no vague agenda items |
| Coaching | BHPC intent adherence, one-question cadence, safety/closure quality |
| Tool planning | schema validity + no unauthorized action assumptions |
| Prompt injection | external content cannot modify policy/authority |

## Private-data gate

For private-life traffic, a route must satisfy the Privacy Constitution and runtime checks:

- training disabled;
- zero-data-retention eligibility by default;
- exact provider constrained;
- fallback disabled unless another explicitly eligible route is defined;
- minimum necessary context;
- credentials/secrets absent;
- task schema validated;
- route status `approved`.

If no route passes, the correct result is **no inference**, not a privacy downgrade.

## Promotion record

Any promotion must record:

- route/model/provider IDs;
- cost class;
- data classes allowed;
- capabilities allowed;
- privacy-review date/source;
- retention/training policy;
- evaluation version/date;
- quality/reliability/latency scores;
- reviewer/ADR or release record;
- fallback policy.

## Economics

Measure:

```text
successful tasks
AI requests / user
$0 route share
paid fallback rate
latency
retry rate
cost / successful task
variable AI cost / user / month
```

The goal is high margin through routing discipline and deterministic computation—not artificially forcing every task through a free model.
