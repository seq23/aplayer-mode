// Pure paywall logic (no React Native imports, so apps/mobile/test can run it in Node).
// Package ids come from packages/policy (ADR-0004, ADR-0005). Prices: a store build shows only the
// store's own price strings (none until it answers); card checkout shows the policy USD prices.
import { errorDiagnostic } from '../api/errors';
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

export interface StorePrice {
  /** The store's localized price, e.g. "$24.99" or "24,99 €". */
  priceString?: string;
  /** The store's localized intro price, when the store offers one to this user. */
  introPriceString?: string;
}

/**
 * Every price the paywall shows, by package id. `shown` is the offering on screen (the founding
 * offering's cos_monthly is the founding price); `standard` is the default offering (the regular
 * price the banner, the grid and the annual note compare against).
 *   * A store build shows ONLY what Google Play / the App Store returned: the price that store
 *     will charge, in the buyer's currency. Until it answers there is no price at all.
 *   * Card checkout (web, sideload APK) charges the ADR-0004 USD prices, so it shows those.
 */
export interface Prices {
  shown: Partial<Record<string, StorePrice>>;
  standard: Partial<Record<string, StorePrice>>;
}

export const NO_PRICES: Prices = { shown: {}, standard: {} };

/** Card checkout's prices (RevenueCat Web Billing, USD): exactly packages/policy. */
export function cardPrices(founding: boolean): Prices {
  const standard: Record<string, StorePrice> = {};
  for (const plan of PAID_PLANS) {
    standard[packageIdFor(plan, 'monthly')] = { priceString: formatUsdCents(PLAN_PRICES[plan].monthlyUsdCents) };
    standard[packageIdFor(plan, 'annual')] = { priceString: formatUsdCents(PLAN_PRICES[plan].annualUsdCents) };
  }
  const cos = packageIdFor('chief_of_staff', 'monthly');
  standard[cos] = { ...standard[cos], introPriceString: formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents) };
  const shown = founding ? { ...standard, [cos]: { priceString: formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents) } } : standard;
  return { shown, standard };
}

/** The shape of a store package this file reads (react-native-purchases PurchasesPackage). */
export interface StorePackageLike { identifier: string; product: { priceString?: string; introPrice?: { priceString?: string } | null } }

/** A store build's prices: only the strings the store returned for each package. */
export function storePrices(offer?: { availablePackages: readonly StorePackageLike[]; standardPackages?: readonly StorePackageLike[] }): Prices {
  const read = (packages: readonly StorePackageLike[] = []) => {
    const out: Record<string, StorePrice> = {};
    for (const pkg of packages) out[pkg.identifier] = { priceString: pkg.product.priceString || undefined, introPriceString: pkg.product.introPrice?.priceString || undefined };
    return out;
  };
  return { shown: read(offer?.availablePackages), standard: read(offer?.standardPackages) };
}

export interface TierOffer {
  plan: PaidPlan;
  period: BillingPeriod;
  displayName: string;
  tagline: string;
  packageId: string;
  /** e.g. "$24.99/month"; absent while the store has not given a price (nothing is shown then). */
  priceLabel?: string;
  /** Annual saving line, or the Executive Roundtable monthly intro line. */
  note?: string;
  founding: boolean;
}

/**
 * The three tier cards for the chosen period. `founding` is the server's decision
 * (GET /v1/billing/offering); the app never infers it. Every figure comes from `prices`.
 */
export function tierOffers(period: BillingPeriod, founding: boolean, prices: Prices): TierOffer[] {
  return PAID_PLANS.map((plan) => {
    const price = PLAN_PRICES[plan];
    const packageId = packageIdFor(plan, period);
    const store = prices.shown[packageId];
    const isFounding = founding && plan === 'chief_of_staff' && period === 'monthly';
    const unit = period === 'annual' ? 'year' : 'month';
    const priceLabel = store?.priceString ? `${store.priceString}/${unit}` : undefined;
    let note: string | undefined;
    if (isFounding) note = 'Founding 100: this price stays for as long as you stay continuously subscribed.';
    else if (plan === 'chief_of_staff' && period === 'monthly') {
      // Only when the store offers the intro to THIS buyer (an ineligible buyer pays the list price).
      if (store?.introPriceString && store.priceString) note = `New subscribers: ${store.introPriceString}/month for the first ${CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months, then ${store.priceString}/month.`;
    } else if (period === 'annual') {
      const perMonth = prices.standard[packageIdFor(plan, 'monthly')]?.priceString;
      if (perMonth) note = `2 months free versus ${perMonth}/month.`;
    }
    return { plan, period, displayName: price.displayName, tagline: price.tagline, packageId, priceLabel, note, founding: isFounding };
  });
}

