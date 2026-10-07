// One source of truth for price: PLAN_PRICES / CHIEF_OF_STAFF_INTRO_OFFERS in
// src/index.ts (ADR-0004). Every doc is pinned to those constants here: a doc that
// states any other price on a line naming a tier fails this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CHANNELS,
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

test('price constants are the owner-decided final prices (ADR-0004)', () => {
  assert.deepEqual(
    Object.values(PLAN_PRICES).map(({ plan, displayName, tagline, monthlyUsdCents, includes }) => [plan, displayName, tagline, monthlyUsdCents, includes]),
    [
      ['chief_of_staff', 'Chief of Staff', 'decides the day', 2499, null],
      ['life_os', 'Life OS', 'remembers and prepares', 3999, 'chief_of_staff'],
      ['autopilot', 'Autopilot', 'does', 7999, 'life_os'],
    ],
  );
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
  assert.equal(planPriceLabels.life_os, `${lifeOs}/mo · includes Chief of Staff`);
  assert.equal(planPriceLabels.autopilot, `${autopilot}/mo · includes Life OS`);
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
const ALLOWED = new Set([cos, lifeOs, autopilot, founding, intro, '$0']);
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
