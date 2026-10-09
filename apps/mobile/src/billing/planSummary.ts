// The current plan in one line, e.g. "Executive Suite · active". Read from GET /v1/product/plan,
// the SAME entitlement source Settings → Your plan (app/settings/plan.tsx) shows; the display name
// is the server's (ADR-0006), never retyped here. Pure, so apps/mobile/test runs it in Node.

/** Status words, shared by the plan screen and the Settings home line. */
export const PLAN_STATUS_WORDS: Readonly<Record<string, string>> = { active: 'Active', trialing: 'Active', past_due: 'Payment problem', cancelled: 'Cancelled', expired: 'Ended' };

export function planSummary(entitlement: { displayName?: string; status?: string } | undefined): string | undefined {
  const name = entitlement?.displayName?.trim();
  if (!name) return undefined;
  return `${name} · ${(PLAN_STATUS_WORDS[entitlement?.status ?? ''] ?? 'Not active').toLowerCase()}`;
}
