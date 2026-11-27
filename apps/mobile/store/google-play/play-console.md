# Google Play: App content answers (draft, 19 Nov 2026)

Nothing here is sent to Google. Paste these into Play Console > Policy > App content under the company account
(Redwood Reserve Holdings LLC). Every answer is read from the code on `main`; paths are under `apps/mobile/`
unless they start with `services/` or `packages/`. The Apple label for the same data is `docs/app-privacy.md`:
when the app starts or stops collecting something, change both. Listing copy and URLs: `../google-play.json`.

## Permissions in the Android build

- Blocked in `app.json` (`android.blockedPermissions`): SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE,
  USE_BIOMETRIC, USE_FINGERPRINT. All five were in the 19 Nov 2026 AAB; nothing in the app uses an overlay,
  shared storage or a fingerprint prompt. `test/store-listing.test.mjs` fails if one comes back.
- **WRITE_CALENDAR stays, and why.** The app only reads the calendars the person ticks
  (`src/integrations/deviceCalendar.ts:46,48,93,95`; no create/update/delete call anywhere). But expo-calendar's
  Android `requestCalendarPermissionsAsync` asks for READ_CALENDAR and WRITE_CALENDAR together, and
  `getCalendarsAsync` / `getEventsAsync` throw `E_MISSING_PERMISSIONS` unless both are granted
  (`node_modules/expo-calendar/android/.../CalendarModule.kt:210,235`). Blocking WRITE would make the request
  come back denied and the phone-calendar feature would stop working. Calendar is not a Play restricted
  permission, so no extra declaration form is needed.
- Final manifest of the proving build: see "Final manifest" at the end.

## Data safety

- **Collects or shares required user data?** Yes.
- **All user data encrypted in transit?** Yes. The API is `https://api.aplayermode.com` (`eas.json:16,29`), auth is
  Supabase over HTTPS, purchases RevenueCat over HTTPS; external links are https-only (`src/links/external.ts:13`).
- **Way to request deletion?** Yes. In the app: Settings > Privacy > Export & Delete > "Delete my account" >
  "Delete everything" (`app/settings/privacy/export-delete.tsx:74-79`, `POST /v1/privacy/delete`,
  `src/api/apmApi.ts:548`). Web: `https://app.aplayermode.com/delete-account` (also the Account deletion URL).
- **Account creation:** Yes (email code, Sign in with Google, Sign in with Apple; `src/state/session.tsx:225,282,318`).
- **Shared with third parties:** No. OpenRouter and the AI model providers it routes to, Supabase, RevenueCat and
  Expo's push service process data for us as service providers, which Google does not count as sharing. Email the
  person sends from a connected Outlook account is a transfer she starts, also not sharing.

| Play data type | Collected | Shared | Required? | Purpose | Code |
|---|---|---|---|---|---|
| Personal info > Name | Yes | No | Optional | App functionality | `saveDisplayName` → `PUT /v1/profile/name` (`src/api/apmApi.ts:304-305`) |
| Personal info > Email address | Yes | No | Required | App functionality, Account management | Sign-in (`src/state/session.tsx:225`); renewal reminders `services/api/src/renewalReminders.ts` |
| Personal info > User IDs | Yes | No | Required | App functionality, Account management | Supabase account id, also the RevenueCat `appUserID` (`src/billing/purchases.ts:60-62`) |
| Financial info > Purchase history | Yes | No | Required (a plan is needed for the daily loop) | App functionality, Analytics | RevenueCat (`src/billing/purchases.ts:60`), `/v1/billing/*` |
| Health and fitness > Health info | Yes | No | Optional (separate consent) | App functionality | Body questions after the health consent (`src/content/consent.ts:18-30`, `POST /v1/consents/health-data`, `src/api/apmApi.ts:464`): weight, conditions incl. pregnancy, clinician clearance, energy score |
| Health and fitness > Fitness info | Yes | No | Optional | App functionality | Body questions: movement habits and days (same consent) |
| Messages > Emails | Yes | No | Optional (only if connected) | App functionality | Outlook connection (Microsoft only; Google connects calendar only) (`src/api/apmApi.ts:485-507`, `app/settings/privacy/connections.tsx`) |
| Calendar > Calendar events | Yes | No | Optional (only ticked calendars) | App functionality | `POST /v1/calendar/device/sync` (`src/api/apmApi.ts:510`, `src/integrations/deviceCalendar.ts:95`), plus Google/Microsoft calendars when connected |
| App activity > Other user-generated content | Yes | No | Required | App functionality | Intake answers, goals, diary, check-ins, coaching chats (`sendCoachMessage`, `src/api/apmApi.ts:471`), weekly reviews, people she types in as relationships |
| App activity > App interactions | Yes | No | Required | Analytics | `trackEvent` → `POST /v1/analytics/event` (`src/api/apmApi.ts:376`, `src/intake/store.tsx:107`) |
| Device or other IDs | Yes | No | Optional (only if notifications are on) | App functionality | Expo push token → `POST /v1/push/register` (`src/integrations/push.ts:50`, `src/api/apmApi.ts:528`) |

