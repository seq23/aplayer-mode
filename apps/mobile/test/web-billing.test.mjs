// Card checkout (RevenueCat Web Billing; docs/33 §9) and the store-build exclusion (App Store 3.1.1):
//   * distribution: iOS is ALWAYS a store build; Android is sideload only with the explicit flag; web is web;
//   * web checkout is reachable for web + sideload and unreachable for store — with links configured or not;
//   * the Web Purchase Link carries the signed-in user id (URL-encoded) and pre-selects the package;
//   * not configured = a calm "open shortly" state; a founding user never gets the default (higher) link;
//   * the iOS bundle of the paywall contains no web checkout at all (Metro's .ios.ts resolution);
//   * presubmit:ios fails when the iOS stub holds a link or an EAS profile sets a non-store flag;
//   * the build scripts set the flag: APK = sideload, web deploy = web, EAS = store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const run = promisify(execFile);
const appDir = fileURLToPath(new URL('../', import.meta.url));
const repoDir = join(appDir, '../..');
const USER = '00000000-0000-4000-8000-0000000000aa';
const LINK = 'https://pay.rev.cat/abcDEF123';
const FOUNDING_LINK = 'https://pay.rev.cat/foundXYZ789';
let outDir; let dist; let checkout; let access; let envHelper;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-web-billing-'));
  await build({
    entryPoints: { distribution: join(appDir, 'src/billing/distribution.ts'), checkout: join(appDir, 'src/billing/webCheckout.ts'), access: join(appDir, 'src/billing/access.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent', packages: 'external',
  });
  dist = await import(pathToFileURL(join(outDir, 'distribution.js')).href);
  checkout = await import(pathToFileURL(join(outDir, 'checkout.js')).href);
  access = await import(pathToFileURL(join(outDir, 'access.js')).href);
  envHelper = await import(pathToFileURL(join(appDir, 'scripts/web-billing-env.mjs')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('distribution: iOS is always store; Android is sideload only with the flag; web is web', () => {
  for (const flag of [undefined, '', 'store', 'sideload', 'web', 'SIDELOAD']) {
    assert.equal(dist.resolveDistribution('ios', flag), 'store', `ios + ${flag}`);
    assert.equal(dist.resolveDistribution('web', flag), 'web', `web + ${flag}`);
    assert.equal(dist.resolveDistribution('android', flag), flag === 'sideload' ? 'sideload' : 'store', `android + ${flag}`);
  }
  assert.equal(dist.resolveDistribution('windows', 'sideload'), 'store', 'unknown platforms fail closed');
  assert.deepEqual(['store', 'sideload', 'web'].map(dist.webCheckoutAllowed), [false, true, true]);
});

test('web checkout: reachable for web + sideload, unreachable for store (links or not)', () => {
  const links = { default: LINK, founding: FOUNDING_LINK };
  for (const founding of [false, true]) {
    assert.deepEqual(checkout.webCheckoutFor('store', founding, links), { kind: 'unavailable' }, 'a store build never gets a checkout');
    assert.deepEqual(checkout.webCheckoutFor('store', founding, {}), { kind: 'unavailable' });
  }
  for (const d of ['web', 'sideload']) {
    assert.deepEqual(checkout.webCheckoutFor(d, false, {}), { kind: 'not_configured' });
    const ready = checkout.webCheckoutFor(d, false, links);
    assert.equal(ready.kind, 'ready');
    assert.equal(ready.urlFor('cos_monthly', USER), `${LINK}/${USER}?package_id=cos_monthly`);
    assert.equal(checkout.webCheckoutFor(d, true, links).urlFor('cos_monthly', USER), `${FOUNDING_LINK}/${USER}?package_id=cos_monthly`, 'founding uses the founding offering link');
    assert.deepEqual(checkout.webCheckoutFor(d, true, { default: LINK }), { kind: 'not_configured' }, 'never the default (higher) link for a founding user');
    assert.deepEqual(checkout.webCheckoutFor(d, false, { default: 'http://pay.rev.cat/x' }), { kind: 'not_configured' }, 'https only');
    assert.deepEqual(checkout.webCheckoutFor(d, false, { default: 'javascript:alert(1)' }), { kind: 'not_configured' });
  }
  // The app user id is URL-encoded; a malformed package or empty user builds nothing.
  assert.equal(checkout.webPurchaseUrl(`${LINK}/`, 'autopilot_annual', 'a b/c'), `${LINK}/a%20b%2Fc?package_id=autopilot_annual`);
  assert.equal(checkout.webPurchaseUrl(LINK, 'cos monthly', USER), undefined);
  assert.equal(checkout.webPurchaseUrl(LINK, 'cos_monthly', ''), undefined);
  // The calm unconfigured copy is a sentence, never a placeholder (App Review 2.1, presubmit).
  assert.match(checkout.WEB_CHECKOUT_COPY.notConfigured, /^Card payments open shortly\./);
  assert.ok(!/coming soon/i.test(Object.values(checkout.WEB_CHECKOUT_COPY).join(' ')));
});

test('no-plan copy for web / sideload never sends people to a store app', () => {
  const card = access.noPlanCopy(true);
  assert.ok(!/iPhone|Android|App Store|Google Play|store/i.test(Object.values(card).join(' ')), JSON.stringify(card));
  assert.equal(card.action, 'See plans');
});

async function bundlePaywall(resolveExtensions) {
  const result = await build({
    entryPoints: [join(appDir, 'src/billing/PlanChoice.tsx')], bundle: true, write: false, format: 'esm', platform: 'neutral',
    packages: 'external', jsx: 'automatic', logLevel: 'silent', resolveExtensions,
    define: { 'process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL': JSON.stringify(LINK), 'process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING': JSON.stringify(FOUNDING_LINK) },
  });
  return result.outputFiles[0].text;
}

test('the iOS paywall bundle contains no web checkout; the web/Android bundle does (Metro .ios.ts resolution)', async () => {
  const ios = await bundlePaywall(['.ios.tsx', '.ios.ts', '.native.tsx', '.native.ts', '.tsx', '.ts', '.js']);
  const web = await bundlePaywall(['.web.tsx', '.web.ts', '.tsx', '.ts', '.js']);
  for (const marker of ['pay.rev.cat', 'package_id', 'Pay by card', 'Card payments open shortly']) {
    assert.ok(!ios.includes(marker), `iOS bundle must not contain ${marker}`);
    assert.ok(web.includes(marker), `web bundle carries ${marker} (proves the check can see it)`);
  }
});

test('presubmit:ios fails when the iOS stub holds a link, the stub is missing, or EAS sets a non-store flag', async () => {
  const work = await mkdtemp(join(tmpdir(), 'apm-presubmit-'));
  const presubmit = join(repoDir, 'scripts/presubmit-ios.mjs');
  try {
    const fresh = async () => {
      await rm(join(work, 'm'), { recursive: true, force: true });
      for (const part of ['app', 'src', 'app.json', 'package.json', 'eas.json']) await cp(join(appDir, part), join(work, 'm', part), { recursive: true });
      return join(work, 'm');
    };
    const verdict = async (dir) => run('node', [presubmit, dir]).then(() => 'pass', (error) => String(error.stderr));
    assert.equal(await verdict(await fresh()), 'pass', 'the real tree passes');

    let dir = await fresh();
    await writeFile(join(dir, 'src/billing/webCheckout.ios.ts'), "export const x = process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL;\n");
    assert.match(await verdict(dir), /iOS stub must hold no web checkout/);

    dir = await fresh();
    await rm(join(dir, 'src/billing/webCheckout.ios.ts'));
    assert.match(await verdict(dir), /webCheckout\.ios\.ts missing/);

    dir = await fresh();
    const eas = JSON.parse(await readFile(join(dir, 'eas.json'), 'utf8'));
    eas.build.production.env.EXPO_PUBLIC_APM_DISTRIBUTION = 'sideload';
    await writeFile(join(dir, 'eas.json'), JSON.stringify(eas));
    assert.match(await verdict(dir), /must be "store" in an EAS build/);

    dir = await fresh();
    await writeFile(join(dir, 'src/billing/sneaky.ts'), "export { webCheckoutFor } from './webCheckout.ts';\nexport const y = process.env.EXPO_PUBLIC_RC_WEB_PURCHASE_URL;\n");
    const out = await verdict(dir);
    assert.match(out, /import webCheckout extension-less/);
    assert.match(out, /Web Purchase Link is read only in/);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('build flags: APK = sideload, web deploy = web, every EAS profile with env = store; links validated', async () => {
  const apk = await readFile(join(repoDir, 'scripts/build-android-apk.sh'), 'utf8');
  const web = await readFile(join(repoDir, 'scripts/deploy-web-production.sh'), 'utf8');
  assert.match(apk, /^export EXPO_PUBLIC_APM_DISTRIBUTION="sideload"$/m);
  assert.match(apk, /^unset EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY$/m);
  // Every sideload APK installs over the last one (a versionCode that only goes up) and names its source SHA.
  assert.match(apk, /^APM_ANDROID_VERSION_CODE="\$\{APM_ANDROID_VERSION_CODE:-\$\(git rev-list --count HEAD\)\}"$/m);
  assert.match(apk, /-\$\(git rev-parse --short=7 HEAD\)"$/m);
  assert.match(apk, /if \(!g\.includes\(`versionCode \$\{code\}`\)\) throw new Error\('versionCode not set'\);/);
  assert.match(web, /^export EXPO_PUBLIC_APM_DISTRIBUTION="web"$/m);
  for (const script of [apk, web]) assert.match(script, /^eval "\$\(node scripts\/web-billing-env\.mjs\)"$/m);
  const eas = JSON.parse(await readFile(join(appDir, 'eas.json'), 'utf8'));
  for (const [name, profile] of Object.entries(eas.build)) if (profile.env) assert.equal(profile.env.EXPO_PUBLIC_APM_DISTRIBUTION, 'store', `eas ${name}`);
  // The committed link config holds both live Web Purchase Links (production pay.rev.cat links, never the
  // /sandbox/ ones, RUNBOOK step 7, 7 Oct 2026) and bad links are refused.
  const config = JSON.parse(await readFile(join(appDir, 'web-billing.json'), 'utf8'));
  const committed = envHelper.webBillingEnv(config, {});
  assert.deepEqual(Object.keys(committed), envHelper.NAMES);
  for (const name of envHelper.NAMES) {
    assert.match(committed[name], /^https:\/\/pay\.rev\.cat\/[a-z0-9]+\/$/, `${name} is a production Web Purchase Link`);
    assert.doesNotMatch(committed[name], /sandbox/, `${name} is not the sandbox link`);
  }
  assert.notEqual(committed.EXPO_PUBLIC_RC_WEB_PURCHASE_URL, committed.EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING, 'default and founding are different offerings');
  assert.deepEqual(envHelper.webBillingEnv({}, { EXPO_PUBLIC_RC_WEB_PURCHASE_URL: LINK }), { EXPO_PUBLIC_RC_WEB_PURCHASE_URL: LINK, EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING: '' });
  for (const bad of ['http://pay.rev.cat/x', 'https://evil.example/x', "https://pay.rev.cat/x';rm -rf /"]) {
    assert.throws(() => envHelper.webBillingEnv({ EXPO_PUBLIC_RC_WEB_PURCHASE_URL: bad }, {}), /not a RevenueCat Web Purchase Link/);
  }
});

test('a missed webhook never strands a card buyer: /billing/return and "I already paid" ask the server to reconcile from RevenueCat', async () => {
  const api = await readFile(join(appDir, 'src/api/apmApi.ts'), 'utf8');
  assert.match(api, /export async function reconcileBilling\(accessToken: string\)[\s\S]{0,200}'\/v1\/billing\/reconcile', accessToken, \{ method: 'POST', body: '\{\}' \}/, 'the request names nothing about the purchase');
  const ret = await readFile(join(appDir, 'app/billing/return.tsx'), 'utf8');
  assert.match(ret, /RECONCILE_ATTEMPTS\.has\(attempt\)\) await reconcileBilling\(accessToken\)/);
  const attempts = [...ret.match(/new Set\(\[([\d, ]+)\]\)/)[1].split(',').map(Number)];
  assert.ok(attempts.includes(0), 'reconcile on the first poll');
  // Never more than the API's 6-per-minute limit within the 15 x 2 s poll window.
  assert.ok(attempts.length <= 6 && attempts.every((n) => n >= 0 && n < 15), JSON.stringify(attempts));
  const plan = await readFile(join(appDir, 'src/billing/PlanChoice.tsx'), 'utf8');
  assert.match(plan, /const confirmCard = useCallback\(async \(\) => \{[\s\S]{0,300}await reconcileBilling\(accessToken\)/, 'back from the card checkout: reconcile first');
  assert.match(plan, /!availability\.available && cardPay && !isAnonymous \? <Button label=\{busy === 'reconcile' \? WEB_CHECKOUT_COPY\.confirming : WEB_CHECKOUT_COPY\.alreadyPaid\}/, 'web / sideload only: the "I already paid" button');
  assert.equal(checkout.WEB_CHECKOUT_COPY.alreadyPaid, 'I already paid · check my payment');
  // The iOS stub must not grow the button's copy into the store build.
  const ios = await readFile(join(appDir, 'src/billing/webCheckout.ios.ts'), 'utf8');
  assert.doesNotMatch(ios, /reconcile/);
  assert.match(ios, /alreadyPaid: '', notFound: ''/, 'the iOS stub carries the keys, empty');
});
