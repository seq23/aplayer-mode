# A Player Mode: Hostile UX Review (every button, every flow)

**Status:** DONE in source, 7 Oct 2026. Every CONFIRMED P0–P2 below is fixed; behaviour and copy changes are pinned in `apps/mobile/test/hostile-ux.test.mjs` (plus stricter pins in `first-run.test.mjs` and `design-system.test.mjs`), and each new guard was proven negatively (broken on purpose, seen red, restored).
**Scope:** `apps/mobile` at `main` d4f4a31 (the design overhaul, PR #39), every route, every shared component, and the coach mode definitions the app shows (`services/api/src/coach/modes.ts`). Line numbers are at d4f4a31.
**Binding principle:** reduce cognitive load. APM GENERATES the concrete thing and never asks the person to design it; every screen has one obvious next step.
**Method:** every `Button`, `LinkButton`, `Chip`, `ChoiceRow`, `AnswerCard`, `ListRow` and `Disclosure` enumerated from the code (≈210 controls across 31 files), checked against its label, its pressed / disabled / busy state, target size, accessibility label, hierarchy, confirmation and double-tap behaviour; then the 38 PR #39 screenshots plus 52 new ones (light and dark, 390×844) read one by one. Lens B walked welcome → intake → summary → paywall → Today → coach → settings as five people.

Severity: **P0** stuck or App Review rejects; **P1** loses the sale, misleads, or blocks a core path; **P2** real friction or jargon on a main path; **P3** polish.

## Counts

| | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| Lens A (engineer/designer) | 0 | 2 | 16 | 6 | 24 |
| Lens B (overwhelmed people) | 0 | 1 | 20 | 2 | 23 |
| **Total** | **0** | **3** | **36** | **8** | **47** |

Fixed: all 39 P0–P2 and 4 of the 8 P3s (A-2 relabelled, A-3, A-4, A-6). Left: 4 P3s (§4).

## 1. Lens A: senior mobile engineer / designer

| # | | Sev | Where (d4f4a31) | Finding | Fix |
|---|---|---|---|---|---|
| H2 | CONFIRMED | P1 | `src/billing/PlanChoice.tsx:145-149` | The paywall puts 13 tier-grid cards (5 + 8 rows, ~4 screen heights) between the offer and the first Buy button. On a phone the decision is buried; nobody scrolls that far at $24.99–$79.99. | Plans and their buy buttons come straight after the offer; both grids fold into one "Compare the three plans" disclosure below. |
| H3 | CONFIRMED | P1 | `src/components/today/FirstRunCards.tsx:96-111` | Coaching-mode chips on Today: no in-flight guard, and tapping the active chip silently EXITS the mode. A double tap enters a mode and then leaves it again; errors shown with a regex-trimmed raw message; role `checkbox` for a one-of-many choice. | Ref-based in-flight lock + "Switching…" label; `role="radio"` in a radiogroup; "On now. Tap it again to go back to your usual day."; `plainError`. |
| H5 | CONFIRMED | P2 | `src/components/ui.tsx:189-216` | `Button` has no disabled reason and no double-submit protection: a disabled button is a dead grey slab (the owner's complaint on Today), and every screen re-implements a `busy` flag (some not at all). | `disabledReason` (shown under the button, read as its hint, styled as a calm dashed "waiting" state, not 42 % grey); an `onPress` that returns a promise locks the button synchronously and shows a spinner (`accessibilityState.busy`). Adopted on Today, coach, paywall, goals, diary, settings. |
| T3 | CONFIRMED | P2 | `app/(tabs)/today.tsx:250` | "Print my agenda" is disabled until a number is tapped, with no hint of what unlocks it; "Print" is the wrong verb for an app. | "Show my plan for today", `disabledReason="Tap a number above first."`, busy "Setting up your day…". |
| T6 | CONFIRMED | P2 | `today.tsx:131` (docs/35 E22) | One shared `busy`: every "Mark done" says "Recording…" while one saves. | Per-item `busyItemId`; the others are disabled, not relabelled. |
| C7 | CONFIRMED | P2 | `app/(tabs)/apm.tsx:205` | "Send" is enabled on an empty box and silently does nothing. | Disabled with "Type a reply first."; busy spinner while APM answers. |
| D2 | CONFIRMED | P2 | `app/diary.tsx:31` | "Log it" on an empty box silently does nothing. | Disabled with "Write a line first."; busy spinner. |
| E-1 | CONFIRMED | P2 | `app/diary.tsx:21`, `settings/life.tsx` ×5, `settings/notifications.tsx` ×2, `privacy/activity, autonomy, connections, data, providers.tsx`, `AccountPanel.tsx:44` | 13 places still show `cause.message` (docs/35 E4 fixed only some): a TypeError or SDK string reaches a person. | All go through `plainError()`; design-lint rule 8 now fails the build on `cause.message`/`error.message` in copy code. |
| P-1 | CONFIRMED | P2 | `PlanChoice.tsx:175` | Every buy button can be disabled (no store offering yet, anonymous session, failed load) with no reason; on web all three are dead. | `buyBlockedReason()` says why under each; where the build cannot buy at all the buy buttons are not rendered (the card above says where to buy). One accent buy button (the recommended plan); the others secondary. |
| P-2 | CONFIRMED | P2 | `PlanChoice.tsx:168`, `goals.tsx:112` | `Pill tone="success"` on an `accent` card is invisible: `successSoft` = `accentSoft` in both schemes ("Recommended", "Current", "Main goal" read as floating text). Same on the Privacy card. | `tone="solid"` on accent cards; Privacy card rebuilt as check rows. |
| ST1 | CONFIRMED | P2 | 14 pushed routes (`settings/*`, `privacy/*`, `diary`, `review`) | Every pushed screen says its name twice: native header "Notifications" + eyebrow "NOTIFICATIONS". | Eyebrow dropped on every route with a native title; a test walks the `_layout.tsx` titles and fails on any eyebrow. |
| ST2 | CONFIRMED | P2 | `app/settings/index.tsx:73` | The Plan card's title is all three plan names, never HER plan. | Her plan by display name (or "No plan yet"), "Change plan" / "See plans". |
| ST3 | CONFIRMED | P2 | `settings/index.tsx:66` (docs/35 E20) | A signed-out deep link to Settings shows "Not signed in" with no way in. | "You are not signed in" card with Sign in. Sign out moved from the first button on the page to the Account section at the bottom. |
| AC1 | CONFIRMED | P2 | `app/account.tsx:13` | "Back" is `router.back()`; opened from a deep link there is nothing to go back to. | `canGoBack() ? back() : replace('/welcome')`. |
| PL1 | CONFIRMED | P2 | `app/settings/plan.tsx:27,37`, `PlanChoice.tsx:173` | "Status: active" (raw enum), "Maximum autonomy: 2 · …", "Autonomy ceiling" on each plan card. | Status in words; "The most APM may do on its own: Prepare"; the ceiling row removed from plan cards (the promise line says it). |
| T16 | CONFIRMED | P2 | `today.tsx:402,414,440` | Emoji (✅ ⚡ ❌) next to a Feather icon set; the 7-day legend reads "· · not closed"; verdict chips "MVD". | `ContinuityStrip`: seven labelled Feather icons + a legend in words; "Done / Partly / Missed"; "Full day / Light day / Missed". |
| G7 | CONFIRMED | P2 | `goals.tsx:46,49,117` | ISO dates ("2026-10-08 → 2026-11-06"), raw verdict keys, raw arbitration scores ("0.73"). | `shortDate()` ("Oct 8 to Nov 6"); words for decisions; ranked list, no scores. |
| R2 | CONFIRMED | P2 | `today.tsx:373`, `radar.tsx:38`, `radar/why.tsx` | Radar tags are engine keys: "slipping · high". | `radarTag()` → "Slipping · important". Approval tags likewise (`actionTag()`: "Email · send reply"). |
| A-1 | CONFIRMED | P3 | `app/index.tsx:20`, `review.tsx:74` | "Opening your APM…" / "Loading…" are bare text, no spinner. | Listed (§4). |
| A-2 | CONFIRMED | P3 | `today.tsx:388` | "Something changed?" replan chips fire on one tap with no confirm. | Kept one tap (the replan is reversible and the copy now says what each does); labels in words ("My day changed", "I'm worn out"). |
| A-3 | CONFIRMED | P3 | `(tabs)/_layout.tsx:35` | The coach tab is labelled "APM". | "Coach". |
| A-4 | CONFIRMED | P3 | `PlanChoice.tsx:175` | Buy labels carry the full price string ("Subscribe to Executive Roundtable · $9.99/month for 3 months, then…"): two lines on a 390 pt button. | Label is the action; the price stays in the card and in the accessibility label. |
| A-5 | SUSPECTED | P3 | `app/settings/autopilot.tsx`, `life.tsx` | Long forms in a card at the largest Dynamic Type: fine in code (`maxFontSizeMultiplier` on every text, wrapping rows) but not run on a device at AX5. | Listed (device pass, docs/33 §8). |
| A-6 | CONFIRMED | P3 | `today.tsx:203` | "Standard" and "Not started" pills say nothing next to "0 of 1 done". | Only a non-standard mode and the done count show. |

## 2. Lens B: overwhelmed people

Walked as a burnt-out parent, a founder drowning in email, an athlete, an operator with a side project, and someone barely functioning.

| # | | Sev | Where (d4f4a31) | Who | Finding | Fix |
|---|---|---|---|---|---|---|
| H1 | CONFIRMED | P1 | `app/welcome.tsx:74-90`, `src/content/sell.ts` | all | The welcome page does not SELL: the five jobs, the five personas, the six engines and the six modes are ~24 collapsed cards showing only a title ("Chief of Staff ⌄"); "How it works" (docs/34 §3.3) is missing; nothing says "five people you'd hire". A scanner sees a wall of chevrons. | Organized, visible pitch: hero → **How it works** (3 numbered steps) → why it works → **"Five people you would hire. One app."** (icon + one line each, all visible) → **pick your game** (persona chips, one persona card) → six engines and six coaching modes as visible lists → Tracks (spotlight + "the other 6" folded) → situations → advice vs system → three plans → privacy. Every section has an eyebrow. |
| T1 | CONFIRMED | P2 | `today.tsx:198` | parent, floor | "APM rebuilt Today from your Personal OS, Life Graph, calendar and current execution state." | "Your plan for today is ready. Start with the first thing; APM keeps track of the rest." (all Today copy in `src/content/words.ts` `TODAY_COPY`). |
| T2 | CONFIRMED | P2 | `today.tsx:246,248` | all | "GUIDED START · OPENING STEP", "execution starts after this answer", "Minimum Viable Day". | "BEFORE YOU START"; "Tap a number. APM sizes today to fit it. At 2 or lower, today becomes a light day automatically." |
| T4 | CONFIRMED | P2 | `today.tsx:265,455` | parent, athlete | "PRIORITY EXECUTION", item kinds "Plan step / Floor / Track floor / Next action". | "DO THIS FIRST"; "Toward your goal / Daily minimum / Next step / From yesterday". |
| T9 | CONFIRMED | P2 | `today.tsx:317` | founder | Approvals: "email · send_reply", "APM prepared this action but has not executed it. Your subscription does not grant permission; this approval is explicit.", "Approve & execute". | "Email · send reply", "APM got this ready but has not sent or changed anything. It only happens if you tap below.", "Yes, do it". |
| T10 | CONFIRMED | P2 | `today.tsx:292,302-307` | founder, operator | Gate / day-90 cards: "Recommended: promote. 23 days with evidence.", "forced decision", "Promote, Maintain or Park?", "strategic allocation choice". | "APM suggests you make it your main goal. You showed up on 23 days."; chips "Make it my main goal / Keep it as it is / Park it". |
| T12 | CONFIRMED | P2 | `today.tsx:374-379,383` | floor | "0 commitments · 0 routines · 0 Radar items" pills; a "Personal OS · Day start: Guided Start" card. | Only non-zero open loops, in words; the card becomes "Running in the background: <Tracks>". |
| T15 | CONFIRMED | P2 | `today.tsx:409-433` | parent, floor | Close the day: "Score each area… rolls them up… records evidence for continuity", "APM's verdict from the evidence", "The verdict can't claim more than the evidence". | "Two taps. Nothing carries over as debt."; "APM already filled this in from what you marked done. Change anything that's wrong, then close."; "How APM scores today"; "You marked 2 of 3 things done today." |
| T19 | CONFIRMED | P2 | `today.tsx:229,333-345,239,460` | all | "Build your Personal OS…", "Build my APM", "Foreground priority", "Background (maintenance only)", "print today's agenda", "No calendar or execution blocks", run-of-show empty state with no action. | Plain words throughout; the empty schedule offers "Connect my calendar". |
| C1 | CONFIRMED | P2 | `apm.tsx:136,150,209,259`, `services/api/src/coach/modes.ts:23,24,50` | parent, floor | Coach: "Your system changes with your state, not your standards. … Your Personal OS remains the source of truth.", "closes back into your Morning Sequence", "Running APM's built-in BHPC flow", "Background decision filter · applied to every coaching turn", Standard = "Normal execution under your Personal OS." | "Stuck? Talk it through. One question at a time. APM ends every session with the one thing to do next."; "Answered by APM's built-in coaching steps: no AI model saw your words."; mode definitions rewritten at the API source. |
| C12 | CONFIRMED | P2 | `apm.tsx:150` | founder | Deep Work: "Coaching waits until your block ends." above an enabled "Start coaching" button. | "You are in a focus block. Coaching is here if you need it; otherwise stay on the task." |
| I1 | CONFIRMED | P2 | `app/intake.tsx:185` | floor, parent | The first question says "YOUR GAME · 1 OF 54". Fifty-four questions scares off exactly the person who needs this. | "YOUR GAME · ABOUT 6 MIN LEFT" (`minutesLeftLabel`, 7 s a tap). |
| I3 | CONFIRMED | P2 | `intake.tsx:148,230-231` | floor | Quick-start choice: nothing selected, Continue grey and dead; "16 more taps, under a minute" next to "50 more, roughly 6 minutes" (two different rates). | Continue reads "Build my plan now" and takes the recommended quick start; both estimates use one rate ("about 2 min" / "about 6 min"). |
| S1 | CONFIRMED | P2 | `src/components/intake/Reveal.tsx:137,217-220` | parent (quick start) | Summary: "Your goal · first step: —". APM is asking her to notice a blank. | APM fills it from the goal template ("Launch a product · first step: Write the launch checklist"); R2 detail likewise; "Your foreground" → "Your one priority". |
| G2 | CONFIRMED | P2 | `goals.tsx:150` | parent, athlete | Adding a goal asks for a date typed as `YYYY-MM-DD`. | Horizon chips "No date / In a month / In 3 months / In 6 months / In a year"; APM computes the date. |
| G1 | CONFIRMED | P2 | `goals.tsx:100,111-113,125,131-145,158` | all | "three gates", "foreground / background", pills "unknown" and "active", "No goal in your Life Graph yet", "Arbitration Engine", "Goal → 30/60/90 gates → … Promote, Maintain or Park". | "Main goal", "Just started", "Which goal comes first?", "three 30-day stages… On day 90 you choose…". |
| R1 | CONFIRMED | P2 | `radar.tsx:24,27-28,33` | founder | "Deterministic signals only for now…", "0 high attention · 0 open", "until durable state gives APM a reason". | "Promises, deadlines and replies that are about to slip."; counts only when there is something; empty state offers "Connect an account". |
| N1 | CONFIRMED | P2 | `settings/notifications.tsx:56-90` | parent | "Enable proactive APM… registers this device", "Morning Trigger", "APM prints today's agenda", "Radar severity, deduplication… evaluated server-side". | "Let APM reach this phone", "Your plan arrives on its own", plain check list; times in the phone's clock style. |
| PV1 | CONFIRMED | P2 | `privacy/index, how-ai-works, data, export-delete, activity, radar/why`, `AccountPanel.tsx:91` | all | "Privacy Gateway, minimum-context processing and Life Graph", "Use deterministic code first… should not need an LLM", "Important persistent state is inspectable with source context", "Correct my Personal OS", "Your account is the boundary around your Life Graph". | Rewritten in plain words; design-lint rule 7 now fails the build on the jargon list anywhere in screen/component/content/billing copy. |
| ST4 | CONFIRMED | P2 | `settings/index.tsx:87-95` | all | Settings rows read like specs ("Hard/Guided start, pillars, floors, Tracks or Track settings… Draft, review, then apply."). | One short line each ("Change your morning, rules or Tracks without redoing setup."). |
| B-1 | CONFIRMED | P3 | `app/review.tsx:60` (docs/35 U12) | founder | The weekly "one adjustment" is still a blank box (optional). | Listed (§4): needs a server-proposed adjustment. |
| B-2 | CONFIRMED | P3 | `Reveal.tsx:172-178` | floor | "Name it" chips on the summary ask for a decision nobody needs; already pre-selected. | Kept (pre-selected, optional); listed as polish. |
| H4 | CONFIRMED | P2 | `src/content/sell.ts:193-194,202-203` | all | Paywall says "Introductory offer" twice (ribbon + headline). | Ribbon "Introductory offer"; headline "Founding Member price" / "$9.99/month for your first 3 months, then $24.99". Pinned: the headline never repeats the ribbon. |

(H4 is counted under Lens B.)

## 3. Guards added

| Guard | Proven red by |
|---|---|
| design-lint rule 7: jargon list (`Life Graph`, `Personal OS`, `BHPC`, `deterministic`, `durable`, `LLM`, `execution state`, `foreground`, `Print my agenda`, `Priority execution`, `opening step`, `Plan step`) in `app/`, `src/components`, `src/content`, `src/billing`; identifiers, properties and comments excluded. Runs in `npm run lint:design` (CI). | Five planted strings, one per root, each fails; identifiers/comments/`src/api` pass. |
| design-lint rule 8: `cause.message` / `error.message` in copy code. | Planted `cause instanceof Error ? cause.message : 'x'` fails. |
| `Button` disabled reason + synchronous promise lock. | Removing the `inFlight` check turns the H5 test red. |
| Paywall order (buy before grids), solid pills, no dead buy buttons on a no-store build. | Planting a `<TierGrid>` above "Choose your plan" turns H2 red. |
| Copy pins (`TODAY_COPY`, word maps, offer banner, time-left label, no eyebrow on titled routes). | Restoring "Print my agenda", the doubled headline, "1 of 54", or one eyebrow each turns a test red. |

## 4. Not changed here

- **A-1** spinners on the two bare loading texts: polish, no stuck state (both have Try again on failure).
- **A-5** Dynamic Type AX5 and **B-1** a server-proposed weekly adjustment: need a device run (docs/33 §8) and an API change respectively.
- **B-2** "Name it" chips: pre-selected and optional, so no decision is forced.
- Screenshots of every screen, light and dark, 390×844: `design-shots-v2/` in the session scratchpad.
