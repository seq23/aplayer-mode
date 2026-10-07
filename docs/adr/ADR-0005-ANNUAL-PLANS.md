# ADR-0005 — Annual Plans ("2 months free")

**Status:** ACCEPTED / LOCKED
**Date:** 2026-10-07
**Approved by:** Product owner (Phase D billing decision of 7 Oct 2026)
**Amends:** ADR-0004 ("monthly only at launch" is retired; every monthly price stands)

## Decision

Each individual tier is also sold as an annual plan, priced at **2 months free** (ten months, at the .99 price point):

| Tier | Monthly | Annual | Includes |
|---|---:|---:|---|
| **Executive Roundtable** | **$24.99** | **$249.99** | — |
| **Executive Suite** | **$39.99** | **$399.99** | everything in Executive Roundtable |
| **Autopilot** | **$79.99** | **$799.99** | everything in Executive Suite |

- Annual plans have **no intro offer**. The Executive Roundtable intro offers (Founding 100 at $9.99/mo locked; everyone else $9.99/mo for the first 3 months) stay monthly only (ADR-0004).
- There is no free trial on any plan.
- Billing is App Store and Google Play in-app subscriptions through RevenueCat (docs/33-BILLING-PHASE-D.md). Annual and monthly products of all tiers share one store subscription group, so a change between them is an upgrade, downgrade or crossgrade the store prorates.

## Unchanged rules

- **Buying a tier never grants autonomy.** Entitlement AND explicit user permission AND server policy AND kill switches decide authority.
- Server-side entitlements are written only from verified store events; the client never grants a plan.

## One source of truth

`PLAN_PRICES[plan].annualUsdCents` in `packages/policy/src/index.ts`, and the store catalogue `BILLING_PRODUCTS` beside it. `packages/policy/test/pricing.test.mjs` pins every doc's tier prices to those constants and accepts exactly these annual prices.
