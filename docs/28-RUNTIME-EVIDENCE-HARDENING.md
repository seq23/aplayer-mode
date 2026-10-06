# A Player Mode — Runtime Evidence Hardening

**Status: IMPLEMENTATION + OPERATIONS GATE**  
**Updated: 2026-10-06**

This document hardens the transition from source-complete software to externally proven software. It does not add product scope.

## Principle

> A workflow log is not a production claim. A production claim needs an immutable source SHA plus a reproducible receipt.

## Evidence chain

```mermaid
flowchart LR
  CODE[Exact commit] --> CI[Typecheck + deterministic tests]
  CI --> DEPLOY[Deploy/build/eval workflow]
  DEPLOY --> RECEIPT[Machine-readable artifact]
  RECEIPT --> LEDGER[Runtime evidence packet]
  LEDGER --> CLAIM[Runtime-proven capability]
```

## Locked receipt requirements

Every external proof should contain, where applicable:

| Field | Requirement |
|---|---|
| Gate | Exact capability being proven |
| Status | PASS / FAIL |
| Commit SHA | Exact immutable source |
| Environment | staging / production / preview |
| Timestamp | UTC |
| Request/build/provider ID | Non-secret correlation identifier |
| Expected behavior | Explicit |
| Actual behavior | Explicit |
| Sensitive values | Never stored in receipt |
| Failure | Recorded rather than hidden |

## Hardened workflows

### Runtime Proof

The verifier now requires **two dedicated test accounts**. Cross-user RLS proof is no longer optional for a full runtime receipt.

The workflow validates the exact source first, then runs the live proof and uploads `evidence/runtime-proof.json`.

### Cloudflare Deploy

Deployment must pass source validation first. A deployment is not a proof until the deployed `/v1/health` endpoint returns the expected APM service contract and request tracing header. The workflow emits a deployment receipt.

### OpenRouter Model Eval

Model evaluation validates the exact source and emits a public/synthetic report tied to the source SHA. Passing this screening report does **not** promote a model. Promotion remains an explicit registry/governance act.

### EAS Mobile Build

The build workflow validates source before queueing EAS and preserves the EAS JSON build response plus immutable source metadata as an artifact.

## Action execution kill switches

Provider-side action execution is fail-closed.

```text
GLOBAL_ACTION_EXECUTION=true
        AND
ACTION_EXECUTION_<DOMAIN>=true
        AND
active entitlement permits requested level
        AND
user permission permits requested level
        ↓
provider execution may proceed
```

Initially implemented domains:

- calendar
- email

Unknown domains default to disabled.

Preparing a recommendation/draft can remain available while provider-side execution is disabled.

## Branch governance

`main` should require the `validate` CI check and PR-based changes before production launch. Repository-admin branch/ruleset configuration is an external GitHub setting, not source code; it must be proven separately.

## Completion rule

Source hardening is complete when the hardening PR is green and merged.

Runtime hardening is **not** complete until the corresponding external receipts in `27-RUNTIME-EVIDENCE-PACKET.md` are green.
