# A Player Mode — Phased Implementation Roadmap

**Status: LOCKED SEQUENCING BASELINE; ESTIMATES ADAPT WITH EVIDENCE**  
**Decision date: 2026-10-06**

## Build principle

Build trust + core state + one complete proactive loop before breadth.

```mermaid
flowchart LR
  A[Docs / architecture] --> B[Mobile visual shell]
  B --> C[Life Graph]
  C --> D[Today]
  D --> E[Radar]
  E --> RP[Runtime proof]
  RP --> M[Methodology Engine v1]
  M --> F[Calendar Fabric]
  F --> G[Email / commitments]
  G --> H[Proactive push]
  H --> T[Three-tier contract]
  T --> L[Life OS]
  L --> N[Autopilot]
  N --> I[Three-tier beta]
  I --> J[Commercial launch]
```

## Phase 0 — Constitution and architecture

Deliverables:

- product constitution;
- privacy/AI constitution;
- pricing hypothesis;
- technical architecture;
- domain model;
- model registry/routing policy;
- mobile UX spec;
- data lifecycle;
- privacy UX/trust center;
- security threat model;
- analytics/evaluation plan.

Exit: contradictions resolved and implementation boundaries explicit.

## Phase 1 — Repository + mobile foundation

- monorepo scaffold;
- Expo/React Native TypeScript app;
- API service;
- shared contracts/domain packages;
- lint/typecheck/test/CI;
- environment configuration;
- navigation/design tokens/component primitives.

Exit: app boots, CI passes, clients call a typed local/dev API.

## Phase 2 — Trust Center visual implementation

Build first with fixtures:

- Welcome / product explanation;
- Privacy Primer;
- How APM Uses AI;
- AI Providers;
- Your Data;
- Connections;
- Permissions & Autonomy;
- APM Activity;
- Export & Delete.

Exit: a test user can understand the entire data/AI/autonomy proposition without reading legal terms.

## Phase 3 — Life Graph + onboarding vertical slice

Implement:

- auth/user boundary;
- identity;
- roles/pillars;
- goals;
- routines/preferences/rules;
- provenance;
- onboarding conversation/forms;
- Life browser.

Exit: onboarding produces inspectable structured state.

## Phase 4 — Today Engine

- DailyPlan projection;
- #1 Move;
- Run of Show;
- routines;
- execution state;
- MVD/recovery-mode policy;
- completion/evidence.

Exit: APM can generate a useful day from structured state without external integrations.

## Phase 5 — Radar v0

Use Life Graph/events only:

- deterministic rules;
- semantic interpretation through Privacy Gateway when needed;
- ranking;
- Radar cards;
- Why APM saw this;
- dismiss/correct/complete feedback.

Exit: one end-to-end proactive intervention can be generated, explained and resolved.

## Phase 5A — Runtime provider proof

Prove the current source-level slice against real provider boundaries before adding breadth.

Required receipts:

- deployed Cloudflare API health;
- Supabase Auth sign-in;
- authenticated Life Graph read;
- durable onboarding write;
- server Today projection;
- completion + evidence round-trip;
- deterministic Radar result;
- cross-user RLS negative-access proof;
- native mobile session restore + durable state after restart.

Exit: current authenticated persistence loop is runtime-proven, not merely structural.

## Phase 5B — APM Methodology Engine v1

This phase productizes the Billionaire High-Performance Coach / A Player Mode methodology before external integration breadth.

### Full intake

Expand the current first-slice onboarding into one-question-at-a-time structured intake covering:

- identity, time and context;
- North Star and major goals;
- goals → Tracks;
- values and non-negotiables;
- constraints and failure patterns;
- Body/health;
- Work/money;
- Mind/spirit/learning;
- weekly cadence;
- scoring and streak logic;
- coaching style;
- accountability choices.

The user may skip/let APM determine where appropriate. Intake outputs durable structured state rather than a giant prompt transcript.

### Operating system primitives

Productize:

- Pillars;
- Tracks;
- Modes;
- Foreground vs Background;
- Arbitration Engine;
- 30/60/90 execution plans;
- Never Miss Twice;
- Continuity > Intensity;
- No Catch-Up;
- No Mid-Day Negotiation;
- Zeros Allowed;
- Minimum Viable Day.

### Runtime coaching behavior

Implement:

- daily agenda / Run of Show;
- standard coaching;
- High-Pressure Coaching;
- Executive Review;
- Recovery Mode;
- end-of-day check-in;
- weekly debrief;
- governed changes to personal operating rules.

The old three-chat prompt architecture is translated into product boundaries:

```text
OS / Diaries source-of-truth concept → durable Life Graph + Rules + Settings
Daily Runtime concept              → Today + APM coaching runtime
Governance concept                 → versioned change review + audit/history
```

Exit: APM behaves like the productized operating system, not a generic planner with a Goal field.

## Phase 6 — Calendar Fabric

