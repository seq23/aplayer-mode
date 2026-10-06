# A Player Mode — Implementation Status

**Status: LIVING EXECUTION RECORD**  
**Updated: 2026-10-06**

This file records what is actually implemented versus source-complete, DB-provisioned, runtime-proven, externally gated, or evidence-deferred. It exists to prevent roadmap drift and false completion claims.

## Current system shape

```mermaid
flowchart TD
  M[Expo mobile] --> API[Cloudflare APM API]
  M --> AUTH[Supabase Auth]
  API --> DB[(Supabase Postgres + RLS)]
  DB --> LG[Life Graph / Personal OS]
  LG --> TODAY[Today v2]
  LG --> RADAR[Radar v1]
  M --> DEV[Device Calendar]
  API --> CONN[Google / Microsoft Connectors]
  API --> PRIV[Privacy Gateway / Model Registry]
  PRIV --> OR[OpenRouter approved route only]
  API --> ACT[Permissioned Action Engine]
  API --> PUSH[Proactive Push]
```

## Capability ledger

| Area | Current state | What exists |
|---|---|---|
| Product / privacy governance | `LOCKED` | Constitutions, architecture, security, lifecycle and Trust Center contracts |
| Positioning | `LOCKED` | “Whatever game you're in” + simultaneous multi-role Life Graph |
| BHPC v2.1 | `CANONICAL SOURCE` | Full source-of-intent + BHPC → APM mapping in repo |
| Mobile shell | `SOURCE_COMPLETE` | Today · Radar · Goals · APM + Settings / Trust Center |
| Supabase Free | `DB_PROVISIONED` | Auth/Postgres/RLS project; remains Free until evidence requires upgrade |
| Life Graph | `SOURCE_COMPLETE + DB_PROVISIONED` | identity, roles, goals, projects, milestones, commitments, actions, routines, people, preferences, rules, evidence and more |
| Methodology Engine | `SOURCE_COMPLETE + DB_PROVISIONED` | adaptive intake, Personal OS, Pillars/Tracks/Modes, MVD/recovery, arbitration |
| BHPC parity expansion | `SOURCE_COMPLETE + DB_PROVISIONED` | morning sequence, schedule preference, hard boundaries, scoring, review gates, Resilience, Sprint, Deep Work |
| Today v2 | `SOURCE_COMPLETE` | #1 move, morning sequence, calendar blocks, approvals, open-loop counts, day close |
| Radar v1 | `SOURCE_COMPLETE` | goals, commitments, review gates and calendar conflicts |
| Device Calendar | `SOURCE_COMPLETE` | Expo system-calendar read/sync path; real-device proof pending |
| Google Calendar | `SOURCE_COMPLETE` foundation | OAuth/PKCE, token storage/refresh, sync + action connector; live credentials/proof pending |
| Microsoft Calendar | `SOURCE_COMPLETE` foundation | Graph OAuth/sync/action path; live credentials/proof pending |
| iCloud Calendar | `SOURCE_COMPLETE` device lane | iCloud calendars configured on iPhone can enter via device lane; direct server CalDAV is separate/later |
| Gmail | `SOURCE_COMPLETE` foundation | separate OAuth/mail sync + normalized commitment/signals; live provider proof pending |
| Outlook Mail | `SOURCE_COMPLETE` foundation | Microsoft Graph mail signals/actions; live provider proof pending |
| Model Registry | `SOURCE_COMPLETE + DB_PROVISIONED` | candidates/restricted routes, live Trust page, scores/policy fields |
| OpenRouter gateway | `SOURCE_COMPLETE` | fail-closed exact-provider routing; no candidate auto-approved |
| Model evaluation | `SOURCE_COMPLETE` harness | public-synthetic benchmark + manual workflow; requires OpenRouter secret/live run |
| Live APM coaching | `SOURCE_COMPLETE` | mobile chat + sessions + mode-aware BHPC prompts; blocked until approved private-data route exists |
| Push | `SOURCE_COMPLETE` foundation | user permission, Expo token registration, server suppression/dedup; live push receipt pending |
| Trust Center | `SOURCE_COMPLETE` foundation | live model routes, connections, permissions, activity, Life Graph, export/delete request surfaces |
| Data rights | `SOURCE_COMPLETE` foundation | authenticated export + deletion job request; privileged deletion orchestrator pending |
| Action Engine | `SOURCE_COMPLETE` foundation | prepare/approve/execute/verify for calendar and email; global + per-domain kill switches default off |
| Analytics / AI usage | `SOURCE_COMPLETE + DB_PROVISIONED` | product/AI cost-event foundations |
| Entitlements | `SOURCE_COMPLETE + DB_PROVISIONED` | beta / Chief of Staff / Life OS / Autopilot / Household server state |
| Household | `SOURCE_COMPLETE` foundation | household/member/item schema + RLS/API primitives; complete collaborative UX deferred |
| EAS release | `SOURCE_COMPLETE` foundation | preview/production EAS profiles; store signing/submission external |
| Web Command Center | `CONTRACT ONLY` | same-brain desktop scope documented; advanced web UI not built |
| Billing | `FOUNDATION ONLY` | entitlement model documented; provider/store transactions not selected/proven |

## Database state

Current Supabase project has the baseline migrations plus the expanded platform migrations applied, including:

- platform expansion;
- BHPC intent parity;
- model route candidates;
- coaching/connector integrity;
- private household RLS helper.

All user-owned platform tables are intended to remain behind RLS. The household membership SECURITY DEFINER helper was moved out of the exposed `public` RPC schema. Latest Supabase **security advisor: zero findings**.

Performance-advisor warnings remain a later optimization task; they are not being mislabeled as resolved.

## Model state

Current `$0` routes are deliberately **candidate/restricted**, not production-approved simply because they are free.

```mermaid
flowchart LR
  C[Candidate] --> P[Privacy review]
  P --> E[Public synthetic + task evals]
  E --> H[Human approval]
  H --> A[Approved registry route]
  A --> I[Eligible inference]
```

If no approved route satisfies a private-data task, APM fails closed and does not infer.

## Provider/runtime receipts still outstanding

Source code and DB provisioning do not prove external runtime behavior. Outstanding receipts include:

- deployed Cloudflare API and real-device authenticated session restoration;
- cross-user RLS negative test through the live path;
- OpenRouter benchmark + explicit model promotion + private-life inference receipt;
- Google Calendar/Gmail real OAuth and sync receipts;
- Microsoft Calendar/Outlook real OAuth and sync receipts;
- iPhone/iCloud device-calendar receipt;
- real push notification receipt;
- action execution receipt with kill switches deliberately enabled;
- privileged deletion completion proof;
- TestFlight/Google Play build and store receipts;
- real billing/entitlement transaction proof;
- qualified legal/privacy review;
- closed-beta evidence.

## Evidence-deferred product expansion

These are intentionally **not** called production-complete merely because lower-level primitives exist:

- Life OS modules such as birthdays, travel, bills/subscriptions, meals/shopping, health routines and broader family administration;
- standing Autopilot rules beyond proven safe/customer-requested patterns;
- polished multi-member Household UX;
- advanced Web Command Center;
- broad infrastructure upgrades beyond Supabase Free.

The customer/evidence gate is intentional product discipline.

## Current artifact boundary

PR #6 is the **full remaining-platform source baseline**. It aims to finish code/schema/docs foundations while keeping external/provider/store/legal/beta gates explicit.

Before merge, the exact PR head must pass CI. After merge, the next artifact is not another speculative feature batch; it is the **runtime/provider evidence packet** described in `26-EXTERNAL-RUNTIME-GATES.md`.
