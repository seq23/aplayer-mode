# A Player Mode — Provider Setup Matrix

**Status: EXTERNAL SETUP MATRIX**  
**Updated: 2026-10-06**

This matrix connects each external provider to APM capability, credential ownership, source implementation and proof required.

| Provider | APM capability | APM source path | Required external setup | Proof before production |
|---|---|---|---|---|
| Supabase | Auth / Postgres / RLS | API + mobile auth | Free project + publishable config | authenticated runtime + RLS negative test |
| Cloudflare | API / privacy / action boundary | `services/api` | Worker account + API deploy credentials + runtime secrets | deployed health + authenticated API receipt |
| OpenRouter | model inference | `packages/ai`, API gateway | project key + privacy settings | eval report + explicit route approval + private call |
| Expo / EAS | builds + push | `apps/mobile` | Expo project + token + push credentials | signed build + real device push |
| Google Calendar | calendar read/write | connector source | OAuth client + consent/scopes | sync + provenance + action receipt |
| Gmail | commitments / draft/send | connector source | OAuth client + consent/scopes + applicable verification | signal extraction + draft/send receipt as permitted |
| Microsoft Calendar | calendar read/write | connector source | Entra app registration + Graph permissions | sync + action receipt |
| Outlook / Microsoft Mail | commitments / draft/send | connector source | Entra app registration + Graph permissions | signal extraction + draft/send receipt as permitted |
| Apple device calendars | iCloud + device calendars | Expo Calendar lane | iOS permission; account configured on device | real iPhone sync receipt |
| Apple App Store | distribution/subscription | EAS/store config | Developer + App Store Connect | TestFlight + sandbox purchase + review metadata |
| Google Play | distribution/subscription | EAS/store config | Play Console | internal build + sandbox purchase + review metadata |

## Separation rules

- Google Calendar access does not imply Gmail access.
- Microsoft Calendar access does not imply Microsoft Mail access.
- Read access does not imply write/send authority.
- Provider OAuth scope does not replace APM domain permission.
- Subscription entitlement does not replace APM domain permission.
- Mobile device calendar permission never exposes provider OAuth credentials to APM.

## Setup completion definition

A provider is not considered "connected" at product level merely because credentials exist. It is complete only when:

```text
External console configured
  -> user consent succeeds
  -> encrypted token/session stored correctly
  -> source sync succeeds
  -> canonical APM state is created
  -> provenance is visible
  -> disconnect/reauth works
  -> security/privacy claims match the actual scopes
```