Not declared, and why: no location (none read; an event's location text is calendar content); no contacts (the
address book is never read); no photos, files or audio; no crash, performance or advertising data (no Sentry,
Firebase, ad or analytics SDK in `package.json`).

## Content rating (IARC questionnaire)

- Category: **All other app types** (productivity).
- Violence, fear, sexuality, nudity, profanity or crude humour, drugs, alcohol, tobacco, gambling: **No** to every question.
- Users interact or exchange content with each other: **No**. The coach is an AI; there is no chat between people.
- Shares the user's current physical location: **No**.
- Allows users to purchase digital goods: **Yes** (subscriptions through Google Play Billing).
- Unrestricted internet access: **No** (system browser for https links only, `src/links/external.ts:11-13`).
- If the questionnaire asks about AI-generated content: **Yes**, coaching replies and plan text (see AI section).
- Expected result: Everyone / PEGI 3 with "In-App Purchases"; the 18+ audience is set under Target audience.

## Target audience and content

- **Target age: 18 and over only.** The app asks "Are you 18 or older?" before anything else and refuses an account under 18
  (`app/age.tsx`, `src/content/consent.ts:5-16`).
- **Could appeal to children unintentionally?** No.

## Ads

- **Contains ads?** No. No ad SDK in `package.json`; no ad network, no advertising id (`docs/app-privacy.md`, "Not declared").

## App access (notes for the reviewer)

- **Some functionality is restricted** (sign-in). User name, password (the review code, from the vault by name only)
  and the note to paste are in `../app-review-notes.md` → "Google Play → App access": one source for both stores.
- How it works: `services/api/src/reviewLogin.ts` (one address, constant-time compare, wrong codes counted per device
  and per day, audited, off unless both values are set and before `APP_REVIEW_UNTIL`); full access from
  `services/api/migrations/0070_app_review_beta.sql` and `0105_review_account_suite.sql` (Autopilot for review, sample
  Life-areas items).

## Financial features

- **No financial features.** Subscriptions are bought through Google Play Billing; Autopilot never spends money.
  Never tick banking, loans, payments, crypto, insurance, financial advice or budgeting.

## Health apps declaration

- **Yes, health features:** tick **Activity and fitness** and **Nutrition and weight management** (Body steps, movement days,
  weight and weigh-in rhythm, optional weight-loss goal; `src/content/consent.ts:22-25`).
- Not a medical device, no diagnosis or treatment, no Health Connect. In-app and listing disclaimer: "does not provide
  medical, psychological, legal, financial or therapeutic advice" (`../google-play.json` fullDescription).
- Consumer health privacy notice: `https://app.aplayermode.com/privacy/consumer-health/`
  (`public/privacy/consumer-health/index.html`).

## Other declarations

- **Government apps:** No. **News apps:** No.
- **AI-generated content: Yes.** Coaching replies, plans and drafts are written by AI models through OpenRouter
  (`packages/ai/src/index.ts:224`). Google's in-app reporting requirement is met: every coach reply has
  "Report this" (`app/(tabs)/apm.tsx:165-174`) with reasons harmful / wrong / inappropriate / other, stored server-side
  with an audit row (`POST /v1/apm/coach/report`, `services/api/src/index.ts:1423`), on Android and iOS alike.
  Distress in a chat stops coaching and shows crisis resources (`app/(tabs)/apm.tsx:133,185-192`).
  Plans and drafts are suggestions the person edits or approves before anything happens.
- **Account deletion:** Yes, users can create an account. URL `https://app.aplayermode.com/delete-account`;
  in-app Settings > Privacy > Export & Delete.
- **Privacy policy:** `https://app.aplayermode.com/privacy`.

## Final manifest

EAS preview build a91e99f0-abd9-48ee-9dc4-bd2b00907efd (free plan, 19 Nov 2026, this branch) requests:
INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, RECEIVE_BOOT_COMPLETED, VIBRATE, WAKE_LOCK, READ_APP_BADGE,
READ_CALENDAR, WRITE_CALENDAR. (BIND_JOB_SERVICE and DUMP appear only as protections on library services and
receivers, not as requested permissions.) SYSTEM_ALERT_WINDOW, external storage and biometrics are gone.