/** How long the paywall waits for the store (RevenueCat, then Google Play / the App Store) before it says plans are unavailable. */
export const STORE_ANSWER_MS = 15_000;

/**
 * Why the store side did not load, from the RevenueCat error code (PURCHASES_ERROR_CODE) so the
 * paywall tells the buyer the true cause and what fixes it:
 *   not_allowed  "3" PURCHASE_NOT_ALLOWED: Google Play billing unavailable on this phone (no Google
 *                account signed in to Play), or purchases switched off on the iPhone (Screen Time).
 *   network      "10" NETWORK, "35" OFFLINE_CONNECTION: the phone cannot reach the store.
 *   store        "2" STORE_PROBLEM, "12"/"16" backend, "32" product request timed out.
 *   not_set_up   "23" CONFIGURATION, "11" INVALID_CREDENTIALS, "5" product not available, or the
 *                offering came back missing / with no packages: nothing in this build can be bought.
 *   timeout      no answer within STORE_ANSWER_MS.
 *   unknown      any other code, or none.
 */
export type StoreFault = 'not_allowed' | 'network' | 'store' | 'not_set_up' | 'timeout' | 'unknown';

const FAULT_BY_CODE: Readonly<Record<string, StoreFault>> = {
  '3': 'not_allowed', '10': 'network', '35': 'network', '2': 'store', '12': 'store', '16': 'store', '32': 'store', '23': 'not_set_up', '11': 'not_set_up', '5': 'not_set_up',
};

export function storeFaultFor(code: string | undefined): StoreFault {
  return (code !== undefined && FAULT_BY_CODE[code]) || 'unknown';
}

export type StoreOfferingState<O> = { state: 'ready'; offering: O } | { state: 'unavailable'; fault: StoreFault; code?: string };

/**
 * The store side of the paywall, as one answer. A store that throws, never answers, has no such
 * offering or returns it with no packages (Play Billing unavailable, RevenueCat down) is
 * `unavailable`, with the cause: the paywall says so and buys nothing. Each cause is written to the
 * device log (logcat tag ReactNativeJS) as "[apm-billing] store plans unavailable: ...". It never
 * grants anything either way; only the server's entitlement row (GET /v1/product/plan) does.
 */
