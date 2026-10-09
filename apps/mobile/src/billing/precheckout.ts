// Pay first, account after (docs/33 §10). "Join the Founding 100" (aplayermode.com and the
// welcome page) opens the Founding 100 card checkout BEFORE the setup questions and before any
// account exists. The web app mints a random UUID, the checkout id, keeps it in this browser and
// passes it to the Web Purchase Link as the RevenueCat app user id. After paying, the buyer lands
// on /billing/return, which claims it: the server creates the account WITH THAT ID
// (POST /v1/billing/precheckout/claim), so the RevenueCat app user id is the account's user id.
//
// Pure (no React Native imports) so apps/mobile/test runs it in Node. Web app only: the sideload
// APK keeps the in-app paywall (its checkout opens in another browser, which cannot read this
// browser's storage), and a store build never reaches a web checkout (App Store 3.1.1).
import { CHIEF_OF_STAFF_INTRO_OFFERS, REVENUECAT_CONFIG, formatUsdCents } from '@apm/policy';
import type { Distribution } from './distribution';
import { webPurchaseUrl } from './webCheckout';

/** localStorage key for the pending checkout id (this browser only; never sent anywhere else). */
export const PRECHECKOUT_STORAGE_KEY = 'apm.precheckout.v1';
/** A pending checkout older than this is replaced by a fresh one (a Founding 100 checkout is not kept forever). */
export const PRECHECKOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The one label for the button, on aplayermode.com and on the welcome page. */
export const JOIN_FOUNDING_LABEL = `Join the Founding 100 — ${formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents)}/month`;
/** The Founding 100 card: Executive Roundtable monthly in the `founding` offering. */
export const FOUNDING_PACKAGE_ID = REVENUECAT_CONFIG.packages.chief_of_staff.monthly;
/** Once the Founding 100 is full: the same Executive Roundtable monthly package in the `default` offering (intro price, then standard). */
export const STANDARD_PACKAGE_ID = REVENUECAT_CONFIG.packages.chief_of_staff.monthly;
const INTRO = CHIEF_OF_STAFF_INTRO_OFFERS.introductory;
/** The same button once the Founding 100 is full: the standard Executive Roundtable offer at its normal price. */
export const JOIN_STANDARD_LABEL = `Join the Executive Roundtable — ${formatUsdCents(INTRO.monthlyUsdCents)}/month for ${INTRO.months} months, then ${formatUsdCents(INTRO.thenMonthlyUsdCents)}/month`;

/** The server's public Founding 100 count (GET /v1/billing/founding). */
export interface FoundingPlaces { total: number; remaining: number | null; open: boolean | null }
export type JoinOffer = 'founding' | 'standard' | 'unknown';

/**
 * Which offer the join button sells, from the server's count ONLY: founding while places remain,
 * standard once none do (never a founding price past 100), unknown when the count could not be
 * read (the join page asks again rather than guessing either price).
 */
export function joinOfferFor(places: FoundingPlaces | null | undefined): JoinOffer {
  const remaining = places?.remaining;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || typeof places?.open !== 'boolean') return 'unknown';
  return remaining > 0 && places.open ? 'founding' : 'standard';
}

/** The button label for an offer; before the count arrives (or if it cannot) the founding label, since /join decides again. */
export function joinLabelFor(offer: JoinOffer): string {
  return offer === 'standard' ? JOIN_STANDARD_LABEL : JOIN_FOUNDING_LABEL;
}

/** What /join says when the Founding 100 is full, or when the count could not be read. */
export const JOIN_COPY = {
  foundingTitle: 'Opening the secure card checkout…',
  fullEyebrow: 'Executive Roundtable',
  fullTitle: 'The Founding 100 is full',
  fullBody: `All 100 Founding places are taken. Executive Roundtable is ${formatUsdCents(INTRO.monthlyUsdCents)}/month for your first ${INTRO.months} months, then ${formatUsdCents(INTRO.thenMonthlyUsdCents)}/month. Cancel any time.`,
  fullButton: `Continue to checkout — ${formatUsdCents(INTRO.monthlyUsdCents)}/month for ${INTRO.months} months`,
  unknown: 'We could not check how many Founding 100 places are left just now, so we have not opened a checkout. Try again in a moment.',
  tryAgain: 'Try again',
} as const;

