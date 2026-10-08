// Pure paywall logic (no React Native imports, so apps/mobile/test can run it in Node).
// Prices and package ids come from packages/policy (ADR-0004, ADR-0005); the store's
// own localized price string wins when the store has returned one.
import {
  CHIEF_OF_STAFF_INTRO_OFFERS,
  PLAN_PRICES,
  REVENUECAT_CONFIG,
  formatUsdCents,
  type BillingChannel,
  type StoreChannel,
  type BillingPeriod,
  type PaidPlan,
} from '@apm/policy';

export const PAID_PLANS: readonly PaidPlan[] = ['chief_of_staff', 'life_os', 'autopilot'];

export const STORE_LABELS: Readonly<Record<BillingChannel, { account: string; settings: string }>> = {
  app_store: { account: 'Apple ID', settings: 'App Store account settings' },
  google_play: { account: 'Google Play account', settings: 'Google Play subscriptions' },
  web: { account: 'card', settings: 'the customer portal (Manage subscription, or the link in any receipt email)' },
};

/** Store subscription-management pages (used when RevenueCat has no managementURL). */
export function storeManageUrl(store: StoreChannel, androidPackage = 'com.aplayermode.app'): string {
  return store === 'app_store'
    ? 'https://apps.apple.com/account/subscriptions'
    : `https://play.google.com/store/account/subscriptions?package=${encodeURIComponent(androidPackage)}`;
}

/** Apple's standard EULA: the iOS Terms of Use fallback until EXPO_PUBLIC_TERMS_URL is set. */
export const APPLE_STANDARD_EULA_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

export function packageIdFor(plan: PaidPlan, period: BillingPeriod): string {
  return REVENUECAT_CONFIG.packages[plan][period];
}

export function listPriceLabel(plan: PaidPlan, period: BillingPeriod): string {
  const price = PLAN_PRICES[plan];
  return period === 'annual' ? `${formatUsdCents(price.annualUsdCents)}/year` : `${formatUsdCents(price.monthlyUsdCents)}/month`;
}

export interface StorePrice {
  /** The store's localized price, e.g. "$24.99" or "24,99 €". */
  priceString?: string;
  /** The store's localized intro price, when the store offers one to this user. */
  introPriceString?: string;
}

export interface TierOffer {
  plan: PaidPlan;
  period: BillingPeriod;
  displayName: string;
  tagline: string;
  packageId: string;
  /** e.g. "$24.99/month" (store price when known). */
  priceLabel: string;
  /** Annual saving line, or the Executive Roundtable monthly intro line. */
  note?: string;
  founding: boolean;
}

/**
 * The three tier cards for the chosen period. `founding` is the server's decision
 * (GET /v1/billing/offering); the app never infers it.
 */
export function tierOffers(period: BillingPeriod, founding: boolean, storePrices: Partial<Record<string, StorePrice>> = {}): TierOffer[] {
  return PAID_PLANS.map((plan) => {
    const price = PLAN_PRICES[plan];
    const packageId = packageIdFor(plan, period);
    const store = storePrices[packageId];
    const isFounding = founding && plan === 'chief_of_staff' && period === 'monthly';
    const unit = period === 'annual' ? 'year' : 'month';
    const fallback = isFounding ? formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents) : period === 'annual' ? formatUsdCents(price.annualUsdCents) : formatUsdCents(price.monthlyUsdCents);
    const priceLabel = `${store?.priceString ?? fallback}/${unit}`;
    let note: string | undefined;
    if (isFounding) note = 'Founding 100: this price stays for as long as you stay continuously subscribed.';
    else if (plan === 'chief_of_staff' && period === 'monthly') {
      const intro = store?.introPriceString ?? formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents);
      note = `New subscribers: ${intro}/month for the first ${CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months, then ${store?.priceString ?? formatUsdCents(price.monthlyUsdCents)}/month.`;
    } else if (period === 'annual') note = `2 months free versus ${formatUsdCents(price.monthlyUsdCents)}/month.`;
    return { plan, period, displayName: price.displayName, tagline: price.tagline, packageId, priceLabel, note, founding: isFounding };
  });
}

/**
 * The store-required subscription disclosure (App Store Review Guideline 3.1.2, Google
 * Play subscription policy): what is bought, price and period, auto-renewal, how the
 * charge happens, how to cancel, and the intro / founding terms. Links to the Terms of
 * Use and Privacy Policy are rendered beside it.
 */
export function subscriptionDisclosure(store: BillingChannel, offer: TierOffer): string[] {
  const unit = offer.period === 'annual' ? 'year' : 'month';
  const labels = STORE_LABELS[store];
  const lines = [
    `${offer.displayName} (${offer.period === 'annual' ? 'annual' : 'monthly'}) is an auto-renewing subscription at ${offer.priceLabel}.`,
    `Payment is charged to your ${labels.account} when you confirm the purchase.`,
    store === 'web'
      ? `It renews automatically every ${unit} at the then-current price until you cancel; each renewal is charged to the same card at the start of the new period.`
      : `It renews automatically every ${unit} at the then-current price unless auto-renew is turned off at least 24 hours before the end of the current period; renewal is charged within the 24 hours before the period ends.`,
    `Manage or cancel any time in ${labels.settings}. Cancelling stops the next renewal; you keep access until the end of the period you paid for.`,
    'There is no free trial.',
  ];
  if (offer.founding) lines.push('Founding 100: the founding price holds only while the subscription stays continuously active. If it lapses, the founding price ends and re-subscribing is at the current price.');
  else if (offer.note && offer.plan === 'chief_of_staff' && offer.period === 'monthly') lines.push(`${offer.note} The intro price is for new subscribers only, as the ${store === 'web' ? 'checkout' : 'store'} determines.`);
  lines.push('Buying a plan makes capability available. It never gives APM permission to act for you; you grant that separately, and you can revoke it.');
  return lines;
}
