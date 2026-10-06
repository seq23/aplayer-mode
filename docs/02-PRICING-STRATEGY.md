# A Player Mode — Pricing Strategy

**Status:** RECOMMENDED / TESTABLE (not permanently locked)
**Version:** 1.0
**Date:** 2026-10-06

Pricing is deliberately documented separately from the locked Product and Privacy constitutions because pricing must respond to willingness-to-pay, retention, unit economics, and product maturity.

## Recommendation

### Launch sequence

| Stage | Offer | Recommended price | Why |
|---|---|---:|---|
| Closed beta | Full Chief of Staff beta | $0 | Learn trust, Radar accuracy, retention, and willingness-to-pay before optimizing revenue |
| Founding launch | Chief of Staff | **$24/mo or $228/yr ($19/mo effective)** | Premium to simple calendar tools, close enough to premium planners to be legible, with a meaningful annual commitment discount |
| Post-PMF | Chief of Staff | **$29/mo or $276/yr ($23/mo effective)** | Appropriate once proactive value is demonstrated consistently |
| Life OS | Deeper life management | **$59/mo or $564/yr ($47/mo effective)** | Prices the product as delegated mental-load management rather than a task app |
| Autopilot | Permissioned execution | **$129/mo starting point** | Captures materially higher delegated value and leaves room for action/inference costs |
| Household | Shared Life Graph / family operations | **No active price — waitlist only** | Household is deferred; collect demand before a later approval/build decision |

**ADR-0002 supersedes the prior Chief-of-Staff-only launch sequence.** Build and offer Chief of Staff, Life OS, and Autopilot as the three individual service levels once each exposed capability has passed its runtime/release gates. Household remains waitlist-only. Pricing remains testable and may still be staged during beta.

## Market anchors researched October 2026

| Product | Current public price anchor | Relevant lesson |
|---|---:|---|
| Reclaim | $12/seat/mo Starter; $18 Business | Automated scheduling alone anchors in low-to-mid teens |
| Sunsama | $22/mo monthly; $17/mo annual | Premium daily planning can sustain ~$1/workday pricing |
| Superhuman Mail | $30/mo Starter; $40/mo Business | High-value workflow acceleration can sustain $30–40/mo |
| Superhuman Suite | $15/mo Pro monthly; $40/mo Business monthly | Broad AI productivity suites put pressure on generic AI-assistant pricing |
| APM proposed Chief of Staff | $24 founding → $29 standard | Must earn premium via proactive Life Graph/Radar, not generic chat |
| APM proposed Life OS | $59 | New value category: delegated mental load |
| APM proposed Autopilot | $129+ | New value category: permissioned execution / time returned |

Sources used for this research are linked in the associated product research/decision record and should be refreshed before public pricing changes.

## Pricing ladder visual

```mermaid
flowchart LR
  DIY[Digital OS\n$49–99 one-time] --> BETA[Chief of Staff Beta\n$0]
  BETA --> F[Founding Chief of Staff\n$24/mo]
  F --> C[Chief of Staff\n$29/mo]
  C --> L[Life OS\n$59/mo]
  L --> A[Autopilot\n$129+/mo]
  A -. later .-> H[Household\nWaitlist only]
```

## Value ladder

| Tier | User buys | Product behavior |
|---|---|---|
| Digital OS | Methodology | **I run the system** |
| Chief of Staff | Awareness + prioritization | **APM notices and tells me** |
| Life OS | Mental-load management | **APM organizes and prepares it** |
| Autopilot | Delegated execution | **APM handles approved classes of work** |
| Household | Shared coordination | **APM helps run the household system** |

## Why $24 founding / $29 standard instead of $12–15

At $12–15, APM risks being perceived as another AI productivity utility and leaves insufficient room for a product that will maintain persistent personal state, proactive background processing, integrations, push, privacy controls, support, and eventually action execution.

At $29, APM is comparable to premium workflow products but must deliver a stronger outcome: valuable proactive interventions the user did not explicitly request.

The founding price reduces initial adoption friction without permanently anchoring the product below its intended category.

## Why not start at $59

Life OS pricing should be earned by Life OS capability. Charging $59 while the product is still primarily Goals + Today + Calendar/Gmail + Radar creates expectation debt. Chief of Staff should first prove recurring proactive value and trust.

## Annual pricing

Recommended annual discount: ~20%.

| Plan | Monthly | Annual | Effective monthly |
|---|---:|---:|---:|
| Founding Chief of Staff | $24 | $228 | $19 |
| Chief of Staff | $29 | $276 | $23 |
| Life OS | $59 | $564 | $47 |

Autopilot annual pricing should wait until usage/action economics are observed.

## Free tier decision

Do **not** begin with a permanent generous free tier. Start with a closed free beta, then a time-limited full-product trial or controlled preview.

Reason: APM requires integrations, inference, background work, and high trust. We want users who experience the real product rather than a permanently crippled version. A free diagnostic/A Player Audit can serve top-of-funnel distribution without giving away the ongoing operating system.

## Margin architecture

Price and inference cost are intentionally decoupled. APM routes work in this order:

**deterministic code → privacy-eligible $0 model → approved low-cost model → premium fallback**.

This allows strong gross margins without weakening the privacy promise.

OpenRouter's free plan currently advertises 25+ free models but only 50 requests/day and lacks policy-based routing controls on the free platform plan. Therefore production economics must not assume unlimited free OpenRouter capacity. We should build our own model registry/policy enforcement and treat $0 endpoints as opportunistic eligible capacity, not a guaranteed SLA.

## Pricing gates

Do not raise/add tiers because the roadmap says so. Use evidence.

| Change | Required evidence |
|---|---|
| Beta → $24 founding | Users repeatedly receive valuable proactive interventions and return weekly |
| $24 → $29 standard | Healthy paid conversion + retention; clear user-reported time/mental-load value |
| Add $59 Life OS | Users rely on APM across multiple life domains and repeatedly use prepared actions |
| Add $129+ Autopilot | Users repeatedly approve the same action classes and explicitly want fewer approvals |
| Usage/action surcharge | Meaningful cost variance or external transaction/action costs threaten target margins |

## Metrics to instrument from day one

- trial → paid conversion
- monthly/annual selection
- 4-, 8-, and 12-week retention
- valuable proactive interventions/user/week
- verified loops closed/user/week
- inference cost/user/month
- total variable cost/user/month
- gross margin by plan
- paid fallback rate
- $0 eligible inference rate
- action volume by type
- willingness-to-pay responses at key milestones
- downgrade/cancel reasons

## Pricing governance

Pricing is **not a constitutional lock**. Any public price change should be documented in a pricing decision record with date, cohort impact, evidence, grandfathering decision, and experiment/rollout plan.