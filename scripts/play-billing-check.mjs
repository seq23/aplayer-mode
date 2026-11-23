#!/usr/bin/env node
// Proves every paid plan the Android paywall offers really exists on Google Play AND in RevenueCat,
// at the decided price, on the right entitlement and in the right offering package (brief: "every plan
// on the paywall and Play listing exists"; "same value everywhere"). The truth is packages/policy
// (BILLING_PRODUCTS, PLAN_PRICES, CHIEF_OF_STAFF_INTRO_OFFERS, REVENUECAT_CONFIG). Read-only: it lists,
// never writes. Any read that fails is a NAMED STOP (exit 1), never a pass.
// usage: node scripts/play-billing-check.mjs --key-file <play-sa.json> [package]   (REVENUECAT_V2_SECRET_KEY in env)
//        node scripts/play-billing-check.mjs --self-check                          (fixtures; no network)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { playAccessToken } from './lib/play-auth.mjs';

const RC_PROJECT = 'proj2c0586cf';
const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export async function loadPolicy() {
  const { build } = await import('esbuild');
  const dir = await mkdtemp(join(tmpdir(), 'apm-policy-'));
  try {
    await build({ entryPoints: { policy: fileURLToPath(new URL('../packages/policy/src/index.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: dir, logLevel: 'silent' });
    return await import(pathToFileURL(join(dir, 'policy.js')).href);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const cents = (price) => (price ? Math.round(Number(price.units ?? 0) * 100 + Number(price.nanos ?? 0) / 1e7) : undefined);
const usPrice = (configs) => cents((configs ?? []).find((c) => c.regionCode === 'US')?.price);

/**
 * Problems between the policy and what Play + RevenueCat returned; empty = every plan is sellable as decided.
 * play = { subscriptions: [...], offers: { 'sub:basePlan': [...] } }; rc = { apps, products, entitlements, offerings } (v2 shapes, expanded).
 */
export function billingProblems(policy, play, rc, pkg = 'com.aplayermode.app') {
  const problems = [];
  const want = policy.BILLING_PRODUCTS.filter((p) => p.store === 'google_play');
  if (!want.length) return ['policy lists no Google Play products (nothing to check)'];
  const subs = play?.subscriptions ?? [];
  if (!subs.length) problems.push('Play returned no subscriptions (nothing was read)');
  const period = { monthly: 'P1M', annual: 'P1Y' };
  for (const p of want) {
    const [subId, planId] = p.productId.split(':');
    const sub = subs.find((s) => s.productId === subId);
    const base = sub?.basePlans?.find((b) => b.basePlanId === planId);
    if (!base) { problems.push(`Play: ${p.productId} does not exist`); continue; }
    if (base.state !== 'ACTIVE') problems.push(`Play: ${p.productId} is ${base.state}, not ACTIVE`);
    const duration = base.autoRenewingBasePlanType?.billingPeriodDuration;
    if (duration !== period[p.period]) problems.push(`Play: ${p.productId} renews every ${duration}, policy says ${period[p.period]}`);
    const us = usPrice(base.regionalConfigs);
    if (us !== p.usdCents) problems.push(`Play: ${p.productId} US price ${us} cents, policy says ${p.usdCents}`);
  }
  // Nothing sellable on Play that the app and the webhook do not know (it would charge and never unlock).
  for (const s of subs) for (const b of s.basePlans ?? []) {
    const id = `${s.productId}:${b.basePlanId}`;
    if (b.state === 'ACTIVE' && !want.some((p) => p.productId === id)) problems.push(`Play: ${id} is ACTIVE but not in BILLING_PRODUCTS (a buyer would never unlock)`);
  }
  // The 3-month introductory price on Executive Roundtable monthly (CHIEF_OF_STAFF_INTRO_OFFERS.introductory).
  const intro = policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory;
  const introOffers = (play?.offers?.['apm_cos:monthly'] ?? []).filter((o) => o.state === 'ACTIVE');
  const okIntro = introOffers.some((o) => (o.phases ?? []).length === 1 && o.phases[0].recurrenceCount === intro.months && o.phases[0].duration === 'P1M' && usPrice(o.phases[0].regionalConfigs) === intro.monthlyUsdCents);
  if (!okIntro) problems.push(`Play: apm_cos:monthly has no ACTIVE offer of ${intro.months} x P1M at ${intro.monthlyUsdCents} cents US`);

  const app = (rc?.apps ?? []).find((a) => a.type === 'play_store' && a.play_store?.package_name === pkg);
  if (!app) { problems.push(`RevenueCat: no play_store app for ${pkg}`); return problems; }
  const rcProducts = (rc.products ?? []).filter((x) => x.app_id === app.id);
  for (const p of want) {
    const found = rcProducts.find((x) => x.store_identifier === p.productId);
    if (!found) { problems.push(`RevenueCat: ${p.productId} is not a product of the Play app`); continue; }
    if (found.state && found.state !== 'active') problems.push(`RevenueCat: ${p.productId} is ${found.state}`);
    const ent = (rc.entitlements ?? []).find((e) => e.lookup_key === policy.REVENUECAT_CONFIG.entitlements[p.plan]);
    if (!(ent?.products?.items ?? []).some((x) => x.id === found.id)) problems.push(`RevenueCat: ${p.productId} is not attached to entitlement ${policy.REVENUECAT_CONFIG.entitlements[p.plan]}`);
  }
  const playProductIn = (offering, packageKey) => {
    const pk = (offering?.packages?.items ?? []).find((x) => x.lookup_key === packageKey);
    return (pk?.products?.items ?? []).map((x) => x.product ?? x).find((x) => x.app_id === app.id)?.store_identifier;
  };
  for (const [offeringKey, founding] of [[policy.REVENUECAT_CONFIG.defaultOffering, false], [policy.REVENUECAT_CONFIG.foundingOffering, true]]) {
    const offering = (rc.offerings ?? []).find((o) => o.lookup_key === offeringKey);
    if (!offering) { problems.push(`RevenueCat: offering ${offeringKey} missing`); continue; }
    for (const [plan, periods] of Object.entries(policy.REVENUECAT_CONFIG.packages)) for (const [per, packageKey] of Object.entries(periods)) {
      const expected = want.find((p) => p.plan === plan && p.period === per && p.offer === (founding && plan === 'chief_of_staff' && per === 'monthly' ? 'founding' : 'standard'))?.productId;
      const got = playProductIn(offering, packageKey);
      if (got !== expected) problems.push(`RevenueCat: offering ${offeringKey} package ${packageKey} sells ${got ?? 'nothing'} on Play, policy says ${expected}`);
    }
  }
  return problems;
}

export async function readPlay(pkg, token, fetch = globalThis.fetch) {
  const headers = { authorization: `Bearer ${token}` };
  const res = await fetch(`${PLAY_API}/${pkg}/subscriptions`, { headers });
  if (!res.ok) throw new Error(`NAMED STOP [PLAY_SUBSCRIPTIONS_REFUSED] subscriptions.list answered ${res.status}`);
  const subscriptions = (await res.json()).subscriptions ?? [];
  const offers = {};
  for (const s of subscriptions) for (const b of s.basePlans ?? []) {
    const r = await fetch(`${PLAY_API}/${pkg}/subscriptions/${s.productId}/basePlans/${b.basePlanId}/offers`, { headers });
    if (!r.ok) throw new Error(`NAMED STOP [PLAY_OFFERS_REFUSED] offers.list ${s.productId}:${b.basePlanId} answered ${r.status}`);
    offers[`${s.productId}:${b.basePlanId}`] = (await r.json().catch(() => ({}))).subscriptionOffers ?? [];
  }
  return { subscriptions, offers };
}

export async function readRevenueCat(key, fetch = globalThis.fetch) {
  if (!key) throw new Error('NAMED STOP [REVENUECAT_KEY_MISSING] REVENUECAT_V2_SECRET_KEY is not set');
  const get = async (path) => {
    const res = await fetch(`https://api.revenuecat.com/v2/projects/${RC_PROJECT}${path}`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`NAMED STOP [REVENUECAT_READ_REFUSED] ${path.split('?')[0]} answered ${res.status}`);
    return (await res.json()).items ?? [];
  };
  return {
    apps: await get('/apps?limit=50'),
    products: await get('/products?limit=200'),
    entitlements: await get('/entitlements?limit=50&expand=items.product'),
    offerings: await get('/offerings?limit=50&expand=items.package.product'),
  };
}

/** A fixture world that matches the policy exactly (what Play + RevenueCat return today). */
export function goodWorld(policy) {
  const want = policy.BILLING_PRODUCTS.filter((p) => p.store === 'google_play');
  const price = (c) => [{ regionCode: 'US', price: { currencyCode: 'USD', units: String(Math.floor(c / 100)), nanos: (c % 100) * 1e7 } }];
  const subs = {};
  for (const p of want) {
    const [s, b] = p.productId.split(':');
    (subs[s] ??= { productId: s, basePlans: [] }).basePlans.push({ basePlanId: b, state: 'ACTIVE', autoRenewingBasePlanType: { billingPeriodDuration: p.period === 'annual' ? 'P1Y' : 'P1M' }, regionalConfigs: price(p.usdCents) });
  }
  const intro = policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory;
  const play = { subscriptions: Object.values(subs), offers: { 'apm_cos:monthly': [{ offerId: 'intro-3m', state: 'ACTIVE', phases: [{ recurrenceCount: intro.months, duration: 'P1M', regionalConfigs: price(intro.monthlyUsdCents) }] }] } };
  const products = want.map((p, i) => ({ id: `prod${i}`, app_id: 'appPlay', store_identifier: p.productId, state: 'active' }));
  const entitlements = Object.entries(policy.REVENUECAT_CONFIG.entitlements).map(([plan, key]) => ({ lookup_key: key, products: { items: products.filter((x) => want.find((p) => p.productId === x.store_identifier).plan === plan) } }));
  const offering = (key, founding) => ({ lookup_key: key, packages: { items: Object.entries(policy.REVENUECAT_CONFIG.packages).flatMap(([plan, periods]) => Object.entries(periods).map(([per, lk]) => {
    const id = want.find((p) => p.plan === plan && p.period === per && p.offer === (founding && plan === 'chief_of_staff' && per === 'monthly' ? 'founding' : 'standard')).productId;
    return { lookup_key: lk, products: { items: [{ product: products.find((x) => x.store_identifier === id) }] } };
  })) } });
  const rc = { apps: [{ id: 'appPlay', type: 'play_store', play_store: { package_name: 'com.aplayermode.app' } }], products, entitlements, offerings: [offering(policy.REVENUECAT_CONFIG.defaultOffering, false), offering(policy.REVENUECAT_CONFIG.foundingOffering, true)] };
  return { play, rc };
}

async function selfCheck() {
  const policy = await loadPolicy();
  const world = () => goodWorld(policy);
  const mutate = (fn) => { const w = world(); fn(w); return billingProblems(policy, w.play, w.rc).length; };
  const cases = [
    [billingProblems(policy, world().play, world().rc).length === 0, 'the matching world passes'],
    [mutate((w) => { w.play.subscriptions[0].basePlans[0].regionalConfigs[0].price.units = '19'; }) === 1, 'a wrong Play price fails'],
    [mutate((w) => { w.play.subscriptions[0].basePlans[0].state = 'INACTIVE'; }) >= 1, 'an inactive base plan fails'],
    [mutate((w) => { w.play.subscriptions[2].basePlans.pop(); }) >= 1, 'a missing base plan fails'],
    [mutate((w) => { w.play.subscriptions[0].basePlans.push({ basePlanId: 'weekly', state: 'ACTIVE' }); }) === 1, 'an unknown ACTIVE base plan fails'],
    [mutate((w) => { w.play.offers['apm_cos:monthly'] = []; }) === 1, 'no intro offer fails'],
    [mutate((w) => { w.rc.entitlements[0].products.items = []; }) >= 1, 'a product off its entitlement fails'],
    [mutate((w) => { w.rc.offerings[1] = goodWorld(policy).rc.offerings[0]; w.rc.offerings[1].lookup_key = policy.REVENUECAT_CONFIG.foundingOffering; }) === 1, 'founding offering selling the list price fails'],
    [mutate((w) => { w.rc.offerings.pop(); }) === 1, 'a missing offering fails'],
    [mutate((w) => { w.rc.apps = []; }) >= 1, 'no Play app in RevenueCat fails'],
    [billingProblems(policy, { subscriptions: [] }, { apps: [] }).length > 0, 'an empty read fails'],
    [await readRevenueCat('', async () => new Response('{}')).then(() => false, (e) => /REVENUECAT_KEY_MISSING/.test(e.message)), 'no RevenueCat key is a named stop'],
    [await readRevenueCat('k', async () => new Response('{}', { status: 401 })).then(() => false, (e) => /REVENUECAT_READ_REFUSED/.test(e.message)), 'a refused RevenueCat read is a named stop, never a pass'],
  ];
  const bad = cases.filter(([ok]) => !ok).map(([, name]) => name);
  if (bad.length) { console.error(`play-billing-check self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
  console.log(`OUTPUT play-billing-check self-check: ${cases.length} fixtures behave`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') await selfCheck();
  else {
    const [flag, keyFile, pkg = 'com.aplayermode.app'] = process.argv.slice(2);
    if (flag !== '--key-file' || !keyFile) { console.error('usage: play-billing-check.mjs --key-file <sa.json> [package]'); process.exit(2); }
    try {
      const [policy, play, rc] = await Promise.all([loadPolicy(), playAccessToken(keyFile).then((token) => readPlay(pkg, token)), readRevenueCat(process.env.REVENUECAT_V2_SECRET_KEY)]);
      const problems = billingProblems(policy, play, rc, pkg);
      if (problems.length) { console.error(`play-billing-check FAILED for ${pkg}:\n  ✗ ${problems.join('\n  ✗ ')}`); process.exit(1); }
      const n = policy.BILLING_PRODUCTS.filter((p) => p.store === 'google_play').length;
      console.log(`OUTPUT play-billing-check: ${pkg} sells all ${n} Play plans at the policy prices, intro offer live, RevenueCat entitlements and both offerings match`);
    } catch (err) { console.error(err.message); process.exit(1); }
  }
}
