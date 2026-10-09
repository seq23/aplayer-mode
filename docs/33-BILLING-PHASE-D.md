# A Player Mode — Phase D: In-App Subscription Billing (RevenueCat)

**Status:** `SOURCE_COMPLETE` + `DB_PROVISIONED` (migrations 0040–0042, applied to Supabase; security advisor 0 lints). Store products, the RevenueCat project and the secrets below are **Phase E** — nothing is runtime-proven and no store transaction is live.
**Decisions:** owner, 7 Oct 2026 (final). Prices: ADR-0004 (monthly), ADR-0005 (annual).
**Code:** `packages/policy/src/index.ts` (`PLAN_PRICES`, `CHIEF_OF_STAFF_INTRO_OFFERS`, `BILLING_PRODUCTS`, `REVENUECAT_CONFIG`), `services/api/src/billing.ts`, `services/api/migrations/0040_billing_revenuecat.sql` + `0041_billing_explicit_deny_all.sql` + `0042_billing_founding_claim_eligibility.sql`, `apps/mobile/app/settings/plan.tsx`, `apps/mobile/src/billing/`. **Web channel (§9):** `WEB_BILLING_CONFIG`, migration `0092_billing_web_channel.sql`, `apps/mobile/src/billing/{distribution,webCheckout,webCheckout.ios}.ts`, `apps/mobile/web-billing.json`.

## 1. What was decided

- **Provider:** RevenueCat over App Store and Google Play in-app subscriptions (`react-native-purchases` in the Expo app; needs a development/EAS build — Expo Go cannot load it).
- **Prices** (cumulative tiers; annual = 2 months free; no free trial):

| Tier | Monthly | Annual | Includes |
|---|---:|---:|---|
| Executive Roundtable | $24.99 | $249.99 | — |
| Executive Suite | $39.99 | $399.99 | everything in Executive Roundtable |
| Autopilot | $79.99 | $799.99 | everything in Executive Suite |

- **Executive Roundtable monthly intro offers** (none on annual, none on Executive Suite / Autopilot):
  - **Founding 100:** the first 100 subscribers pay $9.99/mo, locked while continuously subscribed. A separate store product, shown only while the server holds a Founding 100 slot for that user. A lapse loses the lock for good.
  - **Everyone else:** $9.99/mo for the first 3 months, then $24.99/mo — the store's introductory offer on the standard Executive Roundtable monthly product.
- **RevenueCat app user id = Supabase user id.** The app logs RevenueCat in with the signed-in user's id; anonymous RevenueCat ids are never credited.
- **Buying a tier never grants autonomy.** Effective authority = min(entitlement, user permission, server policy, kill switch). The billing code never writes `public.permissions`.

## 2. Store product IDs (exact)

One App Store subscription group, **"A Player Mode"**, holds all seven App Store products (so a change between any two is an upgrade / downgrade / crossgrade Apple prorates). On Google Play each tier is one subscription with base plans; RevenueCat reports Play products as `<subscription id>:<base plan id>`.

| Tier | Period | Offer | App Store product id | Google Play `subscription:base plan` | Price |
|---|---|---|---|---|---:|
| Executive Roundtable | monthly | standard + 3-month intro | `apm_cos_monthly` | `apm_cos:monthly` (offer `intro-3m`) | $24.99/mo (intro $9.99 × 3) |
| Executive Roundtable | monthly | **Founding 100** | `apm_cos_monthly_founding` | `apm_cos:founding-monthly` | $9.99/mo |
| Executive Roundtable | annual | standard | `apm_cos_annual` | `apm_cos:annual` | $249.99/yr |
| Executive Suite | monthly | standard | `apm_lifeos_monthly` | `apm_lifeos:monthly` | $39.99/mo |
| Executive Suite | annual | standard | `apm_lifeos_annual` | `apm_lifeos:annual` | $399.99/yr |
| Autopilot | monthly | standard | `apm_autopilot_monthly` | `apm_autopilot:monthly` | $79.99/mo |
| Autopilot | annual | standard | `apm_autopilot_annual` | `apm_autopilot:annual` | $799.99/yr |

