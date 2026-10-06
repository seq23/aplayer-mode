# Phase B — Life OS Domains

**Status:** SOURCE IMPLEMENTATION  
**Authority:** Product Constitution + ADR-0002 + Three-Tier Product Contract  
**Scope:** Individual Life OS only. Household remains waitlist-only.

## Full intended system

Life OS carries recurring personal mental load inside the same private Life Graph used by Today, Radar, Goals, coaching and the Action Engine.

This phase covers:

- relationships and birthdays;
- appointments;
- travel;
- bills and subscriptions;
- meal planning and shopping;
- health routines;
- recurring obligations;
- family obligations owned by the individual user.

It does not create a shared Household graph.

## Data model

### LifeRelationship

Life OS extends a canonical `Person` with:

- birthday;
- next-contact date;
- optional contact cadence;
- notes;
- provenance.

The base Person object remains useful to Chief of Staff for commitments and communications. The deeper relationship-management object is Life OS-gated.

### LifeAdminItem

One normalized object represents personal administration across supported domains.

Required:

- kind;
- title;
- status;
- importance;
- provenance.

Optional:

- person link;
- due/start/end time;
- recurrence;
- amount/currency;
- domain-specific structured details;
- completion timestamp.

Supported kinds:

`appointment | trip | bill | subscription | meal_plan | shopping | health_routine | recurring_obligation | family_obligation`

## Lifecycle

```text
captured/open
  -> planned/scheduled
  -> Radar + Today projection
  -> completed
  -> closed OR recurring next occurrence
```

Recurring completion advances to the next future occurrence rather than generating catch-up backlog. This preserves the APM No Catch-Up principle.

Paused and cancelled items do not surface in Today/Radar.

## Entitlement and security

Life OS data requires all of:

```text
authenticated user
AND same-user row ownership
AND active/trialing entitlement
AND plan in Life OS or Autopilot
```

The database enforces this with RLS in addition to API checks.

Person references use a composite `(user_id, person_id)` foreign key so a user cannot attach a Life OS object to another user's Person row.

Buying/holding a Life OS entitlement still does not grant action autonomy. Action permission remains a separate policy boundary.

## Mobile journey

```text
Settings
  -> Life OS
  -> add relationship OR life-admin item
  -> durable Life Graph write
  -> Today/Radar recompute
  -> complete/cancel
  -> recurring item rolls forward deterministically when applicable
```

Chief of Staff accounts see an explanatory upgrade boundary rather than editable Life OS state.

## Radar behavior

Deterministic rules surface:

- overdue/due-soon Life Admin items;
- upcoming birthdays;
- relationship contact cadence.

Lead windows vary by domain to avoid noisy generic reminders.

## Today behavior

Items due today enter the Run of Show as `life_os` blocks.

Recovery mode carries only high-importance Life OS items into Today so recovery does not become a hidden catch-up day.

## Failure behavior

- missing/expired entitlement -> `403 life_os_required`;
- unknown/cross-user Person -> `404 person_not_found`;
- unknown Life OS item -> `404 not_found`;
- cancelled item completion -> `409 invalid_item_state`;
- invalid payload/date/currency -> `400 invalid_request`;
- persistence/provider failure -> fail closed through the API error boundary.

No client state is treated as durable truth until the server returns the updated Life Graph.

## Not included in Phase B

- standing Autopilot authority;
- automatic purchases;
- healthcare transactions;
- banking or bill payment execution;
- shared Household members/data;
- billing receipt reconciliation;
- provider/store/runtime proof.

## Validation gates

Before merge:

1. exact-head workspace typecheck;
2. exact-head workspace tests;
3. Supabase migration applies successfully;
4. Supabase security advisor has no unresolved findings;
5. RLS/entitlement policy structure is inspected;
6. PR architecture/security review has no unresolved actionable findings.

External/provider/mobile-device validation remains tracked separately in the runtime evidence packet.

## Privacy / lifecycle receipt

- **Owner:** the authenticated individual user.
- **Classification:** relationship/admin state is Class 2 private life by default; financial amounts and health-sensitive details can raise the relevant fields/context to Class 3.
- **Persistence:** structured state remains until corrected/deleted/account deletion; raw external source duplication is not introduced by this phase.
- **Export:** the existing Life Graph export includes both Phase B collections.
- **Deletion:** account deletion cascades through user ownership; relationship rows also cascade with their same-user Person.
- **AI processing:** Phase B Today, Radar, recurrence and lifecycle behavior are deterministic. No new inference route receives Life OS data in this phase.
- **Analytics:** only coarse event/domain metadata is recorded; private titles, notes, amounts and relationship content are excluded.
- **Inspection/correction:** Privacy & AI → Your Data exposes Life OS state; Settings → Life OS is the current correction/completion surface.

## Provisioning receipt — 2026-10-06

**Supabase project:** `aplayer-mode` (`klzbnchgoqmnwsgolwoe`)

Applied database migrations:

- `life_os_domains`
- `life_os_data_rights_hardening`

Live schema inspection confirmed:

- same-user Person foreign keys are present;
- deleting a linked Person nulls only `life_admin_items.person_id` and preserves `user_id`;
- Life OS mutation policies require active/trialing Life OS or Autopilot entitlement;
- owner SELECT policies remain available for data-rights inspection/export after downgrade;
- the temporary public `SECURITY DEFINER` export RPC was removed;
- the composite Life Admin Person foreign key has a covering index.

Post-migration Supabase security advisor: **0 security lints**.

Performance-advisor notices outside the new Life OS path remain repo-wide optimization backlog and are not promoted into this Phase B scope.

