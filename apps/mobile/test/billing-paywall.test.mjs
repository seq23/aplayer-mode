// The paywall's pure logic (src/billing/catalog.ts) and the client trust boundary:
//   * tier cards show exactly the ADR-0004 / ADR-0005 prices (store price wins when known);
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

test('tier cards carry exactly the decided prices for each period', () => {
  const monthly = catalog.tierOffers('monthly', false);
  assert.deepEqual(monthly.map((o) => [o.plan, o.priceLabel, o.packageId, o.founding]), [
    ['chief_of_staff', '$24.99/month', 'cos_monthly', false],
    ['life_os', '$39.99/month', 'lifeos_monthly', false],
    ['autopilot', '$79.99/month', 'autopilot_monthly', false],
  ]);
  assert.equal(monthly[0].note, 'New subscribers: $9.99/month for the first 3 months, then $24.99/month.');
  const annual = catalog.tierOffers('annual', false);
  assert.deepEqual(annual.map((o) => [o.plan, o.priceLabel, o.packageId]), [
    ['chief_of_staff', '$249.99/year', 'cos_annual'],
    ['life_os', '$399.99/year', 'lifeos_annual'],
    ['autopilot', '$799.99/year', 'autopilot_annual'],
  ]);
  for (const o of annual) assert.match(o.note, /^2 months free/);
  // The store's localized price wins.
  const localized = catalog.tierOffers('monthly', false, { cos_monthly: { priceString: '24,99 €', introPriceString: '9,99 €' } });
  assert.equal(localized[0].priceLabel, '24,99 €/month');
  assert.equal(localized[0].note, 'New subscribers: 9,99 €/month for the first 3 months, then 24,99 €/month.');
});

test('Founding 100 shows only on the server\'s word, only on Executive Roundtable monthly', () => {
  const founding = catalog.tierOffers('monthly', true);
  assert.deepEqual(founding.map((o) => o.founding), [true, false, false]);
  assert.equal(founding[0].priceLabel, '$9.99/month');
  assert.match(founding[0].note, /continuously subscribed/);
  assert.deepEqual(catalog.tierOffers('annual', true).map((o) => o.founding), [false, false, false], 'never on annual');
});

test('the disclosure states everything the stores require', () => {
  for (const store of ['app_store', 'google_play']) {
    for (const offer of [...catalog.tierOffers('monthly', false), ...catalog.tierOffers('annual', false), catalog.tierOffers('monthly', true)[0]]) {
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
  assert.deepEqual(billingRoutes, ["'/v1/billing/offering'"], 'the only billing route the app calls is the read-only offering');
  assert.doesNotMatch(api, /fetchBillingOffering[^}]*method:/s, 'and it is a GET');
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
  for (const user of ['app/settings/plan.tsx', 'app/intake.tsx']) {
    const text = files.find(([path]) => path.endsWith(user))?.[1] ?? '';
    assert.match(text, /<PlanChoice\b/, `${user} renders the shared paywall`);
    assert.doesNotMatch(text, /loadOffering|buyPackage/, `${user} never runs its own purchase path`);
  }
  const purchases = files.find(([path]) => path.endsWith('src/billing/purchases.ts'))[1];
  assert.match(purchases, /appUserID: userId/, 'RevenueCat app user id = Supabase user id');
  assert.match(purchases, /Purchases\.logOut\(\)/, 'forgotten on sign-out');
});