`BILLING_PRODUCTS` is the source of truth; `private.billing_products` (migration 0040) seeds the same 14 rows and `services/api/test/billing-db.test.mjs` fails if they diverge. **A product id not in this table never grants anything** (the event is recorded `ignored_unknown_product`).

## 3. Phase E setup checklist (do not do in Phase D)

### App Store Connect
1. Paid Applications agreement, banking and tax complete.
2. Subscription group **A Player Mode**; add the seven products above with the prices above (USD base; let Apple derive other storefronts).
3. Group levels (highest first): Autopilot annual, Autopilot monthly, Executive Suite annual, Executive Suite monthly, Executive Roundtable annual, Executive Roundtable monthly, Executive Roundtable monthly founding.
4. `apm_cos_monthly` introductory offer: **Pay as you go, $9.99, 3 periods of 1 month**, new subscribers. No free trial anywhere.
5. Billing Grace Period: **on (16 days)** — the server keeps access through grace (BILLING_ISSUE handling below).
6. App Store Server Notifications V2 → the RevenueCat-provided URL; in-app purchase key (`.p8`) uploaded to RevenueCat.
7. Each product's review screenshot + description; the app's EULA link and privacy policy URL set in App Information.

### Google Play Console
1. Merchant account; subscriptions `apm_cos`, `apm_lifeos`, `apm_autopilot`.
2. Base plans: `monthly` (auto-renewing, 1 month) and `annual` (1 year) on each; `founding-monthly` ($9.99, 1 month) on `apm_cos`.
3. `apm_cos:monthly` offer `intro-3m`: one phase, 3 × 1 month at $9.99, eligibility **new customer acquisition**. No free trial.
4. Grace period 7 days (plus account hold); Real-time developer notifications (Pub/Sub topic) and service-account credentials connected to RevenueCat.

### RevenueCat
1. Project **A Player Mode**; apps for iOS (`com.aplayermode.app`) and Android (`com.aplayermode.app`).
2. Products: import all 14 ids above.
3. Entitlements: `chief_of_staff` (all Executive Roundtable products), `life_os` (Executive Suite products), `autopilot` (Autopilot products). Informational only — the server maps product ids itself.
4. Offerings (package ids are `REVENUECAT_CONFIG.packages`):
   - `default` (current): `cos_monthly` → `apm_cos_monthly` / `apm_cos:monthly`; `cos_annual`; `lifeos_monthly`; `lifeos_annual`; `autopilot_monthly`; `autopilot_annual`.
   - `founding`: identical, except `cos_monthly` → `apm_cos_monthly_founding` / `apm_cos:founding-monthly`.
5. **Restore behaviour: "Keep with original App User ID"** (transfers disabled). TRANSFER events are recorded and ignored by the server; transfers must not move a paid entitlement between APM accounts.
6. Webhook: URL `https://<api host>/v1/billing/revenuecat/webhook` (production: `https://api.aplayermode.com/v1/billing/revenuecat/webhook`); Authorization header = the value of `REVENUECAT_WEBHOOK_SECRET`; environment filter: production for the production Worker, sandbox+production for staging; all event types.
7. Public SDK keys → `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` (`appl_…`), `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` (`goog_…`) in the EAS build environment.

### Secrets / config (placeholders until Phase E)

