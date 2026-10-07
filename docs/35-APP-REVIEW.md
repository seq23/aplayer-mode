# A Player Mode: App Review (bugs and App Store readiness)

**Status:** DONE in source, 7 Oct 2026. Every CONFIRMED P0–P2 below is fixed with a test in `apps/mobile/test/app-review.test.mjs`, `services/api/test/app-review-db.test.mjs`, `services/api/test/review-login-worker.test.mjs` or `services/api/test/coaching-worker.test.mjs`, and each guard was proven negatively (broken on purpose, seen red, restored). No restyling: the look is the next phase.
**Scope:** `apps/mobile` (every route and shared module) and the API routes it calls, at `main` 8944f09. Line numbers are at that commit.
**Read first:** docs/34 (§6 persistence, §13 audit, §14 decisions), docs/29, docs/31, docs/33, `packages/policy` (Executive Roundtable / Executive Suite / Autopilot).
**Binding principle:** reducing cognitive load means APM GENERATES the concrete thing (routine, steps, order, prompt) and never asks the person to design it.

Severity: **P0** a person is stuck or App Review rejects; **P1** loses data, misleads, or blocks a core path for many; **P2** real friction or a wrong state with a way out; **P3** polish.

## 1. Findings: senior mobile engineer

| # | | Sev | Where (8944f09) | Finding | Fix |
|---|---|---|---|---|---|
| E1 | CONFIRMED | P1 | `app/index.tsx:21` | An installed person who opens the app offline (or while the API is down) is sent back into setup at the summary or paywall: the "couldn't reach" screen only showed when the draft was empty, and the draft is kept after install. The owner's original complaint, from the other side: what she did looked lost. | The retry screen also shows when the draft is installed on this phone (`installedVersion`). |
| E2 | CONFIRMED | P1 | `src/api/apmApi.ts:226` | No request timeout: on a stalled network "Opening your APM…" and every busy button spin forever with no way out. | 20 s `AbortController` ceiling on every call; plain "taking too long" error; Try again on Index and Today. |
| E3 | CONFIRMED | P1 | `src/api/apmApi.ts:226`, `src/auth/supabase.ts:97` | After an hour in the background the first call goes out with an expired token (the auth client's refresh is asynchronous on resume) and fails as "unauthorized (401)". | On a 401 the client refreshes the session once and retries (`setAccessTokenRefresher`, registered by the session layer). |
| E4 | CONFIRMED | P1 | `src/api/apmApi.ts:235` and every `setError(cause.message)` | Errors show codes, statuses and request ids: "life_os_required (403) · 4f1c…". | `ApiError` (`src/api/errors.ts`) carries status/code/requestId for code; the message is a plain sentence. `plainError()` for every screen. |
| E5 | CONFIRMED | P0 | `app/(tabs)/today.tsx:232`, `services/api` `loop_entitlement_required` | Plan gating dead end: a new account with no plan (and "Continue to Day 1" on web outside the beta) lands on a Today whose check-in the database refuses with "Your plan does not include the daily loop right now. (403)" and no path to a plan. | `hasDailyLoopAccess` (`src/billing/access.ts`) mirrors the server rule; Today shows "Your OS is ready. Pick a plan to start Day 1" with See plans (or, on web, where plans are chosen) and hides the check-in and close it would refuse. |
| E6 | CONFIRMED | P0 | `src/billing/PlanChoice.tsx:149,177` | Onboarding paywall dead end on a store build: an anonymous session ("Not now" at the account step), missing legal URLs or a failed offering load disables every purchase button, and the only way on ("Continue to Day 1") showed only when the build could not buy at all. The plan screen has no Back. | A way on is always there ("Decide later, show me Today"); an anonymous session saves its account right on the paywall; a failed load has Try again. |
| E7 | CONFIRMED | P1 | `app/settings/privacy/export-delete.tsx:68` | Account deletion fired on ONE tap with no confirmation, three screens deep, then left the person signed in with a job id. | Settings → "Delete my account" → "Delete everything" (2 taps) calls `POST /v1/privacy/delete`, signs out and says so on the welcome page. Privacy page asks too. |
| E8 | CONFIRMED | P1 | `app/settings/index.tsx` | Restore Purchases only on the paywall. | Restore purchases in Settings → Plan. |
| E9 | CONFIRMED | P2 | `app/(tabs)/apm.tsx:85` | A failed coach send clears what she typed. | The message goes back in the box and her turn is removed. |
| E10 | CONFIRMED | P2 | `src/components/ui.tsx:26` | `Screen` had no keyboard handling: the coach box, the close-the-day note and the goal fields sit under the iOS keyboard; taps on buttons with the keyboard up are swallowed. | `KeyboardAvoidingView` (iOS padding) + `keyboardShouldPersistTaps="handled"`. |
| E11 | CONFIRMED | P2 | `app/review.tsx:17,22` | Weekly debrief: a load failure shows "Loading…" forever; "Record the debrief" records again on every tap. | Try again on failure; busy/done guard. |
| E12 | CONFIRMED | P2 | `app/settings/index.tsx:12` | Sign-out failure is an unhandled rejection; nothing on screen. | Caught and shown. |
| E13 | CONFIRMED | P2 | `src/intake/store.tsx:148` | An install the server refuses (4xx) was ALSO queued as "offline", so the plan screen promised "We'll finish installing as soon as you're online" forever. | Refusals are thrown before anything is queued. |
| E14 | CONFIRMED | P3 | `app/_layout.tsx` | Diary, Weekly debrief and Drafting Room headers showed the file name ("diary", "settings/os"). | Registered with titles. |
| E15 | CONFIRMED | P3 | `app/(tabs)/apm.tsx:182` | A safety resource of kind `text` would dial (`tel:`) instead of opening Messages (latent: no resource uses it today). | `openExternal` maps `text` to `sms:`. |
| E16 | CONFIRMED | P2 | `app.json:37` | `supportsTablet: true` with phone-only layouts (full-width cards, no max width). | **Decision: `supportsTablet: false`.** iPad runs the iPhone app; a tablet layout belongs to the design phase. |
| E17 | CONFIRMED | P2 | `PlanChoice.tsx:130,190`, `apm.tsx:182` | External links opened ad hoc with `Linking.openURL`; nothing stopped a future webview or http link. | One helper, `src/links/external.ts` (`openExternal`: https only, system browser, digits-only phone numbers); `npm run presubmit:ios` enforces it. |
| E18 | CONFIRMED | P3 | `today.tsx:174` | "Good morning" at 9 p.m. | Greeting follows the clock. |
| E19 | SUSPECTED | P3 | `src/state/lifeGraph.tsx:139` | Every hourly token refresh refetches Today (`user`/`accessToken` change identity). Harmless now (no screen unmounts on it) but wasteful. | Listed, not changed. |
| E20 | CONFIRMED | P3 | `app/settings/*`, deep links | A signed-out deep link to a settings screen (`aplayermode://settings/plan`) shows "Loading…" until Back. | Listed. |
| E21 | CONFIRMED | P3 | `app/settings/autopilot.tsx:220` | A failed load had no retry. | Try again. |
| E22 | CONFIRMED | P3 | `app/(tabs)/today.tsx:108` | One shared `busy` flag: every Mark done reads "Recording…" while any one saves. | Listed. |

## 2. Findings: overwhelmed people

Walked as a burnt-out parent, a founder drowning in email, an athlete, an operator with a side project, and someone at the low-capacity floor.

| # | | Sev | Where | Who | Finding | Fix |
|---|---|---|---|---|---|---|
| U1 | CONFIRMED | P1 | `app/(tabs)/goals.tsx:142,144` | parent, operator | Adding a goal makes her pick one of 16 areas and type an ISO date; a 1–2 character title silently does nothing. | APM files the goal from its words (`classifySuggestedArea`), shown as one line with "Change the area"; date optional with a plain format message; a short title says why. |
| U2 | CONFIRMED | P1 | `app/(tabs)/apm.tsx:154` | founder, operator | Deep Work asks her to type "the one task for this block". | APM names it from today's priority / foreground; she only taps a length (editing optional). |
| U3 | CONFIRMED | P2 | `today.tsx:178,185` | all | "Server-backed" / "Connection needed" pill and "APM is not pretending local state is durable" card. | Removed; "APM can't reach your account right now. Nothing is lost." with Try again. |
| U4 | CONFIRMED | P2 | `app/settings/os.tsx:113` | operator | Drafting Room shows a draft as raw JSON (`{"name":"movement","critical":true}`). | `describeOsChange` reads it as words. |
| U5 | CONFIRMED | P2 | `today.tsx:96,294` | founder, floor | Day-90 decision: nothing pre-selected although APM recommends one, and "Record the decision" silently does nothing until she types a reason. | APM's recommendation pre-selected; the why is optional (APM writes it). One tap. |
| U6 | CONFIRMED | P2 | `export-delete.tsx:46,67` | all | Export/Delete copy ("privileged deletion worker verifies every lifecycle step", job ids). | Plain copy; result in words. |
| U7 | CONFIRMED | P1 | `app/settings/plan.tsx:70`, `settings/index.tsx:29` | all; App Review 2.1 | "Household OS · Later" interest card is a "coming soon" placeholder. | Removed from the app (the API and interest data stay). |
| U8 | CONFIRMED | P3 | `app/(tabs)/apm.tsx` | floor, parent | The Coach tab puts six mode buttons, a rulebook row, the mode rules and six core laws on one screen. | Listed for the design pass (one recommended mode, the rest behind "Other modes"). |
| U9 | CONFIRMED | P3 | `today.tsx` | floor | Today is long: up to ~15 cards (agenda, first hour, stack, radar, run of show, approvals, open loops, OS, close, trust). | Listed for the design pass (one next step on top, the rest folded). |
| U10 | CONFIRMED | P3 | `today.tsx:109,251,273` | all | Engineering words left on Today: "REPRINT", "Locked for today / Preview", "Invalid agenda", "plan_action". | Listed for the design pass (copy system). |
| U11 | CONFIRMED | P3 | `app/settings/notifications.tsx:72,80` | parent | Wake time and quiet hours are typed as 24-hour HH:MM. | Listed (time picker in the design pass). |
| U12 | CONFIRMED | P3 | `app/review.tsx:60` | founder | The weekly "one adjustment" is a blank box (optional). | Listed: APM should propose the adjustment from the friction lines. |

## 3. App Store rejection items (in code)

| Item | Done as | Test |
|---|---|---|
| No "Coming soon" / placeholder screens | Household "Later" card removed; `presubmit:ios` fails on "coming soon", "lorem ipsum", "placeholder screen". | `app-review.test.mjs` (iPad/Household; presubmit negative proof) |
| "Report this" on AI coach replies, stored with an audit row | Every coach reply returns its stored `turnId`; "Report this" → reason → `POST /v1/apm/coach/report` → `public.apm_report_coach_reply` (migration **0066**): own assistant replies only, reply snapshot kept, one per reply, `coaching.reply_reported` audit row (ids + reason, never text), in the data-rights registry. | `app-review-db.test.mjs`, `coaching-worker.test.mjs`, `app-review.test.mjs` |
| External links in the system browser, not a webview | `src/links/external.ts` `openExternal` (https only; `tel:`/`sms:` digits only). Terms, Privacy, manage-subscription and crisis links go through it. | `app-review.test.mjs` + `presubmit:ios` |
| iPad decision | **`supportsTablet: false`** (iPad runs the iPhone app). | `app-review.test.mjs` + `presubmit:ios` |
| Demo login without email | `POST /v1/auth/review-login`, off unless `APP_REVIEW_EMAIL` + `APP_REVIEW_CODE` are set, one address only, constant-time, audited `auth.review_login`. docs/33 §8. | `review-login-worker.test.mjs`, `app-review-db.test.mjs` |
| Restore Purchases in Settings and the paywall | Settings → Plan → Restore purchases. | `app-review.test.mjs` |
| Account deletion ≤ 2 taps from Settings, real delete | "Delete my account" → "Delete everything" → `POST /v1/privacy/delete` (the data-rights erasure job), then sign-out. | `app-review.test.mjs` |

## 4. The pre-submit check

`npm run presubmit:ios` (`scripts/presubmit-ios.mjs`, also a CI step) scans `apps/mobile/app` and `apps/mobile/src` and fails on: placeholder copy; Stripe (code or dependency); any http(s) literal outside the three allow-listed files (`src/links/external.ts`; `src/billing/catalog.ts` store/EULA URLs handed to `openExternal`; `app/settings/privacy/connections.tsx` OAuth scope identifiers shown as text); `Linking.openURL` outside the helper; `openBrowserAsync` / `react-native-webview` / `<WebView`; `app.json` `ios.supportsTablet` not `false`; and zero files scanned. `app-review.test.mjs` proves each rule red on a copy of the app with that one violation planted.

## 5. Not changed here

- P3s listed above with "Listed": design-phase work (layout, copy system, pickers) or harmless (E19).
- Runtime proof (a device, real store sandbox, the reviewer account against production Auth) stays Phase E (docs/33 §8).
