// One source of truth for price: PLAN_PRICES / CHIEF_OF_STAFF_INTRO_OFFERS /
// BILLING_PRODUCTS in src/index.ts (ADR-0004 monthly, ADR-0005 annual). Every doc is pinned to those constants here: a doc that
// states any other price on a line naming a tier fails this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CHANNELS,
  BILLING_PRODUCTS,
  REVENUECAT_CONFIG,
  billingProductFor,
  CHIEF_OF_STAFF_INTRO_OFFERS,
  PLAN_PRICES,
  decideAuthority,
  formatUsdCents,
  maxAutonomyForPlan,
  planPriceLabels,
  productPlanPolicies,
} from '../.test-dist/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const doc = (path) => readFileSync(join(repoRoot, path), 'utf8');

const cos = formatUsdCents(PLAN_PRICES.chief_of_staff.monthlyUsdCents);
const lifeOs = formatUsdCents(PLAN_PRICES.life_os.monthlyUsdCents);
const autopilot = formatUsdCents(PLAN_PRICES.autopilot.monthlyUsdCents);
const founding = formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents);
const intro = formatUsdCents(CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents);
const cosYear = formatUsdCents(PLAN_PRICES.chief_of_staff.annualUsdCents);
const lifeOsYear = formatUsdCents(PLAN_PRICES.life_os.annualUsdCents);
const autopilotYear = formatUsdCents(PLAN_PRICES.autopilot.annualUsdCents);

test('price constants are the owner-decided final prices (ADR-0004)', () => {
  assert.deepEqual(
    Object.values(PLAN_PRICES).map(({ plan, displayName, tagline, monthlyUsdCents, annualUsdCents, includes }) => [plan, displayName, tagline, monthlyUsdCents, annualUsdCents, includes]),
    [
      ['chief_of_staff', 'Chief of Staff', 'decides the day', 2499, 24999, null],
      ['life_os', 'Life OS', 'remembers and prepares', 3999, 39999, 'chief_of_staff'],
      ['autopilot', 'Autopilot', 'does', 7999, 79999, 'life_os'],
    ],
  );
  for (const plan of Object.values(PLAN_PRICES)) {
    assert.deepEqual(Object.keys(plan).sort(), ['annualUsdCents', 'displayName', 'includes', 'monthlyUsdCents', 'plan', 'tagline'], 'no other price fields');
    // ADR-0005 "2 months free": the annual price is ten months, rounded to the .99 price point.
    assert.ok(Math.abs(plan.annualUsdCents - 10 * plan.monthlyUsdCents) < 100, `${plan.plan} annual is ~10 x monthly`);
    assert.equal(plan.annualUsdCents % 100, 99, `${plan.plan} annual ends in .99`);
  }
  assert.deepEqual(CHIEF_OF_STAFF_INTRO_OFFERS, {
    founding100: { subscribers: 100, monthlyUsdCents: 999, lockedWhileContinuouslySubscribed: true },
    introductory: { monthlyUsdCents: 999, months: 3, thenMonthlyUsdCents: 2499 },
  });
  assert.equal(CHIEF_OF_STAFF_INTRO_OFFERS.introductory.thenMonthlyUsdCents, PLAN_PRICES.chief_of_staff.monthlyUsdCents, 'intro rolls onto the standard price');
  assert.deepEqual([...BILLING_CHANNELS], ['app_store', 'google_play']);
  assert.equal(formatUsdCents(2499), '$24.99');
  assert.equal(formatUsdCents(999), '$9.99');
  assert.equal(formatUsdCents(0), '$0.00');
  assert.throws(() => formatUsdCents(24.99), /price_cents_invalid/);
});

test('ladder is cumulative: each tier includes the one below and keeps all its capabilities', () => {
  const order = ['chief_of_staff', 'life_os', 'autopilot'];
  for (let i = 1; i < order.length; i += 1) {
    assert.equal(PLAN_PRICES[order[i]].includes, order[i - 1]);
    assert.ok(PLAN_PRICES[order[i]].monthlyUsdCents > PLAN_PRICES[order[i - 1]].monthlyUsdCents);
    for (const cap of productPlanPolicies[order[i - 1]].capabilities) assert.ok(productPlanPolicies[order[i]].capabilities.includes(cap), `${order[i]} keeps ${cap}`);
  }
  for (const plan of order) assert.equal(productPlanPolicies[plan].displayName, PLAN_PRICES[plan].displayName);
});