| Name | Where | Purpose |
|---|---|---|
| `REVENUECAT_WEBHOOK_SECRET` | Cloudflare Worker secret (staging and production, different values) | Webhook Authorization; ≥ 32 random characters. Absent → 503 `billing_webhook_not_configured`. |
| `BILLING_ALLOW_SANDBOX` | Worker var, staging only | `true` accepts SANDBOX events. |
| `SUPABASE_SECRET_KEY` | Worker secret (exists) | The webhook, offering and sweep call service-role functions. |
| `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` | EAS env | Public RevenueCat Apple key. |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` | EAS env | Public RevenueCat Google key. |
| `EXPO_PUBLIC_TERMS_URL` | EAS env | Terms of use shown on the paywall (iOS falls back to Apple's standard EULA). |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | EAS env | Privacy policy on the paywall. Purchases stay disabled until it is set. |

## 4. Trust model and data flow

```mermaid
sequenceDiagram
  participant App
  participant API as APM Worker
  participant DB as Supabase (0040)
  participant RC as RevenueCat
  participant Store as App Store / Play
  App->>API: GET /v1/billing/offering (user JWT)
  API->>DB: apm_service_billing_offering(user id from JWT) [service role]
  DB-->>API: default | founding (slot reserved 60 min)
  App->>RC: purchase package from that offering (appUserID = Supabase id)
  RC->>Store: verify receipt
  RC->>API: POST /v1/billing/revenuecat/webhook (Authorization secret)
  API->>API: constant-time secret check, allow-list fields
  API->>DB: apm_service_billing_apply_event(event) [service role]
  DB->>DB: dedupe event id, drop stale, map product, Founding 100, audit
  App->>API: GET /v1/product/plan (reads the entitlement row)
