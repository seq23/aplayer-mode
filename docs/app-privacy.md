# App Store privacy label (App Privacy): what we declared and why

Published in App Store Connect on 16 Nov 2026 (app 6834891654). Every answer comes from the code on `main` at that date. The label is a legal statement to Apple, so when the app starts collecting something new, or stops, update this file and the label together.

Privacy policy URL on the label: `https://aplayermode.com/privacy` (301 to `https://app.aplayermode.com/privacy`).

## Declared: Data Linked to You (none of it is used for tracking)

| Apple data type | Purpose | Where it comes from in the code |
|---|---|---|
| Name | App Functionality | `saveDisplayName` → `PUT /v1/profile/name` (`apps/mobile/src/api/apmApi.ts`) |
| Email Address | App Functionality | Supabase sign-in (one-time code, Apple, Google) in `apps/mobile/src/state/session.tsx`; renewal reminders `services/api/src/renewalReminders.ts` |
| Health | App Functionality | Body questions after the separate health consent (`apps/mobile/src/content/consent.ts`, `/v1/consents/health-data`, `/v1/body/clearance`): weight, conditions, clinician clearance, energy score |
| Fitness | App Functionality | Body questions: movement habits and days |
| Sensitive Info | App Functionality | The health questions ask whether pregnancy applies (Apple lists pregnancy under Sensitive Info) |
| Emails or Text Messages | App Functionality | Gmail and Outlook connections: `/v1/connections/oauth/*`, `/v1/email/connections/:id/sync` (`app/settings/privacy/connections.tsx`) |
| Other User Content | App Functionality | Intake answers, goals, diary, check-ins, coaching chats, weekly reviews, life-OS items and relationships, plus phone calendar events (`/v1/calendar/device/sync`) |
| User ID | App Functionality | The Supabase account id, also used as the RevenueCat `appUserID` (`apps/mobile/src/billing/purchases.ts`) |
| Purchase History | App Functionality, Analytics | RevenueCat (`react-native-purchases`), `/v1/billing/*` |
| Product Interaction | Analytics, App Functionality | `trackEvent` → `POST /v1/analytics/event`, sent with the account token (`apps/mobile/src/intake/store.tsx`) |

## Not declared, and why

- **No third-party analytics, ads, crash or session SDK.** The app's dependencies (`apps/mobile/package.json`) include no Sentry, PostHog, Firebase, Amplitude, Segment or Clarity. So there is no Crash Data, Performance Data or Advertising Data.
- **No location.** The app reads no GPS or IP location. An event's location text is part of calendar content (Other User Content).
- **Contacts:** the app does not read the address book. People the user types in as "relationships" count as Other User Content.
- **Push token, time zone, app version:** Apple has no data type for these.
- **Tracking:** none. There is no IDFA, no ad network and no data broker.

## The policy does not match the code (fix the policy or the code)

- **Phone calendar.** Version 1.0 reads every calendar on the phone and uploads event title, location, start and end, time zone, recurrence, organizer name and calendar name to `POST /v1/calendar/device/sync`. From 1.0.1 (issue #82) the person ticks which calendars sync (`apps/mobile/src/integrations/deviceCalendar.ts`, choice kept on the phone), calendar names stay on the phone, and `POST /v1/calendar/device/clear` removes stored phone events (all, or all but the ticked calendars). The Privacy Policy states both versions; `apps/mobile/test/go-live.test.mjs` fails if the policy, the iOS prompt and the code disagree. The label declares this as Other User Content either way.
- **Name.** The policy's account section lists only email and sign-in identifiers. The app also saves a display name (`/v1/profile/name`).
