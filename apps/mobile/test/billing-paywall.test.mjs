// The paywall's pure logic (src/billing/catalog.ts) and the client trust boundary:
//   * card checkout shows the ADR-0004 / ADR-0005 USD prices; a store build only the store's own strings, none while unknown;
//   * Founding 100 appears ONLY when the server said so, and only on Executive Roundtable monthly;
//   * the store-required disclosure states price, period, auto-renewal, charge timing,
//     how to cancel, no free trial, and the intro / founding terms;
//   * no app code reports a purchase to the APM API or decides Founding eligibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
let outDir; let catalog;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-paywall-'));
  await build({ entryPoints: { catalog: join(appDir, 'src/billing/catalog.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  catalog = await import(pathToFileURL(join(outDir, 'catalog.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

// A Play build's listing: every package with Google's own localized strings (FIX 3: never a hard-coded US price).
const playPkg = (identifier, priceString, introPriceString) => ({ identifier, product: { priceString, introPrice: introPriceString ? { priceString: introPriceString } : null } });
const playDefault = [
  playPkg('cos_monthly', '24,99 €', '9,99 €'), playPkg('lifeos_monthly', '39,99 €'), playPkg('autopilot_monthly', '79,99 €'),
  playPkg('cos_annual', '249,99 €'), playPkg('lifeos_annual', '399,99 €'), playPkg('autopilot_annual', '799,99 €'),
];

test('card checkout (web, sideload) shows exactly the decided USD prices for each period', () => {
  const monthly = catalog.tierOffers('monthly', false, catalog.cardPrices(false));
  assert.deepEqual(monthly.map((o) => [o.plan, o.priceLabel, o.packageId, o.founding]), [
    ['chief_of_staff', '$24.99/month', 'cos_monthly', false],
    ['life_os', '$39.99/month', 'lifeos_monthly', false],
    ['autopilot', '$79.99/month', 'autopilot_monthly', false],
  ]);
  assert.equal(monthly[0].note, 'New subscribers: $9.99/month for the first 3 months, then $24.99/month.');
  const annual = catalog.tierOffers('annual', false, catalog.cardPrices(false));
  assert.deepEqual(annual.map((o) => [o.plan, o.priceLabel, o.packageId]), [
    ['chief_of_staff', '$249.99/year', 'cos_annual'],
    ['life_os', '$399.99/year', 'lifeos_annual'],
    ['autopilot', '$799.99/year', 'autopilot_annual'],
  ]);
  assert.deepEqual(annual.map((o) => o.note), ['2 months free versus $24.99/month.', '2 months free versus $39.99/month.', '2 months free versus $79.99/month.']);
});

test('a store build shows only Google Play\'s own price strings, and no price at all while Play is unknown', () => {
  const play = catalog.storePrices({ availablePackages: playDefault, standardPackages: playDefault });
  const monthly = catalog.tierOffers('monthly', false, play);
  assert.deepEqual(monthly.map((o) => o.priceLabel), ['24,99 €/month', '39,99 €/month', '79,99 €/month']);
  assert.equal(monthly[0].note, 'New subscribers: 9,99 €/month for the first 3 months, then 24,99 €/month.');
  const annual = catalog.tierOffers('annual', false, play);
  assert.deepEqual(annual.map((o) => o.priceLabel), ['249,99 €/year', '399,99 €/year', '799,99 €/year']);
  assert.deepEqual(annual.map((o) => o.note), ['2 months free versus 24,99 €/month.', '2 months free versus 39,99 €/month.', '2 months free versus 79,99 €/month.']);
  // Play unknown (loading, outage, a package missing its price): no price, no note, never a fallback USD figure.
  for (const unknown of [catalog.NO_PRICES, catalog.storePrices(undefined), catalog.storePrices({ availablePackages: [playPkg('cos_monthly', '')] })]) {
    for (const period of ['monthly', 'annual']) {
      for (const o of catalog.tierOffers(period, false, unknown)) {
        assert.equal(o.priceLabel, undefined, `${period} ${o.plan}: no price while Play is unknown`);
        assert.equal(o.note, undefined, `${period} ${o.plan}: no price note while Play is unknown`);
        const disclosure = catalog.subscriptionDisclosure('google_play', o).join(' ');
        assert.doesNotMatch(disclosure, /\$\d/, 'the disclosure names no USD price');
        assert.match(disclosure, /Google Play shows its price before you confirm/);
      }
    }
  }
  // An intro Play does not offer THIS buyer is never promised.
  const noIntro = catalog.storePrices({ availablePackages: [playPkg('cos_monthly', '24,99 €')] });
  assert.equal(catalog.tierOffers('monthly', false, noIntro)[0].note, undefined);
});

test('Founding 100 shows only on the server\'s word, only on Executive Roundtable monthly', () => {
  const founding = catalog.tierOffers('monthly', true, catalog.cardPrices(true));
  assert.deepEqual(founding.map((o) => o.founding), [true, false, false]);
  assert.equal(founding[0].priceLabel, '$9.99/month');
  assert.match(founding[0].note, /continuously subscribed/);
  assert.deepEqual(catalog.tierOffers('annual', true, catalog.cardPrices(true)).map((o) => o.founding), [false, false, false], 'never on annual');
  // On Play, the founding price is the founding offering's own Play string.
  const play = catalog.storePrices({ availablePackages: [playPkg('cos_monthly', '9,99 €'), ...playDefault.slice(1)], standardPackages: playDefault });
  assert.equal(catalog.tierOffers('monthly', true, play)[0].priceLabel, '9,99 €/month');
});

test('the disclosure states everything the stores require', () => {
  for (const store of ['app_store', 'google_play']) {
    for (const offer of [...catalog.tierOffers('monthly', false, catalog.cardPrices(false)), ...catalog.tierOffers('annual', false, catalog.cardPrices(false)), catalog.tierOffers('monthly', true, catalog.cardPrices(true))[0]]) {
      const text = catalog.subscriptionDisclosure(store, offer).join(' ');
      assert.ok(text.includes(offer.priceLabel), 'price and period');
      assert.match(text, /auto-renewing subscription/);
      assert.match(text, /renews automatically every (month|year)/);
      assert.match(text, /at least 24 hours before the end of the current period/);
      assert.match(text, /charged to your (Apple ID|Google Play account)/);
      assert.match(text, /Manage or cancel any time/);
      assert.match(text, /keep access until the end of the period/);
      assert.match(text, /no free trial/);
      assert.match(text, /never gives APM permission to act/);
      if (offer.founding) assert.match(text, /If it lapses, the founding price ends/);
      if (offer.plan === 'chief_of_staff' && offer.period === 'monthly' && !offer.founding) assert.match(text, /first 3 months/);
    }
  }
  assert.equal(catalog.storeManageUrl('app_store'), 'https://apps.apple.com/account/subscriptions');
  assert.equal(catalog.storeManageUrl('google_play'), 'https://play.google.com/store/account/subscriptions?package=com.aplayermode.app');
});

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push([path, await readFile(path, 'utf8')]);
  }
  return out;
}

test('the app never reports a purchase to the API or decides Founding eligibility itself', async () => {
  const files = [...await sources(join(appDir, 'app')), ...await sources(join(appDir, 'src'))];
  const api = files.find(([path]) => path.endsWith('src/api/apmApi.ts'))[1];
  const billingRoutes = [...api.matchAll(/'\/v1\/billing\/[^']*'/g)].map((m) => m[0]);
  assert.deepEqual(billingRoutes, ["'/v1/billing/offering'", "'/v1/billing/reconcile'", "'/v1/billing/web/portal'", "'/v1/billing/precheckout/attach'"], 'the only billing routes the app calls are reconcile (server reads RevenueCat), the read-only offering, the web customer-portal link and the pay-first attach');
  // Attach (0096) carries ONLY the checkout id: never a plan, product or status; the server reads RevenueCat.
  assert.match(api, /request\('\/v1\/billing\/precheckout\/attach', accessToken, \{ method: 'POST', body: JSON\.stringify\(\{ checkoutId \}\) \}\)/);
  assert.equal([...api.matchAll(/\/v1\/billing\/precheckout\/attach/g)].length, 1, 'one attach call site');
  // Reconcile carries NO purchase claim: an empty body; the server asks RevenueCat about the session user.
  assert.match(api, /'\/v1\/billing\/reconcile', accessToken, \{ method: 'POST', body: '\{\}' \}\)/);
  assert.equal([...api.matchAll(/\/v1\/billing\/reconcile/g)].length, 1, 'one call site, and it is the empty-body one');
  assert.doesNotMatch(api, /fetchBillingOffering[^}]*method:/s, 'and it is a GET');
  assert.doesNotMatch(api, /fetchWebBillingPortal[^}]*method:/s, 'the portal link is a GET too');
  for (const [path, text] of files) {
    assert.doesNotMatch(text, /subscription_entitlements/, `${path} never touches the entitlement table`);
    assert.doesNotMatch(text, /apm_service_billing/, `${path} never names a service billing function`);
    assert.doesNotMatch(text, /customerInfo\.entitlements|entitlements\.active/, `${path} never treats the SDK's entitlements as truth`);
  }
  // ONE paywall component serves Settings and the onboarding plan choice (docs/34 §9).
  const paywall = files.find(([path]) => path.endsWith('src/billing/PlanChoice.tsx'))[1];
  assert.match(paywall, /loadOffering\(offering\.offeringId\)/, 'the paywall loads exactly the offering the server named');
  assert.doesNotMatch(paywall, /loadOffering\('founding'\)|foundingOffering/, 'never picks the founding offering itself');
  assert.match(paywall, /subscriptionDisclosure\(/, 'the store disclosures are on the paywall');
  assert.match(paywall, /Restore purchases/, 'Restore is on the paywall');
  // Web has no store: the paywall says where to subscribe, and shows no buy or Restore button that cannot work.
  const purchasesSource = files.find(([path]) => path.endsWith('src/billing/purchases.ts'))[1];
  // Web and the sideload APK pay by card (docs/33 §9): never sent to a store app.
  assert.match(purchasesSource, /web: 'Plans are paid by card here\./, 'web says how to subscribe');
  assert.match(purchasesSource, /sideload: 'Plans are paid by card in this version of the app\./);
  assert.doesNotMatch(purchasesSource, /Subscribe in the iPhone or Android app/);
  assert.match(purchasesSource, /if \(appDistribution\(\) === 'sideload'\) return \{ available: false, reason: 'sideload' \};/, 'the sideload APK never uses store billing, by flag (not by a missing key)');
  assert.match(paywall, /\{availability\.available \? <Button label=\{busy === 'restore'/, 'Restore renders only where a store exists');
  assert.match(paywall, /\{!isCurrent && availability\.available \? \(/, 'buy buttons render only where a store exists');
  assert.match(paywall, /\{!isCurrent && cardCheckout\.kind === 'ready' && !storeSubscriberHere \? \(/, 'card buttons render only where card checkout is ready (never a store build)');
  assert.match(paywall, /const cardCheckout = webCheckoutFor\(distribution, founding\);/, 'card checkout is decided by the build distribution and the SERVER founding decision');
  for (const user of ['app/settings/plan.tsx', 'app/intake.tsx']) {
    const text = files.find(([path]) => path.endsWith(user))?.[1] ?? '';
    assert.match(text, /<PlanChoice\b/, `${user} renders the shared paywall`);
    assert.doesNotMatch(text, /loadOffering|buyPackage/, `${user} never runs its own purchase path`);
  }
  const purchases = files.find(([path]) => path.endsWith('src/billing/purchases.ts'))[1];
  assert.match(purchases, /appUserID: userId/, 'RevenueCat app user id = Supabase user id');
  assert.match(purchases, /Purchases\.logOut\(\)/, 'forgotten on sign-out');
});

// Outage (brief: "RevenueCat or Play unreachable -> plans shown unavailable, never free unlock, never crash").
test('a store that throws, hangs, has no such offering or no packages is "unavailable" with its true cause logged, never ready', async () => {
  const lines = []; const log = (line) => lines.push(line);
  const load = (fn) => catalog.loadStoreOffering(fn, 50, log);
  const ready = { availablePackages: [{ identifier: 'cos_monthly' }] };
  assert.deepEqual(await load(async () => ready), { state: 'ready', offering: ready });
  assert.deepEqual(lines, [], 'a ready store logs nothing');
  // RevenueCat's PurchasesError carries the store's code (react-native-purchases PURCHASES_ERROR_CODE).
  const rcError = (code, readable, underlying) => Object.assign(new Error('There was a problem with the store.'), { code, underlyingErrorMessage: underlying, userInfo: { readableErrorCode: readable } });
  assert.deepEqual(await load(async () => { throw rcError('3', 'PURCHASE_NOT_ALLOWED_ERROR', 'BILLING_UNAVAILABLE: Google Play account not signed in'); }), { state: 'unavailable', fault: 'not_allowed', code: '3' }, 'Play billing unavailable / not signed in');
  assert.match(lines.at(-1), /^\[apm-billing\] store plans unavailable: fault=not_allowed code=3 PURCHASE_NOT_ALLOWED_ERROR \| .*BILLING_UNAVAILABLE/, 'the code and Play\'s own words reach logcat');
  assert.deepEqual(await load(async () => { throw rcError('10', 'NETWORK_ERROR'); }), { state: 'unavailable', fault: 'network', code: '10' });
  assert.deepEqual(await load(async () => { throw rcError('35', 'OFFLINE_CONNECTION_ERROR'); }), { state: 'unavailable', fault: 'network', code: '35' });
  assert.deepEqual(await load(async () => { throw rcError('2', 'STORE_PROBLEM_ERROR', 'SERVICE_UNAVAILABLE'); }), { state: 'unavailable', fault: 'store', code: '2' });
  assert.deepEqual(await load(async () => { throw rcError('23', 'CONFIGURATION_ERROR'); }), { state: 'unavailable', fault: 'not_set_up', code: '23' });
  assert.deepEqual(await load(async () => { throw rcError('99', 'SOMETHING_NEW'); }), { state: 'unavailable', fault: 'unknown', code: '99' }, 'an unmapped code is unknown, never ready');
  assert.deepEqual(await load(async () => { throw new Error('no code at all'); }), { state: 'unavailable', fault: 'unknown' });
  assert.match(lines.at(-1), /fault=unknown code=none no code at all/);
  assert.deepEqual(await load(() => new Promise(() => {})), { state: 'unavailable', fault: 'timeout' }, 'a store that never answers times out');
  assert.match(lines.at(-1), /fault=timeout code=none no answer in 50 ms/);
  assert.deepEqual(await load(async () => undefined), { state: 'unavailable', fault: 'not_set_up' }, 'offering missing in RevenueCat');
  assert.deepEqual(await load(async () => ({ availablePackages: [] })), { state: 'unavailable', fault: 'not_set_up' }, 'no products came back from Play');
  assert.equal(lines.length, 10, 'every unavailable answer is logged once');
  assert.equal(catalog.STORE_ANSWER_MS, 15_000);
});

test('the outage card tells the truth for each cause', () => {
  const copy = (fault, code, store = 'google_play') => catalog.storeUnavailableCopy(store, fault, code);
  assert.match(copy('not_allowed', '3'), /^Google Play can't take payments on this phone yet\. Open the Play Store app and sign in with your Google account, then tap Try again\./);
  assert.match(copy('not_allowed', '3', 'app_store'), /Screen Time/);
  assert.match(copy('network', '10'), /^This phone can't reach Google Play right now\. Check your internet connection/);
  assert.match(copy('not_set_up', '23'), /^Plans can't be bought in this version of the app yet\./);
  assert.match(copy('store', '2'), /^Google Play is not answering right now/);
  assert.match(copy('timeout'), /^Google Play is not answering right now/);
  assert.match(copy('unknown', '99'), /^Google Play could not load the plans \(error 99\)\./);
  for (const fault of ['not_allowed', 'network', 'store', 'not_set_up', 'timeout', 'unknown']) {
    assert.match(copy(fault, '1'), /Nothing was charged and your setup is saved\./, `${fault}: says nothing was charged`);
    assert.doesNotMatch(copy(fault, '1'), /free|unlocked/i, `${fault}: never implies a free unlock`);
  }
  assert.equal(new Set(['not_allowed', 'network', 'store', 'not_set_up', 'unknown'].map((f) => copy(f, '7'))).size, 5, 'each cause has its own words');
});

test('when the store is unavailable the buy buttons say so and the paywall shows the outage card with Try again', async () => {
  const base = { available: true, isAnonymous: false, legalReady: true, planLoadFailed: false, hasPackage: true };
  assert.equal(catalog.buyBlockedReason({ ...base, store: 'unavailable', hasPackage: false }), 'Not available right now. Tap Try again above.');
  assert.equal(catalog.buyBlockedReason({ ...base, store: 'loading', hasPackage: false }), 'Getting prices from the store…');
  assert.equal(catalog.buyBlockedReason({ ...base, store: 'ready' }), undefined);
  assert.equal(catalog.buyBlockedReason({ ...base, store: 'ready', hasPackage: false }), 'This plan is not in the store yet. Pick another or decide later.');
  const paywall = await readFile(join(appDir, 'src/billing/PlanChoice.tsx'), 'utf8');
  assert.match(paywall, /loadStoreOffering\(async \(\) => \{ await identifyBillingUser\(user\.id\); return loadOffering\(offering\.offeringId\); \}\)/, 'identify + load go through the timeout/empty guard together');
  assert.match(paywall, /storeLoad === 'unavailable' \? <Card tone="warning"><Body>\{storeUnavailableCopy\(availability\.store, storeFault\.fault, storeFault\.code\)\}<\/Body><Button label="Try again"/, 'the outage card renders with a retry');
  assert.match(paywall, /store: storeLoad/, 'buy buttons get the store state');
  assert.match(paywall, /Boolean\(storeOffering\)/, 'buying stays disabled without a ready offering');
  assert.match(paywall, /distribution === 'store' \? storePrices\(storeOffering\) : cardPrices\(founding\)/, 'a store build prices from the store alone');
});