```

- **The entitlement row is the only truth.** `public.subscription_entitlements` is not writable by `anon` or `authenticated` (0040 revokes writes); the only writer is `private.apm_billing_apply_event`, `SECURITY DEFINER`, `search_path = ''`, executable by `service_role` only through a `SECURITY INVOKER` wrapper in `public`. There is no API route that accepts a client-reported purchase; after buying, the app re-reads `/v1/product/plan`. **Reconcile (8 Oct 2026):** `POST /v1/billing/reconcile` (session user only, empty body, 6/min per user) reads that user's subscriptions from RevenueCat API v2 (`REVENUECAT_API_V2_KEY`) and feeds them to the SAME writer with the SAME sandbox rule (`applyBillingEvent` in `services/api/src/billing.ts`), so a missed or filtered webhook never strands a paying customer; it only ever grants what RevenueCat says is paid now. `/billing/return`, the card-checkout return and "I already paid" call it.
- **Webhook authentication:** `Authorization` must equal `REVENUECAT_WEBHOOK_SECRET` (raw or `Bearer …`), compared as SHA-256 digests with a non-short-circuiting loop, before the body is read. Bodies over 64 KB are refused. Only allow-listed fields (`id, type, app_user_id, product_id, new_product_id, store, environment, event_timestamp_ms, expiration_at_ms, cancel_reason, period_type`) reach the database; subscriber attributes, prices, aliases and RevenueCat's own entitlement ids are dropped.
- **Idempotency:** `private.billing_events.event_id` is the primary key. A replay returns the first outcome and changes nothing; concurrent duplicates apply once.
- **Ordering:** an event older than the last applied event for that user is recorded `stale` and changes nothing.
- **Identity:** `app_user_id` must be a UUID of an existing `auth.users` row; anything else (including `$RCAnonymousID:…`) is `ignored_unknown_user`.
- **Store / environment:** only `APP_STORE` and `PLAY_STORE`, and the product must belong to that store; SANDBOX only where `BILLING_ALLOW_SANDBOX=true`. Promotional / Stripe / Amazon grants are ignored.
- **Responses:** 200 once the event is durably recorded (applied, replayed, or ignored with a reason); 400 malformed; 401 bad secret; 413 too large; 503 not configured; 500 on a database failure so RevenueCat retries.

## 5. Event handling

| RevenueCat event | Entitlement effect |
|---|---|
| `INITIAL_PURCHASE`, `RENEWAL`, `UNCANCELLATION`, `SUBSCRIPTION_EXTENDED`, `REFUND_REVERSED` | plan = the product's tier, `active` until `expiration_at` (or `expired` if that is already past); store, product, period and offer recorded; billing issue cleared. A RENEWAL with a new product applies a pending downgrade. |
| `PRODUCT_CHANGE` | **Upgrade** (higher tier): applies immediately (the store prorates). **Downgrade / period change:** recorded as `pending_plan`; the paid-for tier stays until the RENEWAL that carries the new product. Unknown new product: ignored. |
| `CANCELLATION` (auto-renew off) | `cancel_at_period_end = true`; access continues to `current_period_end`. |
| `CANCELLATION` with `cancel_reason = CUSTOMER_SUPPORT`, or `REFUND` | Refund: `expired` now; a Founding 100 lock is lost. |
| `BILLING_ISSUE` | With store grace (`expiration_at` in the future): stays `active` through grace with `billing_issue_at` set (the app asks the user to update payment). Without grace: `past_due` — no access until a RENEWAL. |
| `EXPIRATION` | `expired`; a Founding 100 lock is lost. |
| `TEST`, `TRANSFER`, `NON_RENEWING_PURCHASE`, `SUBSCRIPTION_PAUSED`, others | Recorded, no change. |

Cancellation, billing issue, expiration, refund and product-change events about a product the user is no longer on (e.g. after a crossgrade) change nothing (`ignored_other_product`). Access checks (`apm_has_core_access`, `apm_has_life_os_access`, `apm_has_autopilot_access`, the Worker's plan gates) are unchanged: `status in ('active','trialing')` and the tier.

**Sweep (safety net):** the Worker cron (every 15 min) calls `apm_service_billing_expire_lapsed()`, which expires any store entitlement more than one day past `current_period_end` in case an EXPIRATION webhook never arrives. A later RENEWAL is newer than the last applied event and restores access.

## 6. Founding 100

- `private.billing_founding_slots` has slot numbers 1–100 as its primary key (a 101st slot cannot exist). Status `reserved` (offered, 60-minute hold), `claimed` (verified founding purchase), `lapsed` (lock lost). Claimed and lapsed slots stay consumed: "the first 100 subscribers".
- `GET /v1/billing/offering` → `apm_service_billing_offering(user)` takes one advisory lock and decides: an existing claim or live reservation → `founding`; a lapsed founder or anyone who has already held a store subscription → `default`; otherwise reserve a free slot (or reuse an expired reservation) → `founding`; none free → `default`. The app only ever *shows* the offering the server named.
- The founding purchase webhook turns the reservation into a claim. If the user has no slot, one is still free AND they have never held a store subscription (the same rule the offering applies; 0042), it claims one — so a tampered client that loads the `founding` offering itself cannot hand a former subscriber the lock. If none is free (e.g. a purchase made outside the app after the reservation lapsed), **access is honoured** — the store already charged — but the lock is not granted (`offer = standard`) and `billing.founding_without_slot` is audited for review.
- Moving off the founding product (upgrade, period change), expiry or refund lapses the lock; re-subscribing is at the then-current price.
- Known limit: Apple lets a lapsed subscriber resubscribe to an expired product from iOS Settings. That purchase is credited (they paid) but never restores the lock; it is audited.

## 7. App

- `apps/mobile/app/settings/plan.tsx` is the paywall/Plan screen: monthly/annual toggle, the three tiers with prices from the store (fallback to `PLAN_PRICES`), the server-chosen offering, restore purchases, a manage-subscription link (the store's subscription settings), and the store-required disclosure: auto-renewal terms, price and period, cancel-anytime, intro terms, and links to Terms of Use and the Privacy Policy.
- **Builds:** `react-native-purchases` is a native module (autolinked; no config plugin needed). `expo-dev-client` + the EAS `development` profile (`developmentClient: true`) give a dev build that can purchase in sandbox; the `preview` and `production` profiles include the module. Expo Go and web show "purchases unavailable".
- `react-native-purchases` is configured once the user is signed in, with `appUserID` = the Supabase user id; it is logged out on sign-out. Without the public SDK keys (or in Expo Go / web) the screen explains that purchases are unavailable in this build — it never fakes a plan.
- After a purchase or restore the app re-reads `/v1/product/plan` (polling briefly while the webhook lands). The SDK's own `customerInfo` is display-only.

## 8. What is not done (Phase E)

### 8.0 Phase E go-live, done 2026-10-07 (no owner account needed)

| Item | State | Where |
|---|---|---|
| API Worker live | **DONE**: `https://api.aplayermode.com/v1/health` 200, `runtimeEnvironment: production`, build SHA matches | `scripts/deploy-api-production.sh` (mirrors `deploy-cloudflare.yml`; never a bare `wrangler deploy`) |
| Worker secrets | **SET**: `OPENROUTER_API_KEY`, `CONNECTOR_CREDENTIAL_KEY`, `OAUTH_STATE_SECRET`, `REVENUECAT_WEBHOOK_SECRET`, `APP_REVIEW_CODE`; `BILLING_ALLOW_SANDBOX` unset (the script refuses it) | values only in the operator's 0600 secrets folder, never printed |
| `SUPABASE_SECRET_KEY` | **NAMED STOP**: the Management API token lacks `api_gateway_keys_write` (POST `/v1/projects/{ref}/api-keys` answered 403) | owner: Supabase → Project Settings → API Keys → *Create new secret key*, then `wrangler secret put SUPABASE_SECRET_KEY --env production` (in `services/api`) |
| Web app live, installable | **DONE**: `https://app.aplayermode.com` (manifest, icons, `display: standalone`; Add to Home Screen) | `scripts/deploy-web-production.sh`, `apps/mobile/wrangler.web.jsonc` (static assets, SPA fallback) |
| Terms / Privacy | **DONE**: `/terms`, `/privacy` (Spry Labs, last updated 2026-10-07); `EXPO_PUBLIC_TERMS_URL` / `EXPO_PUBLIC_PRIVACY_POLICY_URL` set in `eas.json` and the web build | `apps/mobile/public/{terms,privacy}/index.html`, pinned by `test/go-live.test.mjs` |
| Domain | api./app. subdomains added; the zone redirect rules now match `http.host` (apex and www only), and both still 301 to `billionairehighperformancecoach.com/download` (and `/amazon/<slug>` to its book page) | Cloudflare zone aplayermode.com → Rules → Redirect Rules |
| CORS | `ALLOWED_ORIGIN` = `APP_PUBLIC_URL` = `https://app.aplayermode.com` (preflight checked) | `services/api/wrangler.jsonc` `env.production.vars` |
| Web paywall | **Superseded by §9 (7 Oct 2026):** the web app and the sideload APK pay by card (RevenueCat Web Billing); "Card payments open shortly" until the Web Purchase Links are set; no Restore button on web | `src/billing/webCheckout.ts`, `PlanChoice.tsx` |
| docs/36 leftovers | **DONE**: A-1 spinners (`LoadingState`); A-5 AX5 clipping (tab label cap, Flow step number); B-1 the weekly debrief proposes one adjustment from the week's misses, prefilled | `test/dynamic-type.test.mjs`, `packages/planning` `suggestWeeklyAdjustment` |
| Reviewer account | **BUILT and configured** (`APP_REVIEW_EMAIL` var, `APP_REVIEW_CODE` secret; closed-beta access through migration 0070, applied); answers 404 until `SUPABASE_SECRET_KEY` is set (the stop above) | docs/35 |
| Android APK | signed release APK built on the Mac with an upload keystore (no Expo account) | `scripts/build-android-apk.sh` (JDK 17, Android SDK 37, NDK 27.1); first build: https://github.com/seq23/aplayer-mode/releases/download/android-beta-2026-10-07/aplayermode.apk |
| `presubmit:ios` | passes | `scripts/presubmit-ios.mjs` |
| Supabase security advisor | one WARN, not new: `auth_leaked_password_protection` (Auth config; APM has no passwords, sign-in is a code) | |

