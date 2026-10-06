# A Player Mode — Trust Center Screen Map

**Status: IMPLEMENTATION REFERENCE — derived from LOCKED privacy/product requirements**  
**Date: 2026-10-06**

This document gives product/design/engineering a fast visual reference for the first mobile trust experience.

## First-run journey

```mermaid
flowchart LR
  W[Welcome\nWhat APM is] --> P[Privacy Primer\nYour life is yours]
  P --> T[Today\nFirst value]
  P --> AI[How APM Uses AI]
  AI --> AP[AI Providers]
  T --> PC[Privacy & AI Center]
```

## Trust Center map

```mermaid
flowchart TD
  PC[Privacy & AI]
  PC --> D[Your Data]
  PC --> AI[How APM Uses AI]
  PC --> PR[AI Providers]
  PC --> C[Connections]
  PC --> AU[Permissions & Autonomy]
  PC --> AC[APM Activity]
  PC --> ED[Export & Delete]

  D --> DP[Provenance + Correction]
  AI --> GW[Privacy Gateway explanation]
  PR --> MR[Live Model Registry later]
  C --> OA[OAuth scope state later]
  AU --> PL[Observe → Autopilot ladder]
  AC --> LOG[Audit events]
  ED --> DL[Data lifecycle workflows later]
```

## What question does each page answer?

| Page | User question | Required answer |
|---|---|---|
| Privacy Primer | “What am I agreeing to?” | Core privacy promise in plain language |
| Your Data | “What does APM know?” | Inspectable Life Graph facts + provenance + correction |
| How APM Uses AI | “Where does AI fit?” | Life Graph → minimum context → Privacy Gateway → approved inference |
| AI Providers | “Who processes AI requests?” | Current route/provider policy, training and retention state |
| Connections | “What accounts can APM access?” | Connected status + exact current capabilities |
| Permissions & Autonomy | “What can APM do without me?” | Domain-specific authority and autonomy level |
| APM Activity | “What has APM done?” | Human-readable audit trail |
| Export & Delete | “Can I leave?” | Export, disconnect and deletion controls |

## Core privacy visual

```mermaid
flowchart LR
  LG[(Your Life Graph)] --> R[Retrieve only relevant facts]
  R --> C[Classify sensitivity]
  C --> M[Minimize / redact]
  M --> PG{Privacy Gateway}
  PG -->|eligible| L[Approved AI route]
  PG -->|no compliant route| X[Fail closed / degrade]
  L --> V[Validate result]
  V --> A[APM experience]
```

## Autonomy visual

```mermaid
flowchart LR
  O[0 Observe] --> R[1 Remind] --> RC[2 Recommend] --> P[3 Prepare] --> E[4 Approve & Execute] --> A[5 Autopilot]
```

**Important:** higher product tiers can unlock availability of higher levels, but the user still grants authority by domain/action type.

## Radar trust loop

```mermaid
flowchart TD
  N[APM notices something] --> S[Surface concise Radar item]
  S --> W[Why am I seeing this?]
  W --> E[Evidence + source + state]
  E --> U{User response}
  U -->|Correct| C[Update canonical state]
  U -->|Complete| D[Close loop + evidence]
  U -->|Act| A[Prepare / execute within permission]
  U -->|Dismiss| F[Record relevance feedback]
```

## Current implementation matrix

| Surface | Fixture UI | Real backend | Real integration | Production ready |
|---|---:|---:|---:|---:|
| Welcome | ✅ | n/a | n/a | No |
| Privacy Primer | ✅ | n/a | n/a | No — legal review later |
| Today | ✅ | No | No | No |
| Radar | ✅ | No | No | No |
| Why APM saw this | ✅ | No | No | No |
| Your Data | ✅ | No | No | No |
| How APM Uses AI | ✅ | No | No | No |
| AI Providers | ✅ | No | No | No |
| Connections | ✅ | No | No | No |
| Permissions & Autonomy | ✅ | No | No | No |
| APM Activity | ✅ | No | No | No |
| Export & Delete | ✅ | No | No | No |

## Design acceptance grid

A trust screen is not complete until a normal user can answer:

| Requirement | Pass condition |
|---|---|
| Plain language | Meaning is understandable without legal/AI jargon |
| Source clarity | Important personal facts can show where they came from |
| Permission clarity | User knows what APM can and cannot do |
| AI clarity | User understands inference ≠ public-model training |
| Control | User can find correction/disconnect/permission/export/delete paths |
| No false promise | UI claims match actual production behavior |
| Progressive disclosure | Important summary first; technical detail available but not forced |
