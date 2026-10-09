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

export const PRECHECKOUT_COPY = {
  title: 'Payment received. Now your account.',
  lead: 'Type the email you used at checkout. We send a 6-digit code; your subscription is attached to the account it opens. Then the setup questions start.',
  claim: 'Attach my subscription',
  unavailable: 'We could not check your payment just now. Wait a minute and try again; nothing is lost.',
  footnote: 'Paid from another browser or device? Open the link in your receipt email on that one, or write to support@aplayermode.com.',
} as const;