Still open after 8.0: the Supabase Auth settings below, the stores/RevenueCat setup, and the Android/iOS store builds.


**Named stops from the first-run build (docs/34 §14, 7 Oct 2026).** The Management API token used for migrations does not carry `auth_config_read` / `auth_config_write` (PATCH `/config/auth` answered 403), so these Supabase Auth settings are the owner's, in the dashboard (Authentication → Sign In / Providers, Emails, Rate limits, Attack protection):
- **Email code:** OTP length **6**, and the Magic Link / Confirm signup / Change email templates use `{{ .Token }}` (a code, not a link); custom SMTP (the built-in sender is rate-limited).
- **Anonymous sign-ins: on**, with **CAPTCHA (Turnstile)** and the per-IP anonymous rate limit; **manual identity linking: on**. Until then the app keeps the draft on the device only and asks for an account before install (no data is lost).
- **Sign in with Apple:** Services ID, key and team id in the Apple provider; the App ID's Sign in with Apple capability (EAS). **Google:** web + iOS + Android OAuth client ids in the Google provider; the redirect `aplayermode://auth/callback` in the allow-list.
- **App Review reviewer account: BUILT (docs/35, 7 Oct 2026); only the two values are left to set.** Sign-in is a 6-digit email code, which a reviewer cannot receive, so one reviewer address may sign in with a fixed code instead (`services/api/src/reviewLogin.ts`, `POST /v1/auth/review-login`, tested in `services/api/test/review-login-worker.test.mjs`):
  - **Off unless both are set** on the Worker: `APP_REVIEW_EMAIL` (var, e.g. `appreview@aplayermode.com`) and `APP_REVIEW_CODE` (secret, 6–12 digits). With either missing, a code that is not 6–12 digits, or no `SUPABASE_SECRET_KEY`, the route answers 404 to everyone and makes no network call.
  - **Only that one address.** Any other address gets the same 404 as "off" (no account enumeration); the fixed code never works for it. Both the address and the code are compared in constant time.
  - **No email involved.** In the app the reviewer types the address on "Email me a 6-digit code"; the server says it is the reviewer account, the app skips sending mail and shows the code box; the fixed code returns a session for that account (created on first use, `email_confirm: true`).
  - **Audited:** every review sign-in writes an `auth.review_login` audit row (user actor; on the Worker allow-list in migration 0066, pinned by `security-write-surface-db.test.mjs`).
  - **Set for review:** `wrangler secret put APP_REVIEW_CODE` and `APP_REVIEW_EMAIL` in `wrangler.jsonc` vars (production), then put the address and code in App Store Connect → App Review Information → Sign-in required, and in Play Console → App access. **Unset both after approval** and the path is gone.
