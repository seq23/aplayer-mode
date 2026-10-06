# A Player Mode — Required External Credentials

**Status: OPERATIONS CHECKLIST**  
**Updated: 2026-10-06**

No credential value belongs in Git. This file records **names and purpose only** so runtime work can proceed without inventing or exposing secrets.

## GitHub Actions secrets

| Secret | Needed for |
|---|---|
| `SUPABASE_URL` | Supabase Free keep-alive workflow |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase Free keep-alive workflow |
| `OPENROUTER_API_KEY` | Manual model evaluation workflow |
| `CLOUDFLARE_API_TOKEN` | Manual Cloudflare Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | Manual Cloudflare Worker deployment |
| `EXPO_TOKEN` | Manual EAS mobile build workflow |

These secrets should be scoped to the minimum access required by their workflow.

## Cloudflare Worker secrets/config

| Name | Class | Needed for |
|---|---|---|
| `SUPABASE_URL` | config | Supabase Auth/Data API |
| `SUPABASE_PUBLISHABLE_KEY` | publishable config | RLS-bound Supabase access |
| `OPENROUTER_API_KEY` | secret | Model inference |
| `CONNECTOR_CREDENTIAL_KEY` | secret | AES-GCM encryption of provider tokens |
| `OAUTH_STATE_SECRET` | secret | OAuth state integrity |
| `GOOGLE_OAUTH_CLIENT_ID` | config | Google OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET` | secret where applicable | Google token exchange |
| `GOOGLE_OAUTH_REDIRECT_URI` | config | Google OAuth callback |
| `MICROSOFT_OAUTH_CLIENT_ID` | config | Microsoft OAuth |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | secret where applicable | Microsoft token exchange |
| `MICROSOFT_OAUTH_REDIRECT_URI` | config | Microsoft OAuth callback |
| `MICROSOFT_TENANT` | config | Microsoft tenant routing |
| `EXPO_ACCESS_TOKEN` | secret if required | Server-side Expo push |
| `GLOBAL_ACTION_EXECUTION` | config / kill switch | Must be `true` before any provider action execution |
| `ACTION_CALENDAR_EXECUTION` | config / kill switch | Calendar action execution |
| `ACTION_EMAIL_EXECUTION` | config / kill switch | Email action execution |
| `ACTION_ROUTINE_EXECUTION` | config / kill switch | Routine action execution |
| `ACTION_LIFE_GRAPH_EXECUTION` | config / kill switch | Life Graph action execution |
| `ACTION_NOTIFICATION_EXECUTION` | config / kill switch | Notification action execution |
| `ACTION_CONNECTOR_EXECUTION` | config / kill switch | Connector-level action execution |

All action switches default conceptually to **false**. Enabling the global switch alone is insufficient; the domain switch must also be enabled.

## Mobile public configuration

These values are bundled into the app and therefore are **not secrets**:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_APM_API_URL`
- `EXPO_PUBLIC_EAS_PROJECT_ID`

Never place server/API/provider secrets into `EXPO_PUBLIC_*` variables.

## Provider accounts / consoles

External setup still requires real accounts/configuration in:

- Cloudflare;
- OpenRouter;
- Google Cloud / OAuth consent;
- Microsoft Entra app registration;
- Expo / EAS;
- Apple Developer / App Store Connect;
- Google Play Console;
- whichever billing adapter is selected by later ADR.

## Secret rotation rule

If a credential is exposed in Git, a mobile bundle, a prompt, a screenshot, CI logs, or an uncontrolled channel, treat it as compromised: revoke/rotate it and update the managed secret store. Removing it from Git history alone is not sufficient.
