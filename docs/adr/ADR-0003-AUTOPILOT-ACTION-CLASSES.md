# ADR-0003 — Autopilot May Send, Move/Decline, Book Free and Cancel, Inside Standing Rules

**Status:** ACCEPTED / LOCKED
**Date:** 2026-10-06
**Approved by:** Product owner (ruling of 6 Oct 2026)

## Decision

The Autopilot standing-action allow-list (Phase C, docs/31) grows from two classes (`calendar.create`, `email.draft`) to seven. Inside a standing rule the user writes, Autopilot may act on its own for:

1. **Send emails/messages** (`email.send`) — only rule-defined kinds: scheduling replies, follow-ups/chasers on what others owe the user, confirmations, and pre-approved templates (e.g. birthday). Recipient and domain allow-lists and rate caps per rule; header-injection guards stay.
2. **Move and decline meetings** (`calendar.reschedule`, `calendar.decline`) — only events the user marked flexible or that match the rule's criteria. Foreground/Deep Work blocks are protected; a decline happens only when the meeting violates a boundary the user declared, and carries a polite note.
3. **Book appointments** (`appointment.book`) — FREE bookings only, through flows supported today (an emailed booking request). Anything that asks for a card or a deposit stops and becomes a prepared life areas action. Medical appointments are scheduling logistics only, never clinical choices.
4. **Cancel subscriptions** (`subscription.cancel`) — Autopilot may save money but never spend it: an emailed cancellation or a prepared cancellation request. It never signs up, upgrades, pays or enters payment data.

## What this supersedes

This ADR supersedes, and only supersedes, the earlier locked statements that `calendar.create` and `email.draft` are the only classes that can ever hold standing authority (docs/04 Domain Model, the Phase C row of the full-program ledger, and docs/31's "Never on Autopilot: sending email / editing existing events"). docs/04, docs/21 and docs/31 are updated to point here.

## What does not change

- Purchases, payments, upgrades/sign-ups, clinical/healthcare decisions and money movement stay **rejected by name** (`purchase.*`, `payment.*`, `subscription.upgrade`, `subscription.signup`, `healthcare.*`, `financial.*`), as do generic event edits (`calendar.update`) and connector administration.
- Buying Autopilot still grants nothing: entitlement AND level-5 permission AND an active rule AND an activated class AND every kill switch.
- Every class ships **inactive**. Activation is a separate reviewed migration that records Phase E runtime/security evidence.
- Every class meets docs/25 before merge: schema, permission, constraints, idempotency, connector, verification, audit, kill switch, plus a daily done-list entry with Undo where reversible and a clear "can't undo" label where not.
- Connecting read access never implies write access (docs/22): write scopes are a separate, explicit consent.

## Implementation

Migrations 0033–0034, `packages/policy` (`standingActionClasses`, `forbiddenStandingActions`), the Worker (`autopilotRepository`, `actionEngine`), the mobile Autopilot and Connections screens; contract and receipts in docs/31.