test('API plan labels are derived from the constants, never typed by hand', () => {
  assert.ok(planPriceLabels.chief_of_staff.startsWith(`${cos}/mo`));
  assert.ok(planPriceLabels.chief_of_staff.includes(`founding 100: ${founding}/mo locked`));
  assert.ok(planPriceLabels.chief_of_staff.includes(`${intro}/mo for the first 3 months`));
  assert.ok(planPriceLabels.chief_of_staff.startsWith(`${cos}/mo or ${cosYear}/yr · `));
  assert.equal(planPriceLabels.life_os, `${lifeOs}/mo or ${lifeOsYear}/yr · includes Chief of Staff`);
  assert.equal(planPriceLabels.autopilot, `${autopilot}/mo or ${autopilotYear}/yr · includes Life OS`);
  assert.equal(cosYear, '$249.99');
  assert.equal(lifeOsYear, '$399.99');
  assert.equal(autopilotYear, '$799.99');
  assert.equal(planPriceLabels.household, 'Waitlist only');
  assert.equal(planPriceLabels.beta, 'Free during beta');
  for (const label of Object.values(planPriceLabels)) assert.ok(!/hypothesis|~/.test(label), `no hypothesis wording: ${label}`);
});

test('buying Autopilot never grants autonomy without permission', () => {
  const base = {
    userId: 'u',
    domain: 'calendar',
    requestedLevel: 5,
    entitlement: { domain: 'calendar', maxAvailableLevel: maxAutonomyForPlan('autopilot', 'calendar'), enabled: true },
    globalExecutionEnabled: true,
    domainExecutionEnabled: true,
  };
  assert.equal(base.entitlement.maxAvailableLevel, 5, 'Autopilot entitlement reaches level 5');
  const noPermission = decideAuthority(base);
  assert.equal(noPermission.allowed, false);
  assert.equal(noPermission.reason, 'permission_missing_or_disabled');
});

// Every markdown doc outside docs/reference: on any line that names a tier or an
// intro offer, every dollar amount must be one of the constants above.
const TIER_LINE = /Chief of Staff|Life OS|Autopilot|[Ff]ounding|intro offer|\bIntro\b/;
const ALLOWED = new Set([cos, lifeOs, autopilot, founding, intro, cosYear, lifeOsYear, autopilotYear, '$0']);
const markdownDocs = () => {
  const files = ['README.md', 'AGENTS.md'];
  for (const dir of ['docs', 'docs/adr']) for (const f of readdirSync(join(repoRoot, dir))) if (f.endsWith('.md')) files.push(`${dir}/${f}`);
  return files;
};

