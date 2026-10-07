# A Player Mode

**The operating system for your life.**

This repository contains the mobile-first A Player Mode product and its canonical product/architecture documentation.

## Current execution phase

The shared platform foundation is in place. We are now building the **three individual APM service levels** in one app:

```text
Executive Roundtable → Executive Suite → Autopilot
                      \
                       Household = waitlist only for now
```

Executive Roundtable, Executive Suite and Autopilot share the same account, Life Graph, privacy boundary and policy engine. A subscription makes capability available; it never grants action authority by itself.

The first mobile implementation intentionally begins with the **Trust Center and product shell using fixture data** so the privacy, AI, connection, and autonomy experience is understandable before real private integrations are connected.

## Repository map

```text
/
├── apps/
│   └── mobile/          # Expo / React Native app
├── docs/                # Canonical locked decisions and specifications
├── packages/            # Shared domain/privacy/AI/policy modules (next)
├── services/            # API service (next)
└── .github/             # CI and engineering controls
```

## Documentation comes first

Read [`docs/README.md`](./docs/README.md).

Locked constitutions outrank implementation. Material changes require an ADR and explicit approval.

## Mobile development

From the repository root:

```bash
npm install
npm run mobile
```

Or:

```bash
cd apps/mobile
npm install
npm run start
```

The app now has a source-complete platform foundation backed by Supabase Auth/Postgres/RLS plus Calendar/Email/AI/action integration foundations. External provider/device/store behavior remains unproven until the runtime evidence packet contains real receipts.

## Current core navigation

```text
TODAY · RADAR · GOALS · APM

Settings
└── Privacy & AI
    ├── Your Data
    ├── How APM Uses AI
    ├── AI Providers
    ├── Connections
    ├── Permissions & Autonomy
    ├── APM Activity
    └── Export & Delete
```

## Engineering invariant

> No production inference may bypass the Privacy Gateway, and no consequential action may bypass the Policy/Permission Engine.
