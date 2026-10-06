# A Player Mode

**The operating system for your life.**

This repository contains the mobile-first A Player Mode product and its canonical product/architecture documentation.

## Current execution phase

We are building the **Chief of Staff** foundation first:

```text
Trust UX → Life Graph → Today → Radar → Calendar → Gmail → proactive notifications
```

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

The initial app is a **visual/interaction scaffold** backed by fixtures. It does not yet connect Gmail, Calendar, a production database, or an external AI provider.

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
