# A Player Mode — Runtime Evidence Packet

**Status: OPEN EXTERNAL VALIDATION PACKET**  
**Created: 2026-10-06**

The full remaining-platform source baseline is merged. This packet is the next truth gate: collect real receipts for deployed/provider/device/store behavior without reopening product architecture.

## Evidence ledger

| Gate | Required receipt | Status |
|---|---|---|
| Supabase Free keep-alive | manual workflow dispatch completed successfully | `PASS` — run `37499486013` |
| GitHub main protection | active ruleset/branch-protection receipt + failing-PR enforcement proof | `OPEN` — issue #7 |
| Cloudflare API | deployed `/v1/health` + request ID + exact source SHA | `OPEN` |
| Supabase runtime | authenticated Life Graph/Today round-trip | `OPEN` |
| Session durability | real device kill/restart/restored session | `OPEN` |
| RLS isolation | User A denied access to User B data | `OPEN` |
| OpenRouter | public-synthetic eval report artifact tied to exact SHA | `OPEN` |
| Approved model | explicit registry promotion record after review | `OPEN` |
| Live coaching | private-life call on exact approved route | `OPEN` |
| Device/iCloud calendar | real iPhone calendar sync | `OPEN` |
| Google Calendar | OAuth + sync receipt | `OPEN` |
| Gmail | OAuth + normalized commitment receipt | `OPEN` |
| Microsoft Calendar | Graph OAuth + sync receipt | `OPEN` |
| Outlook Mail | Graph OAuth + normalized signal receipt | `OPEN` |
| Push | real device notification receipt | `OPEN` |
| Action Engine | prepared → approved → executed → verified receipt with global + domain switches intentionally enabled | `OPEN` |
| Data deletion | privileged deletion lifecycle completion | `OPEN` |
| EAS/TestFlight | signed preview/production build receipt | `OPEN` |
| Google Play | internal testing build receipt | `OPEN` |
| Billing | sandbox purchase + server entitlement receipt | `OPEN` |
| Legal | qualified launch-language review | `OPEN` |
| Closed beta | 25–50 user evidence packet | `OPEN` |

## Receipt format

Every proof should capture:

```text
Gate:
Environment:
Date/time:
Commit SHA:
Test account/device:
Action performed:
Expected result:
Actual result:
Request / provider / build ID:
Sensitive values redacted:
PASS / FAIL:
Failure fix, if any:
```

Machine-generated workflow receipts should use the same fields where applicable. Artifact output is evidence; it is not committed to Git because `evidence/` is intentionally ignored.

## Execution rule

A failed receipt does not trigger redesign. Fix the smallest failing layer, rerun that proof, and preserve the locked product/system architecture unless evidence establishes an architectural defect.

No gate may move from `OPEN` to `PASS` because source exists. It moves only when the required external receipt exists and corresponds to an immutable source SHA.

## Product evidence after technical proof

Once the technical gates are green, closed beta measures:

- valuable proactive interventions / user / week;
- Radar false-positive and correction rate;
- action rate;
- notification disable rate;
- retention;
- trust comprehension;
- AI cost / successful task;
- variable cost / active user;
- willingness to pay.

Life-area modules and standing Autopilot expand from this evidence, not from speculative feature accumulation.
