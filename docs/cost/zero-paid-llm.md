# Nothing paid: the repository's model-cost rule

**Status: in force. `npm run validate:cost` reads this rule and fails the build when the code
stops obeying it.** A rule no code reads is a wish, so every clause below is pinned by
`scripts/validate-cost-posture.mjs`, which CI runs on every pull request.

Owner's posture, 11 October 2026: *"nothing should be paid"*. It applies to everything this
repository runs by itself. It does not change what the product charges or what the product's own
runtime costs — see "What this does not govern" below.

## The three rules

### 1. Repository automation makes no paid model call — and no model call at all

No workflow that runs on a `schedule:`, on `push:` or on `pull_request:` may hold or pass
`OPENROUTER_API_KEY`, or any other model-provider key. CI typechecks, tests, pre-submit checks,
the runtime proof and the weekly outcome report are all deterministic: they measure, parse and
assert. None of them asks a model anything.

Pinned by: no scheduled or CI-triggered workflow may reference a provider key.

### 2. Model evaluation is dispatch-only, and free by default

`Model Eval` (`.github/workflows/model-eval.yml`) runs only on `workflow_dispatch`. Its default
route set — what a dispatch with no inputs evaluates — is `:free` models only, so the ordinary
click costs nothing.

A priced candidate route is reachable only by naming it explicitly in `APM_EVAL_ROUTES_JSON` at
dispatch time. That is the opt-in: spending is a deliberate act with a route id in it, never a
default.

Pinned by: every `modelId` in the `defaults` list of `scripts/evaluate-openrouter-routes.mjs`
ends in `:free`; and every route in `COACHING_CANDIDATE_ROUTES`
(`scripts/coaching-eval-cases.mjs`) declares both a `costClass` and a `pricePerMTok`, so no route
can be priced silently.

### 3. A paid route never arrives as a fallback

The router does not fall back from a free model to a paid one. A free route that fails is a named
stop the operator reads, not a silent upgrade to a billed model. Candidate and free routes are not
production-approved until privacy review, task evaluation and explicit registry promotion
(`AGENTS.md`, `docs/23-MODEL-EVAL-AND-PROMOTION.md`); promotion is where cost is decided, by a
person.

## What this does not govern

A Player Mode is a product people pay for, and serving a subscriber's own inference has a cost of
goods. That spend is a settled product decision with its own key, its own cap and its own
authority (`docs/05-MODEL-REGISTRY.md`, `docs/23-MODEL-EVAL-AND-PROMOTION.md`,
`docs/14-DEPLOYMENT-AND-SECRETS.md`), and it runs through the Privacy Gateway like every other
production call. "Nothing paid" is about what the *repository* spends on its own behalf — audits,
reports, evaluations, probes, sweeps — not about what the product costs to run.

Two things that are therefore not violations: the production API calling a promoted model on the
product's key, and a human dispatching `Model Eval` with a priced route named in
`APM_EVAL_ROUTES_JSON` to gather promotion evidence.

## Adding a route, or a scheduled job that wants a model

1. A new scheduled job: do it deterministically. If it genuinely needs inference, it is not a
   scheduled job — make it a `workflow_dispatch` with the cost named in its input description.
2. A new evaluation candidate: add it to `COACHING_CANDIDATE_ROUTES` with its real
   `pricePerMTok` (checked against OpenRouter the day you add it) and a `costClass`. Leave it out
   of `defaults` unless its price is zero.
3. Then run `npm run validate:cost`. If it fails, the rule is right and the change is wrong.
