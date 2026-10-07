# Phase B — Life Areas

**Status:** SOURCE IMPLEMENTATION  
**Authority:** Product Constitution + ADR-0002 + Three-Tier Product Contract  
**Scope:** Individual life areas only. Household remains waitlist-only.

## Full intended system

Life areas carry recurring personal mental load inside the same private Life Graph used by Today, Radar, Goals, coaching and the Action Engine.

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

Life areas extend a canonical `Person` with:

- birthday;
- next-contact date;
- optional contact cadence;
- notes;
- provenance.

The base Person object remains useful to Executive Roundtable for commitments and communications. The deeper relationship-management object is gated to life areas (Executive Suite and Autopilot).

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

Life-area data requires all of:

```text
authenticated user
AND same-user row ownership
AND active/trialing entitlement
AND plan in Executive Suite or Autopilot
```

The database enforces this with RLS in addition to API checks.

### Governed writes (migration 0017)

The mobile bundle carries the Supabase publishable key and the Worker forwards the user's JWT (no service role), so table grants alone would let a user write life-area rows straight through PostgREST. Therefore:

- `anon`/`authenticated` hold **no** INSERT/UPDATE/DELETE privilege and no write policy on `life_relationships` or `life_admin_items`; ordinary reads keep the own-row AND entitlement SELECT policy.
- Every write goes through a governed RPC: `apm_life_os_save_relationship`, `apm_life_os_update_relationship`, `apm_life_os_create_item`, `apm_life_os_update_item`, `apm_life_os_complete_item`. The public functions are `SECURITY INVOKER` wrappers; the `SECURITY DEFINER` bodies live in the non-exposed `private` schema with `search_path = ''`.
- Each RPC checks `auth.uid()` ownership (including the linked Person) and the life-area entitlement, rejects every field outside the API's whitelist (provenance, source, confidence, `completed_at`, `user_id`, …), forces `stated`/`manual` provenance, rejects `completed` outside the completion path, validates recurrence (frequency, interval, anchors equal to the row's own schedule), and writes its `life_os.*` audit event in the same transaction. The Worker no longer writes a second audit event.
- Completion: the Worker computes the next occurrence with `packages/planning` (authoritative) and passes it with the row's `updated_at`. The database rejects a recurring completion without a forward-moving next schedule, a one-off completion that carries one, any change to frequency/interval/existing anchors, and a stale `updated_at` (`409 conflict`, no double rollover). `completed_at`/`lastCompletedAt` come from the database clock.

### Data-rights reads after downgrade

Ordinary SELECT requires the entitlement, so a downgraded user's Radar/Today/Life Graph no longer reads life-area rows. The right to inspect and export retained data does not depend on a paid plan: `GET /v1/privacy/life-os` and `POST /v1/privacy/export` read through `apm_life_os_data_rights_export()`, an owner-only (`auth.uid()`) definer function with no entitlement condition, so exports after downgrade still include life-area rows.

Person references use a composite `(user_id, person_id)` foreign key so a user cannot attach a life-area object to another user's Person row.

Buying/holding a life-area entitlement still does not grant action autonomy. Action permission remains a separate policy boundary.

## Mobile journey

```text
Settings
  -> Life areas
  -> add relationship OR life-admin item
  -> durable Life Graph write
  -> Today/Radar recompute
  -> complete/cancel
  -> recurring item rolls forward deterministically when applicable
```

Executive Roundtable accounts see an explanatory upgrade boundary rather than editable life-area state.

## Radar behavior

Deterministic rules surface:

- overdue/due-soon Life Admin items;
- upcoming birthdays;
- relationship contact cadence.

Lead windows vary by domain to avoid noisy generic reminders.

## Today behavior

Items due today enter the Run of Show as `life_os` blocks.

Recovery mode carries only high-importance life-area items into Today so recovery does not become a hidden catch-up day.

## Failure behavior

- missing/expired entitlement -> `403 life_os_required`;
- unknown/cross-user Person -> `404 person_not_found`;
- unknown life-area item -> `404 not_found`;
- cancelled item completion -> `409 invalid_item_state`;
- completion on a stale read (row changed since it was loaded) -> `409 conflict`;
- lifecycle violation rejected by the governed RPC (completion without rollover, forged field, bad recurrence) -> `400 invalid_request`;
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
   `services/api/test/life-os-db.test.mjs` runs migrations 0015–0017 in embedded Postgres and proves, as the `authenticated` role, that direct writes are denied, governed RPCs enforce the lifecycle and audit, and post-downgrade reads are denied while the data-rights export still returns retained rows;
6. PR architecture/security review has no unresolved actionable findings.

External/provider/mobile-device validation remains tracked separately in the runtime evidence packet.

## Privacy / lifecycle receipt

- **Owner:** the authenticated individual user.
- **Classification:** relationship/admin state is Class 2 private life by default; financial amounts and health-sensitive details can raise the relevant fields/context to Class 3.
- **Persistence:** structured state remains until corrected/deleted/account deletion; raw external source duplication is not introduced by this phase.
- **Export:** the Life Graph export includes both Phase B collections, read through the owner-only data-rights function so they are included after downgrade.
- **Deletion:** account deletion cascades through user ownership; relationship rows also cascade with their same-user Person.
- **AI processing:** Phase B Today, Radar, recurrence and lifecycle behavior are deterministic. No new inference route receives life-area data in this phase.
- **Analytics:** only coarse event/domain metadata is recorded; private titles, notes, amounts and relationship content are excluded.
- **Inspection/correction:** Privacy & AI → Your Data exposes life-area state; Settings → Life areas is the current correction/completion surface.

## Provisioning receipt — 2026-10-06

**Supabase project:** `aplayer-mode` (`klzbnchgoqmnwsgolwoe`)

Applied database migrations:

- `life_os_domains`
- `life_os_data_rights_hardening`

Live schema inspection confirmed:

- same-user Person foreign keys are present;
- deleting a linked Person nulls only `life_admin_items.person_id` and preserves `user_id`;
- Life-area mutation policies require active/trialing Executive Suite or Autopilot entitlement (superseded by 0017: direct mutations are revoked entirely; writes go through governed RPCs);
- owner SELECT policies remain available for data-rights inspection/export after downgrade (superseded by 0017: SELECT requires entitlement again; data-rights reads use `apm_life_os_data_rights_export()`);
- the temporary public `SECURITY DEFINER` export RPC was removed;
- the composite Life Admin Person foreign key has a covering index.

Post-migration Supabase security advisor: **0 security lints**.

Performance-advisor notices outside the new life-area path remain repo-wide optimization backlog and are not promoted into this Phase B scope.

## Migration 0017 — `life_os_governed_writes`

Closes the two P1 findings from the Codex review of `1c91c9d` (direct-write bypass; read weakening in 0016). Applied 2026-10-06 to `klzbnchgoqmnwsgolwoe` via the Management API as migration `life_os_governed_writes` (listed after `life_os_data_rights_hardening`).

Live receipt:

- `anon` INSERT into `life_admin_items` -> `42501 permission denied for table life_admin_items`;
- `anon` call to `apm_life_os_data_rights_export` -> `42501 permission denied for function`;
- post-migration Supabase security advisor: **0 security lints**.