Calendar is provider-neutral. APM must not assume every user uses Google Calendar.

### Canonical layer

Build one normalized calendar contract with:

- account/source identity;
- provider/source type;
- event ID + source ID;
- start/end/time zone/all-day;
- title/location/availability;
- recurrence metadata;
- attendees/organizer where permitted;
- provenance;
- sync cursor/version;
- capability flags for read/write/background sync.

### Phase 6A — Device calendar connector

Use the mobile OS calendar layer where appropriate so APM can read calendars already configured on the phone, subject to explicit permission.

This gives broad early coverage across calendars such as:

- iCloud / CalDAV;
- Google;
- Microsoft Exchange / Outlook;
- local or other supported device calendars.

Device access is normalized into the same canonical calendar model.

### Phase 6B — Direct cloud connectors

Add direct server/background connectors for reliable always-on sync:

- Google Calendar API;
- Microsoft Graph for Outlook.com / Microsoft 365 / Exchange-backed calendars;
- Apple/iCloud through an Apple-supported account-data / CalDAV route when practical and secure.

Begin read-only. Ask for write permission only when the Action Engine needs it and the user explicitly grants it.

Exit: APM understands real schedule constraints across supported calendar providers without provider-specific logic leaking into Today/Radar.

## Phase 7 — Email + Commitment Engine

Email is also provider-neutral.

Initial cloud connectors:

- Gmail;
- Microsoft Outlook / Microsoft 365 mail.

Implement:

- least-privilege OAuth;
- incremental sync strategy;
- commitment/request/follow-up extraction;
- source references;
- confidence/correction;
- raw-content minimization;
- prompt-injection defenses.

Do not conflate Gmail with Google Calendar: they are separate data sources and separate permissions.

Exit: APM can find valuable real-world open loops from permitted email context.

## Phase 8 — Proactive mobile

- push infrastructure;
- notification preference model;
- timing/suppression;
- deep links;
- deduplication;
- high-confidence alert thresholds.

Exit: APM can reach the user when something genuinely matters.

## Phase 9 — Three-tier product contract

- Chief of Staff / Life OS / Autopilot capability matrix;
- server-side plan ceilings;
- plan/upgrade explanation UX;
- subscription entitlement remains separate from user permission;
- Household waitlist/interest only.

Exit: the individual product has one canonical tier contract and Household cannot accidentally activate.

## Phase 10 — Life OS

Build the previously identified life-management domains now rather than waiting for a Chief-of-Staff-only paid launch:

- relationships / birthdays;
- appointments;
- travel;
- bills / subscriptions;
- meals / shopping planning;
- health routines;
- recurring/family obligations.

These domains use the same Life Graph, Today, Radar, privacy and action primitives.

Exit: Life OS materially carries mental load beyond awareness/planning.

## Phase 11 — Autopilot

- domain-specific standing rules;
- thresholds/limits;
- reversible actions where possible;
- exception handling;
- user-visible audit;
- pause/revoke/kill switch;
- no authority derived from payment alone.

Exit: supported repeated approvals can safely become explicit standing authority.

## Phase 12 — Three-tier closed beta

25–50 users spanning multiple games and, where appropriate, multiple individual tiers.

Measure:

- Valuable Proactive Interventions / user / week;
- Radar acceptance/action rate;
- false positive/correction rate;
- Today engagement;
- notification disable rate;
- prepared/approved/executed action quality;
- Autopilot reversals/errors;
- retention;
- inference/variable cost;
- privacy and autonomy comprehension.

## Phase 13 — Three-tier paid launch

Expose Chief of Staff, Life OS, and Autopilot only when the capabilities shown for each tier have the required runtime/provider/store/billing receipts.

Final pricing (ADR-0004): Chief of Staff $24.99/mo, Life OS $39.99/mo, Autopilot $79.99/mo, cumulative. Chief of Staff intro offers: Founding 100 at $9.99/mo locked while continuously subscribed; everyone else $9.99/mo for the first 3 months, then $24.99/mo. Billing is App Store + Google Play in-app subscriptions (Phase D).

## Phase 14 — Household waitlist only

Household shared-graph primitives may remain dormant in source. Customer-facing Household creation, shared authority and billing remain disabled. The app records authenticated interest only.

A later Household implementation requires separate explicit approval and a new consent/privacy/authority review.

## Phase 15 — Web Command Center

Deep planning/configuration/audit/integration management. Mobile remains daily execution surface.

## Phase 16 — Distribution

A Player / Mental Load Audit → personalized result → install → first value → first Radar hit → trial → paid.

## MVP anti-scope list

Do not add before validation unless a blocking reason emerges:

- banking;
- autonomous purchases;
- grocery ordering;
- health-record integrations;
- native Swift + Kotlin duplicate clients;
- family graph;
- marketplace;
- social feed;
- 20 named agents;
- complex enterprise admin;
- full web command center.
