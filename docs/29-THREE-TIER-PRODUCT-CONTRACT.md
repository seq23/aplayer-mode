# A Player Mode — Three-Tier Product Contract

**Status: LOCKED IMPLEMENTATION CONTRACT**  
**Decision authority:** ADR-0002; pricing ADR-0004, ADR-0005  
**Updated:** 2026-10-07

> **Whatever game you're in, get into A Player Mode.**

The user's game can include several simultaneous roles. The tier changes how much responsibility APM carries; it does not change who the product is for.

## Product ladder

```mermaid
flowchart LR
  C[Chief of Staff · decides the day\nSee + prioritize + prepare] --> L[Life OS · remembers and prepares\nManage + prepare + approved execution]
  L --> A[Autopilot · does\nStanding authority inside explicit rules]
  A -. future interest only .-> H[Household OS\nWaitlist]
```

## Tiers and prices

| Tier | Job | Monthly | Includes |
|---|---|---:|---|
| Chief of Staff | decides the day | $24.99 | — |
| Life OS | remembers and prepares | $39.99 | everything in Chief of Staff |
| Autopilot | does | $79.99 | everything in Life OS |

- **Annual plans (ADR-0005, 2 months free):**

| Tier | Monthly | Annual |
|---|---:|---:|
| Chief of Staff | $24.99 | $249.99 |
| Life OS | $39.99 | $399.99 |
| Autopilot | $79.99 | $799.99 |

- **Chief of Staff intro offers:** Founding 100 (the first 100 subscribers) pay $9.99/mo, locked while continuously subscribed; everyone else pays $9.99/mo for the first 3 months, then $24.99/mo.
- **Every tier reduces cognitive load; upper tiers reduce more.**
- **Billing:** App Store + Google Play in-app subscriptions via RevenueCat (Phase D, docs/33). No free trial.
- **Buying a tier never grants autonomy.** Prices come from `PLAN_PRICES` in `packages/policy/src/index.ts`; `packages/policy/test/pricing.test.mjs` pins this table to it.

## Capability grid

| Capability | Chief of Staff | Life OS | Autopilot |
|---|---:|---:|---:|
| Adaptive intake + Personal OS | ✓ | ✓ | ✓ |
| Goals / projects / routines | ✓ | ✓ | ✓ |
| Today + Run of Show | ✓ | ✓ | ✓ |
| Radar + proactive notices | ✓ | ✓ | ✓ |
| Calendar/email awareness | ✓ | ✓ | ✓ |
| BHPC-derived coaching modes | ✓ | ✓ | ✓ |
| Prepare calendar/email/routine actions | ✓ | ✓ | ✓ |
| Relationships / birthdays | — | ✓ | ✓ |
| Appointments / travel | — | ✓ | ✓ |
| Bills / subscriptions | — | ✓ | ✓ |
| Meals / shopping planning | — | ✓ | ✓ |
| Health routines / recurring life admin | — | ✓ | ✓ |
| Per-action execution after approval | — | ✓ | ✓ |
| Standing authority within constraints | — | — | ✓ |
| Household shared graph | — | — | — |

## Autonomy ceiling

```mermaid
flowchart TD
  C[Chief of Staff] --> L3[Level 3 · Prepare]
  L[Life OS] --> L4[Level 4 · Approve & execute]
  A[Autopilot] --> L5[Level 5 · Standing authority]
```

The product ceiling is not permission. A user's configured permission can always be lower.

## Household waitlist

Household remains deliberately unavailable. The app may:

- explain the future Household concept;
- record authenticated user interest;
- allow the user to withdraw that interest.

The app must not:

- create a new customer Household;
- sell a Household subscription;
- infer Household authority from an individual plan.

## Server enforcement

The API is the authority boundary. Client UI may explain a plan but cannot grant it.

- plan status must be active/trialing to unlock plan capabilities;
- permission writes above the current plan ceiling fail;
- action preparation/execution remains independently policy-checked;
- Household read and mutation routes stay unavailable; authenticated Supabase RLS exposes no Household customer read/write policy while the product is waitlist-only;
- billing (Phase D, migration 0040) writes entitlements only from the verified RevenueCat webhook; CANCELLATION keeps access to period end, BILLING_ISSUE keeps it through store grace, EXPIRATION and refunds end it.

## Phase ledger after this contract

1. **Phase A — three-tier contract / gating / plan UX / Household waitlist**.
2. **Phase B — Life OS domain modules**.
3. **Phase C — Autopilot standing-rule engine + UX**.
4. **Phase D — billing / entitlement reconciliation** (App Store + Google Play in-app subscriptions via RevenueCat; `SOURCE_COMPLETE` + `DB_PROVISIONED`, docs/33).
5. **Phase E — external runtime/provider evidence**.
6. **Phase F — three-tier beta/release evidence**.
7. **Household — later, separate approval.**
