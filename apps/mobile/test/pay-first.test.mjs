// Pay first, account after (docs/33 §10), testimonials, and the plan emphasis:
//   * "Join the Founding 100 — $9.99/month" opens the FOUNDING Web Purchase Link with a random
//     checkout id as the RevenueCat app user id and the Executive Roundtable monthly package;
//   * web app only (never the APK, never a store build), 18+ first, then checkout, then the claim;
//   * the return page claims the checkout BEFORE sending the sign-in code, and the paywall is
//     skipped for a buyer who already paid;
//   * testimonials come from ONE file (public/testimonials.json), need a consent record, and the
//     section renders nothing while the list is empty; aplayermode.com may read the file (CORS);
//   * Autopilot ($79.99) is never the recommended plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const src = (path) => readFile(join(appDir, path), 'utf8');
const FOUNDING_LINK = 'https://pay.rev.cat/lyamzdqnlkwrwwxt/';
let outDir; let pay; let quotes; let sell;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-pay-first-'));
  await build({
    entryPoints: { pay: join(appDir, 'src/billing/precheckout.ts'), quotes: join(appDir, 'src/content/testimonials.ts'), sell: join(appDir, 'src/content/sell.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  pay = await import(pathToFileURL(join(outDir, 'pay.js')).href);
  quotes = await import(pathToFileURL(join(outDir, 'quotes.js')).href);
  sell = await import(pathToFileURL(join(outDir, 'sell.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('the button: one label, the founding link, a random v4 checkout id, the Roundtable monthly package', () => {
  assert.equal(pay.JOIN_FOUNDING_LABEL, 'Join the Founding 100 — $9.99/month');
  assert.equal(pay.FOUNDING_PACKAGE_ID, 'cos_monthly');
  const ids = new Set(Array.from({ length: 200 }, () => pay.mintCheckoutId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const id = pay.mintCheckoutId();
  assert.equal(pay.foundingCheckoutUrl(id, FOUNDING_LINK), `https://pay.rev.cat/lyamzdqnlkwrwwxt/${id}?package_id=cos_monthly`);
  assert.equal(pay.foundingCheckoutUrl('not-a-uuid', FOUNDING_LINK), undefined);
  assert.equal(pay.foundingCheckoutUrl(id, undefined), undefined);
  assert.equal(pay.foundingCheckoutUrl(id, 'http://pay.rev.cat/x'), undefined);
});

test('the committed founding link is the one the button opens', async () => {
  const links = JSON.parse(await src('web-billing.json'));
  assert.equal(links.EXPO_PUBLIC_RC_WEB_PURCHASE_URL_FOUNDING, FOUNDING_LINK);
  const join = await src('app/join.tsx');
  assert.match(join, /foundingCheckoutUrl\(pending\.id, WEB_PURCHASE_LINKS\.founding\)/);
});

test('pending checkout: stored per browser, stale or malformed reads as none', () => {
  const now = 1_791_462_000_000;
  const id = pay.mintCheckoutId();
  assert.deepEqual(pay.parsePendingCheckout(JSON.stringify({ id, createdAt: now - 1000 }), now), { id, createdAt: now - 1000 });
  for (const raw of [null, '', 'x', '{}', JSON.stringify({ id: 'nope', createdAt: now }), JSON.stringify({ id, createdAt: now + 60_000 }), JSON.stringify({ id, createdAt: now - pay.PRECHECKOUT_MAX_AGE_MS - 1 })]) {
    assert.equal(pay.parsePendingCheckout(raw, now), undefined, String(raw));
  }
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(pay.pendingCheckout(now), undefined, 'reading never mints');
    const made = pay.pendingCheckout(now, true);
    assert.deepEqual(pay.pendingCheckout(now + 1000, true), made, 'the same browser keeps one checkout id');
    pay.clearPendingCheckout();
    assert.equal(pay.pendingCheckout(now), undefined);
  } finally { delete globalThis.localStorage; }
});

test('web app only: never the sideload APK, never a store build', async () => {
  assert.equal(pay.payFirstAllowed('web'), true);
  assert.equal(pay.payFirstAllowed('sideload'), false);
  assert.equal(pay.payFirstAllowed('store'), false);
  const welcome = await src('app/welcome.tsx');
  assert.match(welcome, /payFirst \? <Button label=\{JOIN_FOUNDING_LABEL\} large onPress=\{join\} \/> : null/);
  assert.match(welcome, /const join = \(\) => router\.push\('\/join'\)/);
  const join = await src('app/join.tsx');
  assert.match(join, /if \(!payFirstAllowed\(appDistribution\(\)\)\) \{ router\.replace\('\/'\); return; \}/);
  // 18+ comes before the checkout, and returns to it.
  assert.match(join, /if \(!ageConfirmed\) \{ router\.replace\(\{ pathname: '\/age', params: \{ next: 'join' \} \}\); return; \}/);
  assert.match(await src('app/age.tsx'), /next === 'join' \? router\.replace\('\/join'\) : router\.replace\('\/health-consent'\)/);
  // The iOS stub stays free of any checkout (App Store 3.1.1).
  assert.doesNotMatch(await src('src/billing/webCheckout.ios.ts'), /precheckout|pay\.rev\.cat/);
});

test('after paying: claim first, then the email code, then the setup questions; the paywall is skipped', async () => {
  const ret = await src('app/billing/return.tsx');
  const claimAt = ret.indexOf('await claimPrecheckout({ checkoutId: pending.id');
  const codeAt = ret.indexOf('await sendEmailCode(email);\n    setStage');
  assert.ok(claimAt > 0 && codeAt > claimAt, 'the account must exist (id = checkout id) before the code is sent');
  assert.match(ret, /clearPendingCheckout\(\);\n    router\.replace\(healthDecision \? '\/intake' : '\/health-consent'\)/);
  const api = await src('src/api/apmApi.ts');
  assert.match(api, /\/v1\/billing\/precheckout\/claim/);
  const plan = await src('src/billing/PlanChoice.tsx');
  assert.match(plan, /if \(onboarding && product && product\.entitlement\.plan !== 'beta' && hasDailyLoopAccess\(product\.entitlement\)\) onFinished\?\.\('purchased'\)/);
});

test('testimonials: one file, consent required, hidden while empty, readable by aplayermode.com', async () => {
  const file = JSON.parse(await src('public/testimonials.json'));
  assert.ok(Array.isArray(file.testimonials));
  assert.deepEqual(quotes.TESTIMONIALS, quotes.validTestimonials(file), 'the app shows exactly the valid entries of the file');
  assert.deepEqual(quotes.validTestimonials({ testimonials: [
    { quote: 'It plans my day.', name: 'Dana R.', consent: 'email 2026-11-02', context: 'Founder' },
    { quote: 'No consent on file.', name: 'Sam' },
    { quote: '', name: 'Empty', consent: 'x' },
    { quote: 'x'.repeat(401), name: 'Too long', consent: 'x' },
  ] }), [{ quote: 'It plans my day.', name: 'Dana R.', context: 'Founder' }]);
  assert.deepEqual(quotes.validTestimonials(null), []);
  const view = await src('src/components/Testimonials.tsx');
  assert.match(view, /if \(items\.length === 0\) return null;/);
  assert.doesNotMatch(view, /consent/, 'the consent record is never shown');
  assert.match(await src('app/welcome.tsx'), /<Testimonials \/>/);
  assert.match(await src('src/billing/PlanChoice.tsx'), /<Testimonials \/>/);
  assert.match(await src('public/_headers'), /\/testimonials\.json\n {2}Access-Control-Allow-Origin: https:\/\/aplayermode\.com\n/);
});

test('Autopilot ($79.99) is never the recommended plan, for any mix of games', () => {
  const games = ['parent', 'founder', 'athlete', 'student', 'professional', 'creator', 'transition', 'operator'];
  for (let mask = 0; mask < (1 << games.length); mask += 1) {
    const chosen = games.filter((_, i) => mask & (1 << i));
    assert.notEqual(sell.recommendedTier(chosen), 'autopilot', chosen.join(','));
  }
});