- **Closed-beta builds** set `EXPO_PUBLIC_CLOSED_BETA=true` (shows "Start with the closed beta" on the plan choice); store builds never do.

- Creating the App Store / Play products, the RevenueCat project, offerings, entitlements and webhook (checklist §3).
- Setting `REVENUECAT_WEBHOOK_SECRET`, the public SDK keys and the terms / privacy URLs.
- A sandbox purchase receipt per store, the webhook receipt on staging, and a restore on a second device.


## 9. Web channel: card checkout for the web app and the sideload APK (RevenueCat Web Billing)

**Decision:** owner, 7 Oct 2026 ("stripe first for the apps"). There are no store listings yet, so people who use the web app (`app.aplayermode.com`) or the Android APK downloaded from aplayermode.com pay by card through **RevenueCat Web Billing** (Stripe underneath). Gumroad stays the BHPC digital product only. **Status:** `SOURCE_COMPLETE` + `DB_PROVISIONED` (migration 0092). The Stripe account is not chosen yet, so the dashboard wiring is the named stop in `RUNBOOK.md`; until it is done the app shows *"Card payments open shortly."* (never a dead button).

**Web product ids (exact; `WEB_BILLING_CONFIG.productIds`, same prices as the store twins in §2, pinned by `packages/policy/test/pricing.test.mjs`):**

