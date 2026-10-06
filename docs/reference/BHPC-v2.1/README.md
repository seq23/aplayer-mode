# Billionaire High-Performance Coach OS — v2.1 Reference

**Reference status: CANONICAL SOURCE-OF-INTENT**  
**Source version: Canonical System Manual v2.1**  
**Product: A Player Mode**

> **Whatever game you're in, get into A Player Mode.**

This directory preserves the latest canonical BHPC manual currently available to this project so every engineer, designer, product operator, coding agent, and LLM working on A Player Mode can inspect the original methodology instead of relying on memory or partial summaries.

## Why this exists

A Player Mode is broader than the original BHPC positioning. The app must work for a parent, athlete, entrepreneur, student, professional, creator, caregiver, investor, or someone moving through a major life transition.

That broader positioning does **not** mean the underlying behavioral and execution intent of BHPC should disappear.

The implementation job is:

```text
BHPC SOURCE INTENT
        ↓
identify the behavioral / operating purpose
        ↓
translate it into durable APM software primitives
        ↓
adapt language/context to the user's game(s)
        ↓
verify the intent still survives in the product
```

The rule is **translate the intent, not blindly copy the persona language**.

Examples:

- “Billionaire Mindset” is a relevant optional Track for business/investing users; it is not forced on a parent or student.
- “One question at a time” is a universal intake/coaching behavior and should survive for every user.
- “Never Miss Twice,” “No Catch-Up,” MVD, Recovery, Foreground/Background, Arbitration, and user sovereignty are methodology behaviors—not founder-only features.
- The legacy three-chat architecture maps to app boundaries: Personal OS / Life Graph, daily runtime, and governed settings/change control.

## Authority relationship

This reference is **source-of-intent**, not an instruction to overwrite newer locked APM product decisions.

Repository authority remains:

```text
LOCKED APM Constitutions / Product Requirements
        ↓
Approved ADRs
        ↓
APM specifications
        ↓
Implementation + tests
```

The BHPC manual sits beside that hierarchy as the canonical methodology reference used to answer:

> “What was this behavior originally trying to accomplish, and has the app preserved that intent for every relevant persona?”

If implementation differs from the manual because the app architecture is more durable, provider-neutral, privacy-safe, or multi-persona, the implementation should preserve the **functional intent** and document the translation.

## Source files

The manual is split only to make GitHub review/navigation practical. The source text is preserved by section and should not be casually rewritten.

| File | Source coverage |
|---|---|
| `00-FRONT-MATTER-AND-PART-0.md` | title, legal/disclosure, privacy, quick reference, table of contents |
| `01-PART-I-III.md` | system thesis, core laws, three-chat architecture |
| `02-PART-IV-VI.md` | installation/setup, daily execution, execution guarantees |
| `03-PART-VII-XI.md` | pillars/projects/arbitration, modes, tracks, command dashboard, platform optimization |
| `04-PART-XII-PROMPT-PACK.md` | executable prompt pack |
| `05-PART-XIII-AND-TRACK-LIBRARY.md` | first seven days + track library |
| `06-MODE-LIBRARY.md` | mode library |
| `APP-INTENT-MAPPING.md` | translation contract from BHPC intent to APM product primitives |

## Anti-drift rule

Before materially changing intake, Today, coaching, recovery, scoring, priority arbitration, Tracks, Modes, continuity behavior, or governance, contributors should inspect the relevant BHPC source section and the APM mapping document.

A change is incomplete if it improves the UI while accidentally removing the behavioral purpose that made the original system work.

## Future version protocol

When a newer canonical BHPC manual is supplied:

1. add it as a **new versioned reference directory**; do not silently overwrite v2.1;
2. record the source version/date;
3. create a delta note describing methodology changes;
4. compare those changes against current APM behavior;
5. deliberately promote applicable changes into APM specs/code through the normal governance flow.

This keeps the repo capable of answering both **what APM does now** and **where the operating intent came from**.
