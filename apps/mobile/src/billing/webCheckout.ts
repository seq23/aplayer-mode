// Card checkout through the RevenueCat Web Purchase Link (RevenueCat Web Billing; docs/33 §9).
// Web app + sideload APK ONLY. iOS builds resolve ./webCheckout to webCheckout.ios.ts (a stub
// with none of this code), and an Android store build is refused by the distribution check
// below, so a store build can never render or open a web checkout (App Store 3.1.1).
//
// The link is per RevenueCat offering; the app appends the signed-in APM user id (the same id
// identifyBillingUser gives the SDK, and the id the webhook maps back to the account) and
// pre-selects the package. RevenueCat redirects to WEB_BILLING_CONFIG.returnUrl afterwards.
import { webCheckoutAllowed, type Distribution } from './distribution';

export type WebCheckout =
  | { kind: 'unavailable' }
  | { kind: 'not_configured' }
  | { kind: 'ready'; urlFor: (packageId: string, appUserId: string) => string | undefined };

/** The Web Purchase Links, inlined at build time (EXPO_PUBLIC_RC_WEB_PURCHASE_URL[_FOUNDING]). */
export const WEB_PURCHASE_LINKS = {
  default: process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL || undefined,
  founding: process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING || undefined,
} as const;

const LINK = /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_-]+)+\/?$/;
const PACKAGE = /^[a-z0-9_]{1,64}$/;

/** `<link>/<url-encoded app user id>?package_id=<package>`; undefined for anything malformed. */
export function webPurchaseUrl(link: string | undefined, packageId: string, appUserId: string): string | undefined {
  if (!link || !LINK.test(link) || !PACKAGE.test(packageId) || !appUserId || appUserId.length > 200) return undefined;
  return `${link.replace(/\/$/, '')}/${encodeURIComponent(appUserId)}?package_id=${encodeURIComponent(packageId)}`;
}

/**
 * What this build can do for card checkout. `founding` is the server's decision
 * (GET /v1/billing/offering). A founding user gets ONLY the founding link: with none
 * configured the state is not_configured, never the default link at a silently higher price.
 */
export function webCheckoutFor(distribution: Distribution, founding: boolean, links: { default?: string; founding?: string } = WEB_PURCHASE_LINKS): WebCheckout {
  if (!webCheckoutAllowed(distribution)) return { kind: 'unavailable' };
  const link = founding ? links.founding : links.default;
  if (!link || !LINK.test(link)) return { kind: 'not_configured' };
  return { kind: 'ready', urlFor: (packageId, appUserId) => webPurchaseUrl(link, packageId, appUserId) };
}

export const WEB_CHECKOUT_COPY = {
  button: 'Pay by card',
  notConfigured: 'Card payments open shortly. Everything you set up stays saved; this screen updates by itself once they do.',
  account: 'Save your account above first, so the subscription belongs to you and not to this browser.',
  confirming: 'Confirming your payment…',
  confirmed: 'Payment confirmed. Your plan is on.',
  pending: 'Payment received by the card processor. Your plan turns on here as soon as it is confirmed, usually within a minute.',
  manageFallback: 'To change or cancel a card subscription, open the "Manage subscription" link in any receipt email from A Player Mode.',
  restore: 'Card subscriptions follow your account: sign in the same way on any device and your plan is there.',
} as const;
