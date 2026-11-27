# App Review: Sign-In Information and notes (App Store Connect and Google Play)

The one source for what the store reviewer is told. Paste it into App Store Connect → the version → App Review Information, and into Play Console → App content → App access. Nothing here is sent from the repo. `test/store-listing.test.mjs` checks the notes fit Apple's 4,000-character limit, and that every button or label they quote is in the app or in the review account's sample data.

## Sign-In Information

- **User name:** `appreview@aplayermode.com` (`APP_REVIEW_EMAIL` in `services/api/wrangler.jsonc`).
- **Password:** the review code, read from the Boss OS vault entry `APP_REVIEW_CODE` (the same value as the Worker secret of that name). It is never written in this repo. RUNBOOK "Store review sign-in" covers setting it, its end date (`APP_REVIEW_UNTIL`) and removing it after the review.
- **The code box:** 1.0.1 builds up to build 11 take 6 digits only. From the next build the box takes 6 digits, or 12 to 24 letters and digits (`REVIEW_CODE_PATTERN`, #108). A long code works only once a build with the wider box is the one in review.

## Notes (App Store Connect → Notes; at most 4,000 characters)

```text
1. SCREEN RECORDING
Available on request.

2. PURPOSE AND AUDIENCE
A Player Mode (APM) is a daily planning and coaching app for busy adults (18+): founders, parents, operators, athletes. APM asks a few setup questions, then writes each day's plan (check-in, first hour, one priority), tracks goals with a 90-day plan, and offers an AI coach.

3. HOW TO USE IT (demo account in Sign-In Information)
- Sign-in: tap "I already have an account", then "Email me a 6-digit code". Type the demo email from Sign-In Information and tap "Email me a 6-digit code" again. No email is sent: the app shows "Your review code". Type the Password from Sign-In Information in the Review code box exactly as written and tap "Verify and continue".
- Tap "I'm 18 or older", then "I agree" for health information (it turns on the morning score used below; "Not now" also works).
- Answer the setup questions, then tap "Start my plan". The review account holds Autopilot (all three plans) for review, so no purchase is needed.
- Tabs: Today ("Show my plan for today", then "Mark done"), Radar ("Why APM saw this"), Goals ("Add goal and build its plan"), Coach ("Start coaching").
- Executive Suite and Autopilot (no Google or Microsoft account needed): Settings > Life areas has three items marked "(sample)".
  1. Settings > Privacy & AI > Permissions & Autonomy > "Goal checklists and task moves": tap "Increase to" until it shows "3 · Prepare". APM never grants itself a permission.
  2. Today: pick 1 or 2 as the morning score, tap "Show my plan for today". A "Take a task off today" card offers to move "Pick up groceries for the week (sample)" to a later day. Tap "Approve".
  3. Radar shows the sample car insurance renewal.
  4. Settings > Autopilot shows the standing rules, "Pause all Autopilot" and the done-list. Autopilot moves calendar events on its own only on a Google or Outlook calendar connected in Privacy & AI > Connections. Emails and cancellations are always drafts sent on a tap.
- Report (Guideline 1.2): every coach reply, plan item and Radar item has "Report this" > reason > "Reported".
- Settings: the round account button (top right). Your plan has "Change plan" and "Restore purchases" (sandbox works). Privacy & AI covers AI use, connections, export and delete.
- Account deletion: Settings > Delete account > "Delete my account" > "Delete everything". Signed out at once; the server erases the account within 24 hours. The demo account is recreated on the next demo sign-in.
- Subscriptions (auto-renewing, monthly or annual, In-App Purchase): Executive Roundtable, Executive Suite, Autopilot.

4. EXTERNAL SERVICES
- Supabase: authentication (Sign in with Apple, email one-time codes) and database.
- api.aplayermode.com on Cloudflare Workers: the app's own API.
- OpenRouter (AI router): coaching replies and plan text; providers may not train on user data.
- Apple In-App Purchase, managed through RevenueCat.
- Expo push (notifications); Resend (renewal reminder emails).
- Optional, only if the person connects them in Privacy & AI: Google Calendar (Google OAuth), Outlook calendar and mail (Microsoft OAuth), and the phone's calendars the person picks (iOS permission prompt).
- No advertising or third-party analytics SDKs; no data sale.

5. REGIONS
The same in every region; English interface. Crisis resources follow the phone's time zone (988 and 911 in the US; elsewhere local crisis lines and the local emergency number).

6. REGULATED INDUSTRY / HEALTH
APM is not a medical, mental-health, financial or legal service and makes no health claims; the Coach says it is not therapy or medical, legal or financial advice. Health information (movement, weight rhythm, the energy score) is collected only after a separate opt-in, used only to pace the Body steps, never sold or used for ads (Consumer Health Data Privacy Policy, linked in the app). On crisis language, coaching stops and crisis resources are shown. Autopilot never acts on money or health. Adults only (18+).
```

## Google Play → App access

"Some functionality is restricted": one instruction set, with the same user name and the same code as above. Note to paste:

```text
On the first screen tap "I already have an account", then "Email me a 6-digit code". Type the user name above and tap "Email me a 6-digit code" again. No email is sent: the app shows "Your review code". Type the password above exactly as written and tap "Verify and continue". The account holds every plan for review, so no purchase is needed. Calendar and Outlook mail connections are optional.
```
