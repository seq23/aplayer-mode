// The first-run experience (docs/34): the selling copy and the paywall offer, pinned against
// the ONE sources of truth (@apm/policy prices, @apm/domain Track names), and the build rules
// that only the code can show (one setup route, swipe-back off, Android back handled,
// synchronous device writes, Apple on iOS only, dead onboarding screens gone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
let outDir; let sell; let policy; let domain; let catalog;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-first-run-'));
  await build({
    entryPoints: {
      sell: join(appDir, 'src/content/sell.ts'),
      catalog: join(appDir, 'src/billing/catalog.ts'),
      policy: fileURLToPath(new URL('../../../packages/policy/src/index.ts', import.meta.url)),
      domain: fileURLToPath(new URL('../../../packages/domain/src/index.ts', import.meta.url)),
    },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  sell = await import(pathToFileURL(join(outDir, 'sell.js')).href);
  policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
  domain = await import(pathToFileURL(join(outDir, 'domain.js')).href);
  catalog = await import(pathToFileURL(join(outDir, 'catalog.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const usd = (cents) => policy.formatUsdCents(cents);

test('the welcome page states the starting price and its terms beside Start; the grids and the higher tiers live on the plan screen', () => {
  assert.equal(sell.WELCOME_TIERS_TEASER.line, 'Executive Roundtable plans and coaches you · Executive Suite acts when you tap yes · Autopilot handles it inside your rules');
  assert.equal(sell.WELCOME_TIERS_TEASER.line, ['chief_of_staff', 'life_os', 'autopilot'].map((p) => `${policy.PLAN_PRICES[p].displayName} ${policy.PLAN_PRICES[p].tagline}`).join(' · '), 'derived from PLAN_PRICES');
  assert.deepEqual(sell.tierGridWho(catalog.NO_PRICES).columns, ['Executive Roundtable', 'Executive Suite', 'Autopilot']);
  const welcome = sell.welcomeText('web');
  // Price up front (owner review 14 Nov 2026; Apple 3.1.2). A card build (web, sideload) charges the
  // policy USD, so it states the intro price, its length, the price after it, no free trial.
  const intro = usd(policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents);
  const after = usd(policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory.thenMonthlyUsdCents);
  for (const distribution of ['web', 'sideload']) {
    const price = sell.welcomePrice(distribution);
    assert.equal(price.offer, `Introductory offer: start at ${intro}/month`);
    for (const line of [price.short, price.line]) {
      assert.ok(line.includes(`${intro}/month`) && line.includes(`${after}/month`), line);
      assert.ok(line.includes(`${policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory.months} months`), 'the intro length');
      assert.match(line, /No free trial/i);
      assert.match(line, /Cancel any time/);
      assert.doesNotMatch(line, /was |save \d+%/i, 'never a struck or "save" price');
    }
  }
  // A store build (App Store, Google Play) states no fixed figure before sign-in: the store's own
  // price, in the buyer's currency, is on the plans screen. The terms stay: intro length, no trial, cancel.
  const store = sell.welcomePrice('store');
  for (const line of [store.short, store.line, store.offer]) {
    assert.doesNotMatch(line, /[$€£¥]\s?\d|\d[.,]\d\d/, `no fixed price on a store build: ${line}`);
    assert.match(line, /3-month intro/, 'the intro offer and its length');
  }
  for (const line of [store.short, store.line]) {
    assert.match(line, /No free trial/i);
    assert.match(line, /Cancel any time/);
    assert.match(line, /plans screen/, 'says where the price is');
  }
  assert.doesNotMatch(sell.welcomeText('store'), /\$\d/, 'nothing on the store welcome page names a US price');
  for (const plan of ['life_os', 'autopilot']) {
    assert.ok(!welcome.includes(usd(policy.PLAN_PRICES[plan].monthlyUsdCents)), `no ${plan} price on the welcome page`);
  }
  assert.ok(!welcome.includes(sell.tierGridWho(catalog.NO_PRICES).title) && !welcome.includes(sell.TIER_GRID_WHAT.title), 'no grids on the welcome page');
  assert.ok(!/Founding 100/.test(welcome), 'never the bare "Founding 100"');
  // Claims (spry brain, risk R-ADV-05, R-PRF-03): no unprovable statements about billionaires or
  // elite performers, no implied equivalence to hired people, no implied results; the page ends with the disclaimer.
  assert.doesNotMatch(welcome, /Billionaires do|Elite performers|people you would hire|already works|regulated the day|You stop /, 'no unprovable or outcome claim on the welcome page');
  assert.match(sell.WELCOME_LEGAL, /not guarantees/);
  assert.match(sell.WELCOME_LEGAL, /not medical, financial or mental-health advice/);
  const plan = sell.planScreenText(catalog.cardPrices(false));
  for (const p of ['chief_of_staff', 'life_os', 'autopilot']) {
    assert.ok(plan.includes(usd(policy.PLAN_PRICES[p].monthlyUsdCents)), `${p} monthly`);
    assert.ok(plan.includes(usd(policy.PLAN_PRICES[p].annualUsdCents)), `${p} annual`);
  }
  assert.equal(sell.tierGridWho(catalog.cardPrices(false)).rows.length, 5);
  assert.equal(sell.TIER_GRID_WHAT.rows.length, 8);
  assert.match(sell.PLAN_SCREEN.annualLine, /2 months free/);
  assert.match(sell.PLAN_SCREEN.autonomyLine, /never grants autonomy/);
  assert.equal(sell.recommendedTier(['parent', 'founder']), 'life_os');
  assert.equal(sell.recommendedTier(['founder']), 'chief_of_staff');
});

test('the introductory offer reads as a promotion in both states; scarcity is the server number or nothing', () => {
  const intro = usd(policy.CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents);
  const list = usd(policy.PLAN_PRICES.chief_of_staff.monthlyUsdCents);
  const card = catalog.cardPrices(true); const cardStd = catalog.cardPrices(false);
  const founding = sell.offerBanner({ founding: true, spotsLeft: 37, prices: card });
  assert.equal(founding.kind, 'founding');
  assert.equal(founding.ribbon, 'Introductory offer');
  assert.equal(founding.headline, 'Founding Member price');
  assert.equal(founding.now, `${intro}/month`);
  assert.equal(founding.regular, `Regular price after the first 100 members: ${list}/month`);
  assert.equal(founding.explain, `For our first 100 members only. ${intro}/month, locked while you stay subscribed.`);
  assert.equal(founding.scarcity, '37 of 100 spots left');
  const unknown = sell.offerBanner({ founding: true, spotsLeft: null, prices: card });
  assert.equal(unknown.kind, 'founding');
  assert.equal(unknown.scarcity, undefined, 'count unavailable → hidden, never invented');
  for (const fallback of [sell.offerBanner({ founding: false, spotsLeft: 12, prices: cardStd }), sell.offerBanner({ founding: true, spotsLeft: 0, prices: card })]) {
    assert.equal(fallback.kind, 'introductory');
    assert.equal(fallback.ribbon, 'Introductory offer');
    assert.equal(fallback.headline, `${intro}/month for your first 3 months, then ${list}`);
    assert.equal(fallback.regular, `Regular price from month 4: ${list}/month`);
    assert.equal(fallback.scarcity, undefined);
  }
  // 16 CFR 233.1: the standard price has not yet been the live price, so it is never shown as a struck
  // "former" price and there is no "Save N%" against it, in any state of the banner.
  for (const banner of [founding, unknown, sell.offerBanner({ founding: false, prices: cardStd }), sell.offerBanner({ founding: true, spotsLeft: 0, prices: card })]) {
    assert.equal(banner.was, undefined);
    assert.equal(banner.saving, undefined);
    assert.doesNotMatch(JSON.stringify(banner), /save \d+%|instead of|was \$/i);
  }
  // docs/36 H4: the ribbon and the headline sit one above the other; the words are never said twice.
  for (const banner of [founding, unknown, sell.offerBanner({ founding: false, prices: cardStd })]) {
    assert.ok(!banner.headline.toLowerCase().includes(banner.ribbon.toLowerCase()), `"${banner.ribbon}" is not repeated in "${banner.headline}"`);
  }
});

test('on a store build the plan screen shows only Google Play\'s prices, and none at all while Play is unknown', () => {
  const pkg = (identifier, priceString, intro) => ({ identifier, product: { priceString, introPrice: intro ? { priceString: intro } : null } });
  const std = [pkg('cos_monthly', '£19.99', '£7.99'), pkg('lifeos_monthly', '£31.99'), pkg('autopilot_monthly', '£63.99'), pkg('cos_annual', '£199.99'), pkg('lifeos_annual', '£319.99'), pkg('autopilot_annual', '£639.99')];
  const play = catalog.storePrices({ availablePackages: std, standardPackages: std });
  const text = sell.planScreenText(play);
  for (const price of ['£19.99', '£31.99', '£63.99', '£199.99', '£319.99', '£639.99', '£7.99']) assert.ok(text.includes(price), `${price} from Play`);
  assert.doesNotMatch(text, /\$\d/, 'no US price beside Play\'s');
  assert.equal(sell.offerBanner({ founding: false, prices: play }).headline, '£7.99/month for your first 3 months, then £19.99');
  const foundingPlay = catalog.storePrices({ availablePackages: [pkg('cos_monthly', '£7.99'), ...std.slice(1)], standardPackages: std });
  assert.equal(sell.offerBanner({ founding: true, spotsLeft: 5, prices: foundingPlay }).now, '£7.99/month');
  // Play unknown (loading or outage): no price anywhere on the plan screen, no banner, the grid loses its price rows.
  for (const unknown of [catalog.NO_PRICES, catalog.storePrices(undefined)]) {
    for (const founding of [false, true]) {
      const blank = sell.planScreenText(unknown, founding);
      assert.doesNotMatch(blank, /\$\d|£\d|€\d|\d\.\d\d/, `founding=${founding}: no price while Play is unknown`);
      assert.equal(sell.offerBanner({ founding, spotsLeft: 5, prices: unknown }), undefined);
    }
    assert.equal(sell.tierGridWho(unknown).rows.length, 3);
  }
  // One plan with no Play monthly price: that row goes rather than mix a known and an unknown price.
  const gap = sell.tierGridWho(catalog.storePrices({ availablePackages: std.slice(1), standardPackages: std.slice(1) }));
  assert.deepEqual(gap.rows.map((r) => r.label).slice(3), ['Annual (2 months free)']);
});

const read = (rel) => readFile(join(appDir, rel), 'utf8');

test('one setup route: no header, no swipe-back, Android back handled; dead onboarding screens are gone', async () => {
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /name="intake" options=\{\{ headerShown: false, gestureEnabled: false/);
  const intake = await read('app/intake.tsx');
  assert.match(intake, /BackHandler\.addEventListener\('hardwareBackPress'/);
  assert.match(intake, /Leave setup\?/);
  assert.match(intake, /<PlanChoice\b/, 'the paywall sits on the setup path, after the summary');
  for (const gone of ['app/onboarding.tsx', 'app/sign-in.tsx', 'app/privacy-primer.tsx']) {
    await assert.rejects(access(join(appDir, gone)), `${gone} is deleted`);
  }
  const all = [layout, intake, await read('app/index.tsx'), await read('app/(tabs)/_layout.tsx'), await read('app/(tabs)/today.tsx')].join('\n');
  assert.doesNotMatch(all, /\/onboarding'|\/sign-in'|\/privacy-primer'/, 'no route points at a deleted screen');
});

test('answers hit the device synchronously on native; web storage never crashes; Apple only on iOS; no vendor names in user copy', async () => {
  const native = await read('src/intake/storage.native.ts');
  assert.match(native, /expo-sqlite\/kv-store/);
  assert.match(native, /setItemSync/);
  const web = await read('src/intake/storage.ts');
  assert.doesNotMatch(web, /from 'expo-sqlite/, 'the web build never loads the native store');
  assert.match(web, /try \{/);
  const account = await read('src/components/intake/AccountPanel.tsx');
  // Apple only on iOS: the panel renders Apple from signInOptions, which offers it on iOS alone.
  assert.match(account, /options\.includes\('apple'\) \? <AppleButton/);
  assert.match(await read('src/auth/signInOptions.ts'), /platform === 'ios' \? \(\['apple'\] as const\)/);
  assert.match(account, /textContentType="oneTimeCode"/);
  const session = await read('src/state/session.tsx');
  assert.match(session, /signInAnonymously/);
  assert.match(session, /email_change/);
  assert.match(session, /mergeAnonymousIntakeDraft/);
  for (const rel of ['app/welcome.tsx', 'app/intake.tsx', 'src/components/intake/AccountPanel.tsx', 'src/content/sell.ts']) {
    const text = await read(rel);
    const strings = [...text.matchAll(/'([^'\n]{12,})'|"([^"\n]{12,})"|>([^<>{}\n]{12,})</g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const s of strings) assert.doesNotMatch(s, /Supabase|Cloudflare|RevenueCat|OpenRouter/, `${rel}: "${s}" names a vendor`);
  }
});
