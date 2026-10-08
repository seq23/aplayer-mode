// iOS: there is NO web checkout in an iPhone build (App Store Review Guideline 3.1.1). Metro
// resolves ./webCheckout to this file for iOS, so none of the card-checkout code, links or
// copy is in the iOS bundle. scripts/presubmit-ios.mjs and apps/mobile/test/web-billing.test.mjs
// keep this file free of any purchase link.
import type { Distribution } from './distribution';

export type WebCheckout = { kind: 'unavailable' };

export const WEB_PURCHASE_LINKS = { default: undefined, founding: undefined } as const;

export function webPurchaseUrl(): undefined { return undefined; }

export function webCheckoutFor(_distribution: Distribution, _founding: boolean): WebCheckout {
  return { kind: 'unavailable' };
}

export const WEB_CHECKOUT_COPY = {
  button: '', notConfigured: '', account: '', confirming: '', confirmed: '', pending: '', manageFallback: '', restore: '', alreadyPaid: '', notFound: '',
} as const;
