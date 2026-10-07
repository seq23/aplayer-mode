# ADR-0002 — Build and Offer Three Individual APM Service Levels

**Status:** ACCEPTED / LOCKED  
**Date:** 2026-10-06  
**Approved by:** Product owner  
**Amended by:** ADR-0004 (Pricing section only)

## Decision

A Player Mode remains **one app, one account, one private Life Graph, and one APM intelligence/policy system**.

The individual product will be built and commercialized as three service levels:

1. **Chief of Staff** — APM sees, prioritizes, plans, coaches, reminds, and may prepare supported actions.
2. **Life OS** — everything in Chief of Staff plus broader life-management domains and per-action execution after explicit approval.
3. **Autopilot** — everything in Life OS plus explicit, revocable standing authority for supported safe action classes.

**Household OS is not part of this build/launch train.** Household infrastructure may remain in source for future use, but customer-facing Household functionality stays unavailable. Interested users receive a real waitlist/interest control instead.

## Why this changes the previous sequence

The original roadmap intentionally delayed Life OS and Autopilot until after Chief-of-Staff evidence. The product owner has now explicitly approved building the three individual service levels in the same product train.

This ADR supersedes only the sequencing rule that said Life OS and Autopilot source implementation must wait for post-launch evidence. It does **not** weaken any runtime, privacy, security, permission, billing, legal, provider, or store-validation gate.

## Product invariant

```text
subscription entitlement
AND
explicit user permission
AND
server policy
AND
current kill switches
=
maximum authority APM may exercise
```

Paying for Autopilot never grants standing authority by itself.

## Tier contract

| Capability | Chief of Staff | Life OS | Autopilot |
|---|---:|---:|---:|
| Personal OS / methodology | ✓ | ✓ | ✓ |
| Today + Radar | ✓ | ✓ | ✓ |
| Calendar/email awareness | ✓ | ✓ | ✓ |
| APM coaching | ✓ | ✓ | ✓ |
| Prepare supported actions | ✓ | ✓ | ✓ |
| Life-management modules | — | ✓ | ✓ |
| Execute one approved action | — | ✓ | ✓ |
| Standing authority / level 5 | — | — | ✓ |
| Household shared graph | — | — | — |

Beta access is treated as a Chief-of-Staff capability ceiling unless a later beta-specific ADR changes it.

## Household policy

Household is **waitlist-only** until a later explicit approval. No subscription tier, stale database row, or hidden route may make Household customer functionality available before that approval.

## Pricing

**Superseded by ADR-0004 (2026-10-07).** The pricing hypotheses that stood here are retired; the final, owner-decided prices and the Chief of Staff intro offers are in ADR-0004 and in `packages/policy/src/index.ts`. Household still has no active product price while waitlist-only.

## Validation

This ADR authorizes source implementation. It does not convert source-complete features into runtime-proven or production-ready features without the receipts defined in the runtime evidence packet.
