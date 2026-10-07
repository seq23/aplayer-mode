# ADR-0006 — Plan Display Names: Executive Roundtable, Executive Suite, Autopilot

**Status:** ACCEPTED
**Date:** 2026-10-07
**Approved by:** Product owner (Sequoia Taylor), 7 Oct 2026
**Amends:** ADR-0002, ADR-0004, ADR-0005 (plan names only; every price, offer and capability stands)

## Decision

The three paid plans are shown to users under new names. Only the names, promises and taglines change.

| Internal key (unchanged) | Old display name | New display name | Tagline | Promise |
|---|---|---|---|---|
| `chief_of_staff` | Chief of Staff | **Executive Roundtable** | plans and coaches you | Your five-person executive team, in one app. It plans and coaches you; you do the last step. |
| `life_os` | Life OS | **Executive Suite** | acts when you tap yes | It runs your whole life and acts when you tap yes: relationships, appointments and travel, bills and subscriptions, meals, health and life admin, plus one-tap approve-and-execute. |
| `autopilot` | Autopilot | **Autopilot** | handles it inside your rules | It handles recurring things on its own inside rules you set. It saves money, never spends it. |
| `beta` | Chief of Staff Beta | **Executive Roundtable Beta** | — | unchanged |

Household is unchanged. Where "Life OS" meant the capability or domain (relationships, appointments, bills and so on), users now see **life areas**.

## Why

"Chief of Staff" was both a plan and job #3 of the five jobs every plan does (Executive Coach, Executive Assistant, Chief of Staff, Accountability Partner, Cognitive Behavioral Mindset Coach). Every plan does all five jobs, so "Chief of Staff" now names **only the job, never a plan**. "Life OS" was an internal-sounding name for the middle plan and is no longer shown to users.

## What did NOT change (on purpose)

- Plan keys `chief_of_staff`, `life_os`, `autopilot` (TypeScript `ProductPlan` / `PaidPlan`, API payloads, RevenueCat entitlements and package ids).
- Store product ids (`apm_cos_*`, `apm_lifeos_*`, `apm_autopilot_*`), the database enum values, migrations and `private.billing_products` seed rows.
- Internal identifiers such as the `life_os_domains` capability, `lifeOsRepository`, `CHIEF_OF_STAFF_INTRO_OFFERS` and the `docs/30-LIFE-OS-PHASE-B.md` file name.

Renaming any of these would break live store products, stored entitlements and migrations for no user-visible gain. `CHIEF_OF_STAFF_INTRO_OFFERS` keeps its name with a comment pointing here.

## Enforcement

- `packages/policy/src/index.ts` (`PLAN_PRICES`, `productPlanPolicies`) is the one source of the names; app copy, the API's plan labels and highlights, and the intake playback derive them from it.
- `packages/policy/test/pricing.test.mjs` pins the new names, taglines and promises, and the pricing docs' tier rows.
- `packages/policy/test/plan-names.test.mjs` scans the mobile app, the API sources and the content modules (and the docs) and fails on "Life OS" as a user-facing word or "Chief of Staff" anywhere except as one of the five jobs.
