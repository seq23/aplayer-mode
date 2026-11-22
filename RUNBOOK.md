# A Player Mode — RUNBOOK

Operational entry point. Billing detail: `docs/33-BILLING-PHASE-D.md`; App Review: `docs/35-APP-REVIEW.md`; runtime proof: `docs/19-RUNTIME-PROOF-RUNBOOK.md`.

## Deploy

- **API (Worker `aplayer-mode-api`, api.aplayermode.com):** `scripts/deploy-api-production.sh [--secrets-dir ~/.config/aplayermode/secrets]`. Never a bare `wrangler deploy`. Health: `https://api.aplayermode.com/v1/health` reports the deployed SHA.
- **Database migrations:** `services/api/migrations/NNNN_*.sql`, additive only. The API deploy applies them: `scripts/db-migrations.mjs` (run by `scripts/deploy-api-production.sh` and by the production run of `deploy-cloudflare.yml`, after the tests and before `wrangler deploy`) applies every file not yet in the Supabase ledger of project `klzbnchgoqmnwsgolwoe`, in number order, through the Management API (`POST /v1/projects/{ref}/database/migrations`, named after the file), then re-reads the ledger. It refuses and nothing deploys when `SUPABASE_ACCESS_TOKEN` is missing (`land` runs it inside the Boss OS vault), the ledger cannot be read or is empty, a migration fails, or a missing file is older than one already applied (that one is applied or recorded by hand, never automatically). Features that run without their migration still log their own `NAMED STOP [MIGRATION_MISSING]` / `[CONTENT_REPORT_MIGRATION_MISSING]`.
- **Web app (app.aplayermode.com):** `scripts/deploy-web-production.sh`.
- **iOS build for TestFlight:** Expo's free plan gives a few iOS cloud builds a month. When they are used up, run `.github/workflows/ios-store-build.yml` on `main` (free GitHub Mac runner; needs the `EXPO_TOKEN`, `ASC_API_KEY_P8`, `ASC_API_KEY_ID` and `ASC_API_ISSUER_ID` repo secrets = the vault entries of the same names). It builds with the EAS signing credentials, uploads the .ipa to App Store Connect with `eas submit` inside the job (the key goes into the runner's `eas.json` for that run only and is deleted after), and `scripts/asc-build-check.mjs` proves the build number arrived. The .ipa is never kept as an artifact (public repo). Never submit for review from here.
- **Android build for Google Play (internal track, draft):** run `.github/workflows/android-store-build.yml` on `main` (free GitHub Linux runner, `eas build --local`; needs the `EXPO_TOKEN` and `GOOGLE_PLAY_UPLOAD_SA_JSON` repo secrets = the vault entries of the same names). It signs with the EAS upload keystore (SHA-1 `94:24:23:C9:…:98:06`, checked before upload), refuses a build without the `goog_` RevenueCat key (`apps/mobile/scripts/store-build-gate.mjs`, the `eas-build-pre-install` hook), uploads with `eas submit` to the internal track as a draft, then `scripts/play-internal-check.mjs` proves this versionCode is a draft on internal and on no other track (production, open, closed incl. custom tracks). The `.aab` is never kept as an artifact. Promoting past internal is done in Play Console after a fresh review, never from here.
- **Sideload Android APK:** build from a fresh `main` with `APM_KEYSTORE_DIR=~/.config/aplayermode/secrets JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk scripts/build-android-apk.sh` (versionCode = commit count, versionName carries the SHA), upload `dist-android/aplayermode.apk` to a new GitHub release `android-beta-YYYY-MM-DD`, then point `aplayermode/config.js` → `beta.androidApk` in seq23/sprylabs-hpc-site at it and check the live URL's sha256.

## Named stops

### Stripe account for A Player Mode (owner)

Card payments for the web app and the sideload APK (docs/33 §9) are built and deployed; until these steps are done the app shows "Card payments open shortly." Everything below is dashboard wiring; no code change except pasting two links.

**Status (7 Oct 2026): steps 1–8 DONE in Stripe TEST mode** — Stripe account `acct_1UO7wiLaZ1UPI1NL` ("Spry / A Player Mode"); Web Billing app `app3a2bcfb2d0`; web products `prod55a7776fc5` (cos_monthly, $9.99 × 3 then $24.99), `prodd268ac7476` (founding $9.99), `prod5b26143a3c` ($249.99/yr), `prodc87e7e553f` ($39.99), `prod67b0cd398b` ($399.99/yr), `prod707eaae618` ($79.99), `prode5f37c9120` ($799.99/yr); Web Purchase Links `rcbchkconfef90a511080143aabace516c0f041bb9` (default) and `rcbchkconfe0930de8db45470bb056bc85b6c30062` (founding), production URLs committed in `apps/mobile/web-billing.json` (the `/sandbox/` twins are for testers only and are never committed — `apps/mobile/test/web-billing.test.mjs`). **Live mode is the owner's one step:** finish Stripe account activation; the links then take real cards with no code change. RevenueCat Web Billing products cannot be created through the public v2 API ("Web Billing product creation is still not supported"), so they were made in the dashboard.

1. **Create or choose a Spry Stripe account — NOT West Peek.**
2. **RevenueCat → project "A player Mode" (`proj2c0586cf`) → Apps → + New → Web Billing**, connect that Stripe account. Default currency USD.
3. **Create the web products with exactly these identifiers** (same prices as the store products; docs/33 §9):
   - `apm_web_cos_monthly` — monthly, with the 3-month introductory price
   - `apm_web_cos_monthly_founding` — monthly, Founding 100 price
   - `apm_web_cos_annual` — annual
   - `apm_web_lifeos_monthly` — monthly
   - `apm_web_lifeos_annual` — annual
   - `apm_web_autopilot_monthly` — monthly
   - `apm_web_autopilot_annual` — annual
4. **Attach them to the entitlements** `chief_of_staff` (the three `apm_web_cos_*`), `life_os` (`apm_web_lifeos_*`), `autopilot` (`apm_web_autopilot_*`).
5. **Add them to the offerings' packages:** offering `default` → packages `cos_monthly` = `apm_web_cos_monthly`, `cos_annual`, `lifeos_monthly`, `lifeos_annual`, `autopilot_monthly`, `autopilot_annual` = the matching ids; offering `founding` → the same, except `cos_monthly` = `apm_web_cos_monthly_founding`.
6. **Web Purchase Links:** create one for offering `default` and one for offering `founding`. Success behaviour: **redirect to `https://app.aplayermode.com/billing/return`**.
7. **Paste the two links** (`https://pay.rev.cat/<token>`) into `apps/mobile/web-billing.json` → `EXPO_PUBLIC_RC_WEB_PURCHASE_URL` (default) and `EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING` (founding); commit, then run `scripts/deploy-web-production.sh` and rebuild the APK.
8. **Customer portal key:** RevenueCat → API keys → new **v2 secret key** with *Customer information: read only*; save it as `~/.config/aplayermode/secrets/REVENUECAT_API_V2_KEY` (0600) and run `scripts/deploy-api-production.sh --secrets-dir ~/.config/aplayermode/secrets`.
9. **Test with a test card in production:** put your APM user id in `~/.config/aplayermode/secrets/BILLING_SANDBOX_TESTER_IDS` (comma-separated UUIDs), redeploy the API as in step 8, buy with a RevenueCat sandbox / Stripe test card, confirm the plan turns on; then delete the file's ids (or leave only testers) and redeploy.

The webhook needs no change: the existing RevenueCat webhook already points at `/v1/billing/revenuecat/webhook` and covers every app in the project.
