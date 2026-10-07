# ADR-0004 — Final Individual Pricing and Executive Roundtable Intro Offers

**Status:** ACCEPTED / LOCKED
**Date:** 2026-10-07
**Approved by:** Product owner (final pricing decision of 7 Oct 2026)
**Supersedes:** the Pricing section of ADR-0002 (every other part of ADR-0002 stands)

## Decision

The three individual service levels are priced, per month, in USD:

| Tier | Job | Monthly | Includes |
|---|---|---:|---|
| **Executive Roundtable** | plans and coaches you | **$24.99** | — |
| **Executive Suite** | acts when you tap yes | **$39.99** | everything in Executive Roundtable |
| **Autopilot** | handles it inside your rules | **$79.99** | everything in Executive Suite |

The ladder is cumulative. Every tier reduces the user's cognitive load; the upper tiers reduce more of it.

### Executive Roundtable intro offers

- **Founding 100:** the first 100 subscribers pay **$9.99/mo**, locked for as long as they stay continuously subscribed. A lapse ends the lock; re-subscribing is at the then-current price.
- **Everyone else:** **$9.99/mo for the first 3 months**, then **$24.99/mo**.

Intro offers exist on Executive Roundtable only. Executive Suite and Autopilot have no intro price.

### Billing channel

Billing is **App Store and Google Play in-app subscriptions** (Phase D). Phase D is not built; this ADR does not build it. Until verified store receipts are reconciled into server-side entitlements, no price is charged and no plan is granted by the client.

### Unchanged rules

- **Buying a tier never grants autonomy.** Subscription entitlement AND explicit user permission AND server policy AND current kill switches = the maximum authority APM may exercise (ADR-0002 product invariant).
- Household stays waitlist-only with no price.
- The closed beta stays free.

## One source of truth

The prices live in code, in `packages/policy/src/index.ts` (`PLAN_PRICES`, `CHIEF_OF_STAFF_INTRO_OFFERS`, `BILLING_CHANNELS`, `planPriceLabels`). The API's plan labels are derived from those constants. `packages/policy/test/pricing.test.mjs` reads the constants and the docs and fails if any doc states a different price for a tier. A price change is a new pricing decision record plus a change to those constants, in one PR.

## Why these numbers

- **$24.99 Executive Roundtable** sits inside the consumer AI-assistant band (Sunsama, Martin, Howie Basic, ChatGPT Plus; docs/02 market anchors) and must be earned by proactive Radar, not generic chat.
- **$39.99 Executive Suite** is a real step for more of life covered, without the 2× jump of the earlier hypothesis while bills, subscriptions and health stay reminders/preparation.
- **$79.99 Autopilot** prices the tier that does the work inside standing rules (ADR-0003 classes), within the band that products doing real work command, below the EA-agent band that does inbox work for a person (docs/02 market anchors).
- **$9.99 intro** lowers the first-purchase barrier; the Founding 100 lock rewards the earliest subscribers for staying.

Store fees (15% Small Business Program, 30% above it) are a larger cost than inference at every tier; margin tracking in docs/02 includes them.

## History

The earlier hypotheses (ADR-0002 Pricing section, docs/02 v1.0, docs/24, docs/07) are retired by this record; they remain readable in Git history only.