export interface PendingCheckout { id: string; createdAt: number }

/** Pay-first exists only in the web app (see the header). */
export function payFirstAllowed(distribution: Distribution): boolean {
  return distribution === 'web';
}

/** A random v4 UUID; never derived from anything about the person. */
export function mintCheckoutId(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (b) => globalThis.crypto.getRandomValues(b)): string {
  const b = random(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Reads a stored pending checkout; anything malformed or stale reads as none. */
export function parsePendingCheckout(raw: string | null | undefined, nowMs: number): PendingCheckout | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<PendingCheckout>;
    if (typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.createdAt !== 'number') return undefined;
    if (value.createdAt > nowMs || nowMs - value.createdAt > PRECHECKOUT_MAX_AGE_MS) return undefined;
    return { id: value.id, createdAt: value.createdAt };
  } catch { return undefined; }
}

/** The Founding 100 checkout for a pending checkout id: the founding link, never the default one. */
export function foundingCheckoutUrl(checkoutId: string, foundingLink: string | undefined): string | undefined {
  if (!UUID.test(checkoutId)) return undefined;
  return webPurchaseUrl(foundingLink, FOUNDING_PACKAGE_ID, checkoutId);
}

/** The standard checkout for a pending checkout id once the Founding 100 is full: the default link, never the founding one. */
export function standardCheckoutUrl(checkoutId: string, defaultLink: string | undefined): string | undefined {
  if (!UUID.test(checkoutId)) return undefined;
  return webPurchaseUrl(defaultLink, STANDARD_PACKAGE_ID, checkoutId);
}

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
function storage(): Storage | undefined {
  try { return (globalThis as { localStorage?: Storage }).localStorage; } catch { return undefined; }
}

/** This browser's pending checkout, minting (and saving) one when there is none. */
export function pendingCheckout(nowMs: number = Date.now(), create = false): PendingCheckout | undefined {
  const store = storage();
  let existing: PendingCheckout | undefined;
  try { existing = parsePendingCheckout(store?.getItem(PRECHECKOUT_STORAGE_KEY), nowMs); } catch { existing = undefined; }
  if (existing || !create) return existing;
  const fresh = { id: mintCheckoutId(), createdAt: nowMs };
  try { store?.setItem(PRECHECKOUT_STORAGE_KEY, JSON.stringify(fresh)); } catch { /* private mode: still pay, claim on this page load */ }
  return fresh;
}

/** Forget the pending checkout once it is claimed (it is now just the account id). */
export function clearPendingCheckout(): void {
  try { storage()?.removeItem(PRECHECKOUT_STORAGE_KEY); } catch { /* nothing to clear */ }
}

/**
 * The checkout id the buyer ACTUALLY paid under. RevenueCat's return URL carries it as
 * `app_user_id`; it wins over this browser's stored id (a receipt link, another tab, or a stale
 * stored id would otherwise claim the wrong checkout and read not_paid forever). Safe: the claim
 * still needs the email typed at checkout and the 6-digit code. Anything malformed is ignored.
 */