| Tier | Period | Offer | Web Billing product id | RevenueCat package |
|---|---|---|---|---|
| Executive Roundtable | monthly | standard + 3-month intro | `apm_web_cos_monthly` | `cos_monthly` (offering `default`) |
| Executive Roundtable | monthly | Founding 100 | `apm_web_cos_monthly_founding` | `cos_monthly` (offering `founding`) |
| Executive Roundtable | annual | standard | `apm_web_cos_annual` | `cos_annual` |
| Executive Suite | monthly | standard | `apm_web_lifeos_monthly` | `lifeos_monthly` |
| Executive Suite | annual | standard | `apm_web_lifeos_annual` | `lifeos_annual` |
| Autopilot | monthly | standard | `apm_web_autopilot_monthly` | `autopilot_monthly` |
| Autopilot | annual | standard | `apm_web_autopilot_annual` | `autopilot_annual` |

**Server.** RevenueCat reports Web Billing purchases with webhook `store` = `RC_BILLING` (its Stripe Billing integration: `STRIPE`); migration 0092 maps both to the `web` channel (`private.billing_products.store`, `subscription_entitlements.provider`), seeds the seven rows and extends the expiry sweep. A product only matches its own channel (an `RC_BILLING` event naming an App Store id stays `ignored_unknown_product`). The webhook, its secret, idempotency, stale-event and Founding 100 rules are unchanged (§4–§6).

**Sandbox in production (tester allowlist).** Production still refuses SANDBOX events (`BILLING_ALLOW_SANDBOX` is refused by `scripts/deploy-api-production.sh`), except for the APM user ids listed in the Worker secret **`BILLING_SANDBOX_TESTER_IDS`** (comma-separated UUIDs; ids, never emails). Only a SANDBOX event whose `app_user_id` is on that list is honoured; every other sandbox event stays `ignored_environment` (`services/api/test/billing-worker.test.mjs`).

**Customer portal.** `GET /v1/billing/web/portal` returns the RevenueCat Billing `management_url` for the signed-in user only (RevenueCat API v2 `GET /projects/{REVENUECAT_PROJECT_ID}/customers/{user id}/subscriptions`, Worker secret **`REVENUECAT_API_V2_KEY`** with customer-information read, var `REVENUECAT_PROJECT_ID` = `proj2c0586cf`). Without the key the app says to use the *Manage subscription* link in any receipt email.

**App.** The build says where it may take payment: `EXPO_PUBLIC_APM_DISTRIBUTION` = `store` (every EAS profile, `apps/mobile/eas.json`), `sideload` (`scripts/build-android-apk.sh`, which also drops any Play billing key), `web` (`scripts/deploy-web-production.sh`). iOS is always `store` whatever the flag says, and a native build without the flag is `store` (fail closed). On `web` / `sideload` each plan card shows **Pay by card**, which opens the offering's Web Purchase Link as `<link>/<url-encoded APM user id>?package_id=<package>` (the user id is the same one `identifyBillingUser` uses and the webhook maps back). A Founding 100 user (server decision) gets only the founding offering's link. On return (the app/tab comes back to the foreground, or RevenueCat redirects to `https://app.aplayermode.com/billing/return`) the app polls `/v1/product/plan` briefly and starts Day 1 when the plan is on. An active card subscriber changes plan in the customer portal, never through a second checkout. Links come from `apps/mobile/web-billing.json` (`EXPO_PUBLIC_RC_WEB_PURCHASE_URL`, `EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING`; only `https://pay.rev.cat/<token>` accepted).

