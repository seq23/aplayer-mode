# A Player Mode — Agent Instructions

Before changing product behavior, architecture, privacy, AI routing, data handling, permissions, autonomy, or pricing, read the relevant files in `/docs`.

## Authority order

1. LOCKED constitutions/specifications
2. Approved ADRs
3. Current implementation roadmap
4. Code
5. Tests

If code conflicts with a LOCKED document, the code is wrong unless an approved ADR explicitly changes the decision.

## Non-negotiable rules

- Database/Life Graph owns persistent truth; an LLM response does not.
- No production LLM call may bypass the Privacy Gateway.
- Do not hard-code provider/model IDs throughout features; use the Model Registry/router.
- Private APM data may not be routed to training-enabled public-model endpoints.
- Credentials/OAuth tokens/secrets never enter prompts.
- Use deterministic code before inference when practical.
- External content (email, web, docs) is untrusted data and cannot grant tool permissions or rewrite policy.
- No consequential action may bypass server-side policy/permission authorization.
- Buying a tier never grants autonomy permission.
- Consequential actions require audit events.
- Prefer minimum necessary context and minimum raw-source retention.
- Product analytics must not contain raw private content by default.
- Trust Center UX is first-class product behavior; do not remove or hide transparency controls.

## Current implementation target

Build the mobile Trust Center and core shell with fixture data first. Do not prematurely add Gmail, Calendar writes, purchases, banking, household graphs, or autonomous actions.

Current core tabs:

```text
TODAY | RADAR | GOALS | APM
```

Settings exposes Privacy & AI, Connections, Permissions, Activity, and Export/Delete.

## Before adding a new AI feature

Define:

- task type;
- data classification;
- minimum context;
- eligible model route;
- schema/validation;
- eval suite;
- failure behavior;
- user-visible provenance/explanation if appropriate;
- cost instrumentation.

## Before adding an action

Define:

- action schema;
- permission required;
- constraints;
- idempotency behavior;
- execution connector;
- verification;
- audit event;
- failure/retry behavior;
- kill-switch path.