export function checkoutIdFromReturn(search: string | undefined): string | undefined {
  try {
    const id = new URLSearchParams(search ?? '').get('app_user_id')?.trim().toLowerCase();
    return id && UUID.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** The checkout to claim on /billing/return: the URL's `app_user_id`, else this browser's stored one. */
export function returnCheckout(search: string | undefined, nowMs: number = Date.now()): PendingCheckout | undefined {
  const fromUrl = checkoutIdFromReturn(search);
  if (!fromUrl) return pendingCheckout(nowMs);
  const chosen = { id: fromUrl, createdAt: nowMs };
  try { storage()?.setItem(PRECHECKOUT_STORAGE_KEY, JSON.stringify(chosen)); } catch { /* still claimable on this page load */ }
  return chosen;
}

/**
 * RevenueCat takes a few seconds to record a purchase, so a claim right after paying can read
 * not_paid. Seconds after the first try at which the claim is re-asked, quietly: 55 s of waiting
 * plus six round trips (each checks RevenueCat twice), so up to about a minute and a half in all
 * (RETURN_COPY.waitingHint says so), and never more than 6 calls a minute (RECONCILE_LIMIT).
 */
export const CLAIM_RETRY_SCHEDULE_S: readonly number[] = [5, 10, 20, 35, 55];

/** Claims, re-asking on not_paid / rate_limited per CLAIM_RETRY_SCHEDULE_S; any other answer returns at once. */
export async function claimUntilPaid<T extends { claimed: boolean; error?: string }>(
  claim: () => Promise<T>,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: readonly number[] = CLAIM_RETRY_SCHEDULE_S,
): Promise<T> {
  let result = await claim();
  let waited = 0;
  for (const at of schedule) {
    if (result.claimed || (result.error !== 'not_paid' && result.error !== 'rate_limited')) return result;
    await sleep((at - waited) * 1000);
    waited = at;
    result = await claim();
  }
  return result;
}

export const PRECHECKOUT_COPY = {
  title: 'Payment received. Now your account.',
  lead: 'Type the email you used at checkout. We send a 6-digit code; your subscription is attached to the account it opens. Then the setup questions start.',
  claim: 'Attach my subscription',
  confirming: 'Confirming your payment…',
  unavailable: 'We could not check your payment just now. Wait a minute and try again; nothing is lost.',
  footnote: 'Paid from another browser or device? Open the link in your receipt email on that one, or write to support@aplayermode.com.',
} as const;

/**
 * Attaching a pay-first checkout to an EXISTING account (0096) right after the 6-digit code.
 * 9 Oct 2026: the one attach was sent the instant the code signed her in, BEFORE this device's
 * 18+ tap reached the server (ConsentProvider sends it a few seconds later), so the server's age
 * gate answered 403 age_confirmation_required; the page swallowed it, never asked again, and the
 * paid plan never reached the account. Now the page waits for the 18+ record, and any answer that
 * can change with time is re-asked on this schedule (seconds after the first try; at most 6 calls
 * a minute, the server's per-checkout limit). Only a final answer stops it early.
 */
export const ATTACH_RETRY_SCHEDULE_S: readonly number[] = [4, 10, 20, 35, 55];
/** Answers no retry can change: another email, or a checkout already on another account. */
export const ATTACH_FINAL_ERRORS: ReadonlySet<string> = new Set(['email_mismatch', 'already_claimed', 'invalid_request']);

export type AttachOutcome = { attached: true } | { attached: false; error: string; message?: string };

/** The error code an API failure carries (ApiError.code), else 'unavailable'. */
export function attachErrorCode(cause: unknown): string {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code ? code : 'unavailable';
}

/** Attaches, re-asking per ATTACH_RETRY_SCHEDULE_S until it is attached or the answer is final. */
export async function attachUntilDone(
  attach: () => Promise<unknown>,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule: readonly number[] = ATTACH_RETRY_SCHEDULE_S,
  stillWanted: () => boolean = () => true,
): Promise<AttachOutcome> {
  const once = async (): Promise<AttachOutcome> => {
    try { await attach(); return { attached: true }; }
    catch (cause) {
      const message = (cause as { message?: unknown } | undefined)?.message;
      return { attached: false, error: attachErrorCode(cause), ...(typeof message === 'string' && message ? { message } : {}) };
    }
  };
  let result = await once();
  let waited = 0;
  for (const at of schedule) {
    if (result.attached || ATTACH_FINAL_ERRORS.has(result.error) || !stillWanted()) return result;
    await sleep((at - waited) * 1000);
    waited = at;
    result = await once();
  }
  return result;
}

/** What the return page says while it waits, when it gives up, and when another account is signed in. */
export const RETURN_COPY = {
  waitingHint: 'This usually takes under a minute, and can take up to two. Keep this page open.',
  stillConfirming: 'Still confirming. Your payment is safe with the card processor; tap Check again in a minute. If your plan is not on within an hour, write to support@aplayermode.com and we will turn it on.',
  checkAgain: 'Check again',
  otherAccount: (email: string) => `You're signed in as ${email}. This purchase was made with another email — sign out to attach it.`,
  signOut: 'Sign out to attach it',
} as const;