test('no doc states a tier price that disagrees with the constants', () => {
  const offenders = [];
  let priced = 0;
  for (const file of markdownDocs()) {
    doc(file).split('\n').forEach((line, i) => {
      if (!TIER_LINE.test(line)) return;
      for (const amount of line.match(/~?\$\d[\d,]*(?:\.\d+)?\+?/g) ?? []) {
        priced += 1;
        if (!ALLOWED.has(amount)) offenders.push(`${file}:${i + 1} ${amount}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'stale or unknown tier prices');
  assert.ok(priced >= 20, `the docs actually state tier prices (found ${priced})`);
});

test('the pricing docs each state the full final price list', () => {
  for (const file of ['docs/02-PRICING-STRATEGY.md', 'docs/29-THREE-TIER-PRODUCT-CONTRACT.md', 'docs/adr/ADR-0004-FINAL-PRICING.md', 'docs/24-RELEASE-BETA-AND-COMMERCIALIZATION.md', 'docs/07-IMPLEMENTATION-ROADMAP.md']) {
    const text = doc(file);
    for (const amount of [cos, lifeOs, autopilot, founding]) assert.ok(text.includes(amount), `${file} states ${amount}`);
    assert.match(text, /Founding 100/, `${file} names Founding 100`);
    assert.match(text, /first 3 months/, `${file} states the 3-month intro`);
    assert.match(text, /App Store \+ Google Play|App Store and Google Play|App Store \/ Google Play/, `${file} names the store billing channel`);
  }
  const tableRow = (text, name, amount, includes) => new RegExp(`^\\| \\**${name}\\** \\| \\**[a-z ]+\\** \\| \\**\\${amount}\\** \\| ${includes} \\|$`, 'm').test(text);
  for (const file of ['docs/02-PRICING-STRATEGY.md', 'docs/29-THREE-TIER-PRODUCT-CONTRACT.md', 'docs/adr/ADR-0004-FINAL-PRICING.md']) {
    const text = doc(file);
    assert.ok(tableRow(text, 'Chief of Staff', cos, '—'), `${file} Chief of Staff row`);
    assert.ok(tableRow(text, 'Life OS', lifeOs, 'everything in Chief of Staff'), `${file} Life OS row`);
    assert.ok(tableRow(text, 'Autopilot', autopilot, 'everything in Life OS'), `${file} Autopilot row`);
    for (const plan of Object.values(PLAN_PRICES)) assert.ok(text.includes(plan.tagline), `${file} states "${plan.tagline}"`);
  }
  assert.match(doc('docs/adr/ADR-0002-THREE-TIER-LAUNCH.md'), /## Pricing\n\n\*\*Superseded by ADR-0004/);
  assert.match(doc('docs/adr/ADR-0004-FINAL-PRICING.md'), /Buying a tier never grants autonomy/);
});

test('annual plans: exactly the ADR-0005 prices, stated in every pricing doc', () => {
  const adr = doc('docs/adr/ADR-0005-ANNUAL-PLANS.md');
  assert.match(adr, /\*\*Status:\*\* ACCEPTED \/ LOCKED/);
  assert.match(adr, /2 months free/);
  assert.match(adr, /Buying a tier never grants autonomy/);
  assert.match(adr, /no intro offer|No intro offer/i);
  for (const file of ['docs/02-PRICING-STRATEGY.md', 'docs/29-THREE-TIER-PRODUCT-CONTRACT.md', 'docs/adr/ADR-0005-ANNUAL-PLANS.md', 'docs/33-BILLING-PHASE-D.md']) {
    const text = doc(file);
    for (const [name, monthly, annual] of [['Chief of Staff', cos, cosYear], ['Life OS', lifeOs, lifeOsYear], ['Autopilot', autopilot, autopilotYear]]) {
      const row = text.split('\n').find((line) => line.startsWith('|') && line.includes(name) && line.includes(annual));
      assert.ok(row, `${file} has a ${name} row with ${annual}`);
      assert.ok(row.includes(monthly), `${file} ${name} annual row also states the monthly ${monthly}`);
    }
  }
  assert.doesNotMatch(doc('docs/02-PRICING-STRATEGY.md'), /Monthly only at launch/, 'the retired monthly-only rule is gone');
});

test('store product catalogue: every tier x period on both stores, Founding 100 is CoS monthly only', () => {
  const ids = BILLING_PRODUCTS.map((item) => item.productId);
  assert.equal(new Set(ids).size, ids.length, 'product ids are unique');
  assert.equal(BILLING_PRODUCTS.length, 14);
  for (const store of BILLING_CHANNELS) {
    for (const plan of Object.keys(PLAN_PRICES)) {
      for (const period of ['monthly', 'annual']) {
        const standard = BILLING_PRODUCTS.filter((item) => item.store === store && item.plan === plan && item.period === period && item.offer === 'standard');
        assert.equal(standard.length, 1, `${store} ${plan} ${period}`);
        assert.equal(standard[0].usdCents, period === 'annual' ? PLAN_PRICES[plan].annualUsdCents : PLAN_PRICES[plan].monthlyUsdCents);
      }
    }
    const founding = BILLING_PRODUCTS.filter((item) => item.store === store && item.offer === 'founding');
    assert.equal(founding.length, 1, `${store} has exactly one Founding 100 product`);
    assert.deepEqual([founding[0].plan, founding[0].period, founding[0].usdCents], ['chief_of_staff', 'monthly', CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents]);
  }
  for (const item of BILLING_PRODUCTS) {
    if (item.store === 'google_play') assert.match(item.productId, /^apm_[a-z]+:[a-z0-9-]+$/, 'Play ids are <subscription>:<base plan>');
    else assert.match(item.productId, /^apm_[a-z_]+$/);
    assert.equal(billingProductFor(item.productId), item);
  }
  assert.equal(billingProductFor('apm_cos_monthly_FOUNDING'), undefined, 'exact match only');
  assert.notEqual(REVENUECAT_CONFIG.defaultOffering, REVENUECAT_CONFIG.foundingOffering);
  assert.equal(REVENUECAT_CONFIG.webhookPath, '/v1/billing/revenuecat/webhook');
});
