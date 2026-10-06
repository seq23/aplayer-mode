# A Player Mode — Runtime Proof Runbook

**Status: IMPLEMENTATION BASELINE — LIVE PROVIDER PROOF REQUIRED**  
**Decision date: 2026-10-06**

## Purpose

This phase proves that the source-level APM vertical slice actually works across live provider boundaries rather than merely existing in code.

The required live chain is:

```text
Expo / test client
→ Supabase Auth
→ Cloudflare APM API
→ Supabase Data API / RPC
→ PostgreSQL RLS
→ durable Life Graph
→ server Today projection
→ completion + evidence
→ deterministic Radar
```

Source presence is not runtime proof.

## Runtime proof harness

The repository includes:

```text
scripts/verify-runtime.mjs
.github/workflows/runtime-proof.yml
```

The verifier intentionally mutates only a dedicated disposable test account. It refuses to run unless:

```text
APM_RUNTIME_PROOF_ACK_DEDICATED_TEST_ACCOUNT=yes
```

Never point the mutation proof at a real customer or founder account.

## Required configuration

GitHub repository variables:

```text
APM_API_BASE_URL
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
```

GitHub Actions secrets:

```text
APM_TEST_EMAIL
APM_TEST_PASSWORD
```

Optional second dedicated account for negative RLS proof:

```text
APM_TEST_B_EMAIL
APM_TEST_B_PASSWORD
```

The second account is strongly preferred before beta because it proves one authenticated user cannot read another user's profile through PostgreSQL RLS.

## What the verifier proves

1. deployed Cloudflare health route is reachable;
2. private APM routes reject anonymous requests;
3. Supabase password authentication succeeds for the dedicated test account;
4. Cloudflare accepts the Supabase session and returns the correct user-scoped Life Graph;
5. onboarding state is durable through the API/RPC path when needed;
6. `/v1/me/today` reconstructs the #1 move from server state;
7. action completion and evidence are committed together;
8. a fresh server read contains the completion/evidence;
9. deterministic Radar can surface the resulting open-loop condition without an LLM;
10. when the second test account is configured, cross-user profile reads return no rows.

## Running locally

Set the required environment values in the shell without committing them, then run:

```text
npm run runtime:verify
```

The script never prints access tokens, passwords, or private credential values.

## Running in GitHub Actions

Use the manual **Runtime Proof** workflow after the Cloudflare API URL and dedicated test-account credentials are configured.

This workflow is intentionally `workflow_dispatch` only. It does not mutate the live provider environment on every normal PR or commit.

## Proof states

| State | Meaning |
|---|---|
| `STRUCTURAL` | code/config exists only |
| `INTEGRATED_UNPROVEN` | provider resources exist but end-to-end proof has not run |
| `RUNTIME_PROVEN_PARTIAL` | authenticated live round trip passes but some required negative/device proof is missing |
| `RUNTIME_PROVEN_FULL` | authenticated round trip, durable state, Today, evidence, Radar and cross-user isolation are proven |

No stronger state may be claimed without the matching receipt.

## Device proof still required separately

The server verifier does not prove native device behavior. Before closed beta, record a real development-build receipt for:

- sign-up/sign-in on iOS;
- SecureStore session restoration after app termination/restart;
- mobile request to the deployed Cloudflare API;
- durable onboarding visible after restart;
- durable action completion/evidence visible after restart.

## Sequencing after runtime proof

The next product phase is **APM Methodology Engine v1** before external calendar/email breadth.

This is where the Billionaire High-Performance Coach methodology becomes product behavior rather than a prompt pack. The first-slice onboarding already captures identity/roles/a primary goal, but it is not the full intake or full coaching OS.

Methodology Engine v1 will productize the approved source system as structured state and deterministic policy where possible:

- one-question-at-a-time intake;
- identity, time/context, North Star and major goals;
- values/non-negotiables and constraints/failure patterns;
- Body/health, Work/money, Mind/spirit/learning, weekly cadence;
- scoring/streak logic, coaching style and accountability choices;
- Pillars, Tracks, Modes and Foreground/Background priority state;
- Never Miss Twice, Continuity > Intensity, No Catch-Up, No Mid-Day Negotiation, Zeros Allowed and MVD;
- Arbitration and 30/60/90 execution plans;
- daily agenda / Run of Show, end-of-day and weekly review;
- Standard Coaching, High-Pressure Coaching, Executive Review and Recovery behavior.

The old three-chat architecture is translated into software boundaries rather than recreated literally:

```text
Canonical OS / Chat A concept → durable Life Graph + rules + settings
Runtime / Chat B concept       → Today + APM coaching runtime
Governance / Chat C concept    → versioned settings changes + audit/history
```

## Calendar strategy after Methodology Engine v1

APM must not assume every user uses Google Calendar.

Calendar support is a provider-neutral **Calendar Fabric** with one canonical event model and connector capability flags.

### Lane 1 — device calendar access

Use the mobile OS calendar layer first where appropriate. On iOS/Android, the Expo calendar API can read system calendars the user has already configured on the device. That can include iCloud/CalDAV, Google and Exchange/Outlook calendars without hard-coding APM to one provider.

This gives APM broad mobile coverage early, subject to explicit device calendar permission.

### Lane 2 — direct cloud connectors

Direct cloud connectors are added for reliable server/background synchronization:

- Google Calendar API;
- Microsoft Graph for Outlook.com / Microsoft 365 / Exchange-backed calendars;
- Apple/iCloud connector through an Apple-supported account-data / CalDAV path where practical and secure.

The canonical APM calendar model remains independent of the provider.

### Least-privilege rule

Calendar begins read-only. Write scopes are requested only when the Action Engine reaches the prepare/approve/execute phase and the user explicitly grants that domain permission.

## Not implemented by this artifact

This runtime-proof artifact does **not** implement:

- the full Methodology Engine intake/coaching system;
- device calendar access;
- Google Calendar connector;
- Microsoft Outlook/M365 connector;
- iCloud/CalDAV direct connector;
- Gmail/Outlook email connectors;
- live OpenRouter inference;
- push notifications;
- autonomous actions.
