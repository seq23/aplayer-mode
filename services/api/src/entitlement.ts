import type { SubscriptionEntitlement } from '@apm/domain';

export function entitlementIsUsable(entitlement: SubscriptionEntitlement | undefined, now = new Date()): boolean {
  if (!entitlement || (entitlement.status !== 'active' && entitlement.status !== 'trialing')) return false;
  // 0044: beta is an allowlisted window with an end date, never a permanent plan,
  // and never over a store subscription (mirrors private.apm_has_core_access).
  if (entitlement.plan === 'beta') {
    return !entitlement.provider && Boolean(entitlement.currentPeriodEnd) && Date.parse(entitlement.currentPeriodEnd!) > now.getTime();
  }
  return true;
}
