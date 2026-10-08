// Can this account run the daily loop? Mirrors the server's entitlementIsUsable
// (services/api/src/entitlement.ts) and private.apm_has_core_access (0044) so the app
// never offers a button the server will refuse: a new account with no plan sees "pick a
// plan", never a check-in that fails (docs/35 E5).
import type { SubscriptionEntitlement } from '@apm/domain';

export function hasDailyLoopAccess(entitlement: SubscriptionEntitlement | undefined, now = new Date()): boolean {
  if (!entitlement || (entitlement.status !== 'active' && entitlement.status !== 'trialing')) return false;
  if (entitlement.plan === 'beta') {
    return !entitlement.provider && Boolean(entitlement.currentPeriodEnd) && Date.parse(entitlement.currentPeriodEnd!) > now.getTime();
  }
  return true;
}

/**
 * What the "no plan yet" card on Today says, per build. Never a dead end. `canBuyHere` is
 * true in a store build that can buy in-app AND in the web app / sideload APK (card
 * checkout, docs/33 §9): those must never be told to go to a store app.
 */
export function noPlanCopy(canBuyHere: boolean): { title: string; body: string; action: string } {
  return canBuyHere
    ? {
        title: 'Your OS is ready. Pick a plan to start Day 1.',
        body: 'Everything you set up is saved. A plan turns on your daily agenda, check-ins and coaching rhythm.',
        action: 'See plans',
      }
    : {
        title: 'Your OS is ready. Plans are chosen in the iPhone or Android app.',
        body: 'Everything you set up is saved to your account. Open A Player Mode on your phone, sign in the same way, and pick a plan there. Day 1 starts the moment you do.',
        action: 'See what each plan does',
      };
}
