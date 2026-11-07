# A Player Mode: store launch plan (App Store + Google Play)

**Status: PLAN + SETUP (Claude, Sat 7 Nov 2026). The build is Codex's on Tue 10 Nov 2026.**
Finish line (Open Loops): A Player Mode live in both stores. Rulings: brand approved 6 Nov 2026 (design system https://claude.ai/artifact/QewMGNAFFtkKtdLokLmdSd); store accounts are the company's (Redwood Reserve Holdings LLC) once the D-U-N-S number exists, w/c 9 Nov 2026; she sees every build as a free web preview before anyone pays; Appetize only for her final look before submission; agents never spend money or create accounts.

## Where it stands (source-complete, not runtime-proven)

| Area | State | Where |
|---|---|---|
| App, rebrand, icons | Done | #62; `apps/mobile` |
| Store listing text | Drafted (name, subtitle, keywords, description, 2 screenshot scenes) | `apps/mobile/store/app-store.json`, `test/store-listing.test.mjs` |
| Build profiles | `preview` (internal, apk) and `production` (autoIncrement), all `store` distribution | `apps/mobile/eas.json` |
| Bundle id | `com.aplayermode.app` (iOS and Android) | `apps/mobile/app.json` |
| Review rules | Placeholder copy, webviews, web checkout in store builds, iPad, restore, delete, demo login: all in code | docs/35, `npm run presubmit:ios` |
| In-app products | Ids in code: `apm_cos_monthly`, `apm_cos_monthly_founding`, `apm_cos_annual`, `apm_lifeos_monthly`, `apm_lifeos_annual`, `apm_autopilot_monthly`, `apm_autopilot_annual` | `src/billing/` |
| Store products, RevenueCat store apps | Not created | needs the store accounts |
| Screenshots | 2 scenes written, none rendered | below |

## Codex's Tuesday task list (in order; each with its proof)

1. **Store screenshots from the real app.** Render 6.7" iPhone (1290×2796) and Android phone (1080×1920) screenshots of the two scenes in `app-store.json` plus Today, the plan builder and the Plan screen, with the approved logo and captions. *Proof:* files under `apps/mobile/store/screenshots/<platform>/`, a test that each listed scene has a file of the right size, no real names on screen.
2. **Store listing for Google Play.** `apps/mobile/store/google-play.json`: title (≤30), short description (≤80), full description (≤4000) from `app-store.json`, category Productivity, contact `hello@aplayermode.com`. *Proof:* `store-listing.test.mjs` checks the limits and that prices appear only with their terms.
3. **Privacy answers.** `apps/mobile/store/privacy.json`: Apple nutrition-label answers and the Play Data safety form, generated from the data-rights registry (docs/09), never typed by hand. *Proof:* a test that every collected data type in the registry appears in both answers.
4. **Age rating and content answers.** 12+ for coaching content (no medical claims; "not medical advice" line stays). *Proof:* in `app-store.json`, pinned by the listing test.
5. **EAS submit profiles.** `submit.production` for iOS (App Store Connect app id placeholder `ASC_APP_ID`) and Android (service-account key path `GOOGLE_PLAY_KEY`), secrets referenced by name only. *Proof:* `eas.json` parses; presubmit passes; no secret value in the repo.
6. **RevenueCat store wiring, behind a named stop.** Map each product id above to its App Store / Play product in `src/billing/catalog.ts` config; when the store products do not exist yet, the paywall shows the named stop `STORE_PRODUCTS_MISSING` in logs and the plan list says "not available yet" (never a fake price). *Proof:* a test with no offerings shows no price and logs the stop.
7. **Preview build for her look.** `preview.yml` web preview link from CI on the branch (free); Appetize only when she asks for the final look. *Proof:* the CI run's link.
8. **Pre-submit run.** `npm run presubmit:ios` and the full `apps/mobile` test suite green on the branch, then a draft PR; nothing is submitted.

## What needs her (and only her)

| # | Step | Cost | When |
|---|---|---|---|
| 1 | D-U-N-S number for Redwood Reserve Holdings LLC | free | w/c 9 Nov |
| 2 | Apple Developer Program, company account | $99/yr (hers) | after 1 |
| 3 | Google Play Console, company account | $25 once (hers) | after 1 |
| 4 | Create the 7 in-app products in both stores (ids above, prices from ADR-0004) | free | after 2, 3 |
| 5 | Connect both store apps in RevenueCat (keys into the vault) | free | after 4 |
| 6 | App Review demo account: set `APP_REVIEW_EMAIL` / `APP_REVIEW_CODE` | free | before submit |
| 7 | Final look on Appetize, then "submit" | free | last |

Google Play needs a 14-day closed test with 12+ testers before production on a new personal account; a company account with a D-U-N-S number is the route here.

## Risks and rules
- No income, health or weight-loss promises; "results are examples, not guarantees"; prices always with their terms; scarcity only as the true live Founding 100 count (spry brain, Voice).
- No web checkout in a store build (3.1.1), already enforced by presubmit.
- A Player Mode is the five-person executive team; it is not framed around any single life area.