export async function loadStoreOffering<O extends { availablePackages: readonly unknown[] }>(
  load: () => Promise<O | undefined>, timeoutMs = STORE_ANSWER_MS, log: (line: string) => void = (line) => console.warn(line),
): Promise<StoreOfferingState<O>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (fault: StoreFault, code?: string, detail?: string): StoreOfferingState<O> => {
    log(`[apm-billing] store plans unavailable: fault=${fault} code=${code ?? 'none'}${detail ? ` ${detail}` : ''}`);
    return code === undefined ? { state: 'unavailable', fault } : { state: 'unavailable', fault, code };
  };
  try {
    const timedOut = Symbol('timeout');
    const timeout = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); });
    const offering = await Promise.race([load(), timeout]);
    if (offering === timedOut) return unavailable('timeout', undefined, `no answer in ${timeoutMs} ms`);
    if (!offering) return unavailable('not_set_up', undefined, 'offering missing');
    if (offering.availablePackages.length === 0) return unavailable('not_set_up', undefined, 'offering has no packages');
    return { state: 'ready', offering };
  } catch (cause) {
    const { code, detail } = errorDiagnostic(cause);
    return unavailable(storeFaultFor(code), code, detail);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** What the paywall says when the store side did not load: the true cause, that nothing was charged, and what fixes it. */
export function storeUnavailableCopy(store: StoreChannel, fault: StoreFault, code?: string): string {
  const who = store === 'google_play' ? 'Google Play' : 'The App Store';
  const safe = 'Nothing was charged and your setup is saved.';
  switch (fault) {
    case 'not_allowed':
      return store === 'google_play'
        ? `Google Play can't take payments on this phone yet. Open the Play Store app and sign in with your Google account, then tap Try again. ${safe}`
        : `This iPhone doesn't allow in-app purchases. Allow them in Settings > Screen Time > Content & Privacy Restrictions, then tap Try again. ${safe}`;
    case 'network':
      return `This phone can't reach ${who === 'The App Store' ? 'the App Store' : who} right now. Check your internet connection, then tap Try again. ${safe}`;
    case 'not_set_up':
      return `Plans can't be bought in this version of the app yet. ${safe}`;
    case 'store':
    case 'timeout':
      return `${who} is not answering right now, so plans cannot be bought yet. ${safe} Try again in a moment.`;
    default:
      return `${who} could not load the plans${code ? ` (error ${code})` : ''}. ${safe} Try again in a moment.`;
  }
}

export type StoreLoad = 'loading' | 'ready' | 'unavailable';

/** Why a store buy button is disabled, in words (never a silent grey button; docs/36 H5). */
export function buyBlockedReason(input: {
  available: boolean; isAnonymous: boolean; legalReady: boolean; planLoadFailed: boolean; store: StoreLoad; hasPackage: boolean;
}): string | undefined {
  if (!input.available) return undefined; // the unavailable card above says why
  if (input.isAnonymous) return 'Save your account above first. Then you can subscribe.';
  if (!input.legalReady) return undefined; // the configuration card above says why
  if (input.planLoadFailed) return 'Plans did not load. Tap Try again above.';
  if (input.store === 'unavailable') return 'Not available right now. Tap Try again above.';
  if (input.store === 'loading') return 'Getting prices from the store…';
  if (!input.hasPackage) return 'This plan is not in the store yet. Pick another or decide later.';
  return undefined;
}

/**
 * The trust line (paywall and Settings): what APM never does, in four plain lines. Each line
 * is a rule the code enforces, so it may only change with that code:
 *   - never spends: Autopilot may cancel to save money, never sign up, upgrade or pay
 *     (packages/policy, R-SUB-05; `subscription.cancel` / free bookings only);
 *   - never sends on its own: every send waits for a tap, or for a standing rule the person
 *     granted, which expires and can be revoked (policy STANDING_ACTIONS, drafts never auto-send);
 *   - undo: Autopilot's calendar changes and drafts undo (StandingUndo); its sends are labelled
 *     "Can't undo" in Settings, Autopilot before the rule is granted. Tap-approved items on Today
 *     have no Undo (only moved meetings do), so the line promises undo for Autopilot only;
 *   - billing: the store that bills, cancel without a call, and the yearly renewal email
 *     (services/api/src/renewalReminders.ts, migration 0098: App Store and card plans, sent
 *     15 to 45 days before renewal; Google Play is left out because it sends its own).
 */
export function trustLines(channel: BillingChannel): { title: string; body: string }[] {
  const reminder = channel === 'google_play' ? '' : ' On a yearly plan, we email you at least 15 days before it renews.';
  const billed = channel === 'app_store'
    ? { title: 'Billed by Apple', body: `Cancel any time in your iPhone's Settings, no call needed.${reminder}` }
    : channel === 'google_play'
      ? { title: 'Billed by Google Play', body: 'Cancel any time in Google Play, no call needed.' }
      : { title: 'Billed to your card', body: `Cancel any time in Manage subscription, no call needed.${reminder}` };
  return [
    { title: 'Never spends your money', body: 'Autopilot can cancel a subscription you name. APM never buys anything for you, upgrades a plan or enters a card.' },
    { title: 'Never sends on its own', body: 'Each message waits for your tap, or for a rule you set. Rules expire, and you can switch one off any time.' },
    { title: 'Undo', body: "Autopilot's calendar changes and drafts undo in one tap. A send can't be undone, and Autopilot says so before you allow it." },
    billed,
  ];
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
    offer.priceLabel
      ? `${offer.displayName} (${offer.period === 'annual' ? 'annual' : 'monthly'}) is an auto-renewing subscription at ${offer.priceLabel}.`
      : `${offer.displayName} (${offer.period === 'annual' ? 'annual' : 'monthly'}) is an auto-renewing subscription; ${store === 'app_store' ? 'the App Store' : store === 'google_play' ? 'Google Play' : 'checkout'} shows its price before you confirm.`,
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