**Store builds never reach web checkout (App Store 3.1.1, Play payments policy).** iOS resolves `./webCheckout` to `webCheckout.ios.ts`, a stub with no link, package or copy; an Android store build gets `unavailable` from the distribution check; a web subscriber opening a store build is told the plan is managed where it was bought, with no link. Enforced by `npm run presubmit:ios` (stub present and clean, link config read only in `webCheckout.ts`, extension-less imports, every EAS profile `store`) and `apps/mobile/test/web-billing.test.mjs` (distribution matrix; the iOS bundle of the paywall contains none of the web checkout while the web bundle does; each presubmit rule proven red).

## 10. Pay first, account after: "Join the Founding 100" (web app)

Owner's ask (8 Oct 2026): a primary "Join the Founding 100 — $9.99/month" button on aplayermode.com and on the welcome page goes straight to the Founding 100 card checkout, BEFORE the setup questions; the account and the questions come after payment.

- **Entry:** `https://app.aplayermode.com/join` (`apps/mobile/app/join.tsx`). Web app only (`payFirstAllowed`): the sideload APK keeps the in-app paywall (its checkout opens in another browser that cannot read the web app's storage) and a store build never reaches a web checkout. 18+ is confirmed first (one tap, `/age?next=join`).
- **Not signed in:** the browser mints a random v4 UUID, the *checkout id*, stores it (`localStorage` `apm.precheckout.v1`) and opens the **founding** Web Purchase Link with it as the RevenueCat app user id and `package_id=cos_monthly`. Signed in: the server's offering and the account id, exactly as the paywall does.
- **Linking:** RevenueCat returns the buyer to `/billing/return`. With no session and a stored checkout id, the buyer types the email used at checkout; `POST /v1/billing/precheckout/claim` (no session; rate-limited per checkout id) checks that RevenueCat shows a subscription paid for now under that id (reconcile's filter and sandbox rule), that the email equals RevenueCat's `$email` for that customer, and that no account uses that id; it then creates the Supabase account **with id = checkout id** and applies the payment through `apm_service_billing_apply_event`. The buyer types the 6-digit code and lands on the health-data choice, then the setup questions; the paywall at the end is skipped because the plan is already on. The RevenueCat app user id therefore *is* the account id: the webhook, reconcile, the customer portal and the Founding 100 slot need no mapping table. The first webhook (before the account existed) is recorded as `ignored_unknown_user`; the claim reconciles it.
- **Refusals:** not paid (409 `not_paid`), another email (409 `email_mismatch`), id already used by another email (409 `already_claimed`), a checkout already attached to an existing account (409 `already_claimed`), RevenueCat or auth down (502). A retry after a lost code email is idempotent.
- **The email already has an account (migration 0096, 9 Oct 2026; replaces the old `email_has_account` refusal and its manual support step):** the claim answers `{claimed: true, existingAccount: true}` and grants NOTHING. The buyer types the 6-digit code, which signs them into that existing account, and the signed-in page calls `POST /v1/billing/precheckout/attach {checkoutId}`. The server re-checks that the checkout is paid for now (same filter and sandbox rule) and that RevenueCat's `$email` equals the session's verified email, then writes `private.billing_checkout_links` (checkout id → account, once, never re-pointed; the database re-checks the email and refuses a checkout id that is itself an account) and applies the events through the one writer. `apm_billing_apply_event` resolves `app_user_id` through the link first, so later webhooks (renewal, cancellation, expiry), reconcile and the customer portal all follow it. **Why a link, not a RevenueCat transfer/alias:** restore behaviour is "Keep with original App User ID" (transfers disabled, §5), TRANSFER events are ignored by design, and the Worker's RevenueCat key is read-only; the link keeps RevenueCat untouched and the database the single owner of who gets what.
- **Return page:** the checkout id comes from RevenueCat's return URL (`?app_user_id=`) when it is a valid UUID, else from this browser's storage; a claim reading `not_paid` (RevenueCat still recording the purchase) is re-asked quietly at 5, 10, 20, 35 and 55 s ("Confirming your payment…"), within the 6-a-minute per-checkout limit.
- **Guards:** `services/api/test/billing-precheckout.test.mjs`, `apps/mobile/test/pay-first.test.mjs`.
