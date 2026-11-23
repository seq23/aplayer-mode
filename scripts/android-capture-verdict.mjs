#!/usr/bin/env node
// The verdict of the Android paywall capture (scripts/android-paywall-capture.sh), read from the
// screen hierarchies Maestro dumped for each screen. A screen passes ONLY in one of two states:
//   play-prices  the tier cards, a price on them (on a store build every price is Google Play's own
//                string: catalog.ts shows none until Play answers) and at least one ENABLED store buy
//                button ("Subscribe to / Upgrade to / Switch to …"), with no blocked line;
//   outage       the store card ("Nothing was charged and your setup is saved"), every buy button
//                seen DISABLED with "Not available right now" under it, and the cause the app wrote
//                to logcat ("[apm-billing] store plans unavailable: fault=… code=…").
// Anything else fails (Rule 0): a blank screen, still loading, card checkout, a not-configured build,
// "This plan is not in the store yet", "Plans did not load", a screen with no buy button at all.
// The signed-out welcome page ("welcome-*" screens) passes only when it rendered top to bottom, shows
// the intro-offer line and names no fixed price (a store build's price is Play's, on the plans screen).
// usage: node scripts/android-capture-verdict.mjs <out-dir> <screen-name>...   (reads <out>/<name>-*.json, <out>/billing-log.txt)
//        node scripts/android-capture-verdict.mjs --self-check                 (fixtures; no device)
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUY = /^(Subscribe to|Upgrade to|Switch to) /;
const PRICE = /\S\/(month|year)$/;
const OUTAGE = 'Nothing was charged and your setup is saved';
const FIXED_PRICE = /[$€£¥₹]\s?\d|\d\s?[€£¥₹]|\d[.,]\d\d\s*\/\s*(month|year|mo)\b|\bUSD\b/i;
const FAILS = [
  [/pay by card|Plans are paid by card/i, 'store build shows card checkout'],
  [/Getting prices from the store/, 'still loading store prices'],
  [/In-app purchases are not configured|Expo Go cannot make purchases/, 'a build that cannot buy (not configured)'],
  [/This plan is not in the store yet/, 'a plan is missing from Google Play'],
  [/Plans did not load/, 'the plan list did not load'],
];

/** Every node of one Maestro hierarchy, flattened to what the verdict reads. */
export function nodes(tree) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    const a = n.attributes ?? {};
    const flag = typeof n.enabled === 'boolean' ? n.enabled : a.enabled === 'true' ? true : a.enabled === 'false' ? false : undefined;
    out.push({ text: String(a.text ?? ''), desc: String(a.accessibilityText ?? a['content-desc'] ?? ''), enabled: flag });
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

/** The last cause the app logged, e.g. { fault: 'not_allowed', code: '3' }, or undefined. */
export function loggedFault(log) {
  const hits = [...String(log ?? '').matchAll(/\[apm-billing\] store plans unavailable: fault=(\w+) code=(\w+)/g)];
  const last = hits.at(-1);
  return last ? { fault: last[1], code: last[2] } : undefined;
}

/** { state } or { problem } for one screen, from the nodes of all its hierarchies. */
export function screenVerdict(all, log) {
  const strings = all.flatMap((n) => [n.text, n.desc]).filter(Boolean);
  const has = (re) => strings.some((s) => (typeof re === 'string' ? s.includes(re) : re.test(s)));
  if (!has('Executive Roundtable')) return { problem: 'tier cards never rendered' };
  for (const [re, why] of FAILS) if (has(re)) return { problem: why };
  // The buy button is the Pressable (content-desc = its label); its Text child is always "enabled".
  const buttons = all.filter((n) => BUY.test(n.desc));
  const live = buttons.filter((n) => n.enabled === true);
  const blocked = buttons.filter((n) => n.enabled === false);
  if (has(OUTAGE)) {
    if (live.length) return { problem: 'outage card shown but a buy button is live' };
    if (!blocked.length) return { problem: 'outage card shown but no (disabled) buy button was seen' };
    if (!has('Not available right now')) return { problem: 'outage card shown but the buy line does not say so' };
    const fault = loggedFault(log);
    if (!fault) return { problem: 'outage card shown but the app logged no cause ([apm-billing] line missing from logcat)' };
    return { state: `outage(fault=${fault.fault},code=${fault.code})` };
  }
  if (has('Not available right now')) return { problem: 'buy blocked with no outage card' };
  if (!live.length) return { problem: 'no enabled store buy button (Subscribe to / Upgrade to / Switch to)' };
  if (!strings.some((s) => PRICE.test(s))) return { problem: 'no Google Play price on the tier cards' };
  return { state: 'play-prices' };
}

/** { state } or { problem } for one welcome-page screen (store build, signed out). */
export function welcomeVerdict(all) {
  const strings = all.flatMap((n) => [n.text, n.desc]).filter(Boolean);
  const has = (re) => strings.some((s) => (typeof re === 'string' ? s.includes(re) : re.test(s)));
  if (!has('I already have an account')) return { problem: 'the welcome page never rendered' };
  const priced = strings.find((s) => FIXED_PRICE.test(s));
  if (priced) return { problem: `a fixed price on the store welcome page: "${priced.slice(0, 80)}"` };
  if (!has(/\d+-month intro offer · see plans/)) return { problem: 'no intro-offer line by the plans teaser' };
  if (!has(/price shows on the plans screen/)) return { problem: 'no line saying where the price is' };
  if (!has('You pick a plan after setup')) return { problem: 'the full terms by the last Start were never seen' };
  return { state: 'no-fixed-price' };
}

async function readScreen(out, name) {
  const files = (await readdir(out)).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.json')).sort();
  if (!files.length) return undefined;
  const all = [];
  for (const f of files) all.push(...nodes(JSON.parse(await readFile(join(out, f), 'utf8'))));
  return all;
}

function fixture({ outage = false, buttons = [true], price = '$24.99/month', blockedLine = false, extra = [] } = {}) {
  const leaf = (text, desc = '', enabled = true) => ({ attributes: { text, accessibilityText: desc }, enabled, children: [] });
  const children = [leaf('How much should APM carry?'), leaf('Executive Roundtable')];
  if (outage) children.push(leaf(`Google Play can't take payments on this phone yet. ${OUTAGE}.`));
  if (price) children.push(leaf(price));
  for (const on of buttons) children.push({ attributes: { text: '', accessibilityText: 'Subscribe to Executive Roundtable' }, enabled: on, children: [leaf('Subscribe to Executive Roundtable')] });
  if (blockedLine) children.push(leaf('Not available right now. Tap Try again above.'));
  for (const t of extra) children.push(leaf(t));
  return nodes({ attributes: {}, enabled: true, children });
}

function welcomeFixture({ offer = '3-month intro offer · see plans', short = 'Subscription with a 3-month intro offer; your price shows on the plans screen. No free trial. Cancel any time.', end = true, extra = [] } = {}) {
  const leaf = (text) => ({ attributes: { text, accessibilityText: '' }, enabled: true, children: [] });
  const children = [leaf('Start: reduce my load'), leaf('I already have an account'), leaf('Three levels of help')];
  for (const t of [offer, short, ...extra]) if (t) children.push(leaf(t));
  if (end) children.push(leaf('A subscription, no free trial. Your exact price, in your currency, shows on the plans screen before you confirm. Cancel any time. You pick a plan after setup.'));
  return nodes({ attributes: {}, enabled: true, children });
}

async function selfCheck() {
  const log = 'W/ReactNativeJS( 123): [apm-billing] store plans unavailable: fault=not_allowed code=3 BILLING_UNAVAILABLE';
  const ok = (v) => Boolean(v.state);
  const outage = { outage: true, buttons: [false], price: null, blockedLine: true };
  const cases = [
    [ok(screenVerdict(fixture(), '')), 'Play prices with a live buy button pass'],
    [screenVerdict(fixture(), '').state === 'play-prices', 'and are labelled play-prices'],
    [ok(screenVerdict(fixture(outage), log)) && screenVerdict(fixture(outage), log).state === 'outage(fault=not_allowed,code=3)', 'the outage card with disabled buttons and a logged cause passes, with the cause'],
    [!ok(screenVerdict(fixture({ buttons: [] }), '')), 'buy buttons removed fails'],
    [!ok(screenVerdict(fixture({ buttons: [false] }), '')), 'only disabled buy buttons and no outage card fails'],
    [!ok(screenVerdict(fixture({ buttons: [undefined] }), '')), 'a buy button whose state is unknown is not live'],
    [!ok(screenVerdict(fixture({ price: null }), '')), 'no price on the cards fails'],
    [!ok(screenVerdict(fixture({ extra: ['In-app purchases are not configured in this build yet.'] }), '')), 'a not-configured build fails'],
    [!ok(screenVerdict(fixture({ extra: ['This plan is not in the store yet. Pick another or decide later.'] }), '')), '"not in the store yet" fails'],
    [!ok(screenVerdict(fixture({ extra: ['Pay by card · Executive Roundtable'] }), '')), 'card checkout fails'],
    [!ok(screenVerdict(fixture({ extra: ['Getting prices from the store…'] }), '')), 'still loading fails'],
    [!ok(screenVerdict(fixture({ blockedLine: true }), '')), 'a blocked line with no outage card fails'],
    [!ok(screenVerdict(fixture({ ...outage, buttons: [false, true] }), log)), 'an outage with a live buy button beside a disabled one fails'],
    [!ok(screenVerdict(fixture({ ...outage, buttons: [] }), log)), 'an outage with no buy button seen fails'],
    [!ok(screenVerdict(fixture(outage), '')), 'an outage with no logged cause fails'],
    [!ok(screenVerdict(nodes({}), log)), 'an empty screen fails'],
    [welcomeVerdict(welcomeFixture()).state === 'no-fixed-price', 'the store welcome page with the intro-offer line and no price passes'],
    [!ok(welcomeVerdict(welcomeFixture({ offer: 'Introductory offer: start at $9.99/month' }))), 'the card build\'s USD pill on a store build fails'],
    [!ok(welcomeVerdict(welcomeFixture({ short: 'Subscription: $9.99/month to start, then $24.99/month after 3 months.' }))), 'a USD line under Start fails'],
    [!ok(welcomeVerdict(welcomeFixture({ extra: ['9,99 €/month'] }))), 'a fixed price in another currency fails'],
    [!ok(welcomeVerdict(welcomeFixture({ offer: null }))), 'no intro-offer line fails'],
    [!ok(welcomeVerdict(welcomeFixture({ end: false }))), 'the full terms never seen fails'],
    [!ok(welcomeVerdict(nodes({}))), 'an empty welcome screen fails'],
  ];
  const bad = cases.filter(([pass]) => !pass).map(([, name]) => name);
  if (bad.length) { console.error(`android-capture-verdict self-check FAILED: ${bad.join('; ')}`); process.exit(1); }
  console.log(`OUTPUT android-capture-verdict self-check: ${cases.length} fixtures behave`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] === '--self-check') await selfCheck();
  else {
    const [out, ...names] = process.argv.slice(2);
    if (!out || !names.length) { console.error('usage: android-capture-verdict.mjs <out-dir> <screen-name>...'); process.exit(2); }
    const log = await readFile(join(out, 'billing-log.txt'), 'utf8').catch(() => '');
    const states = [];
    for (const name of names) {
      const all = await readScreen(out, name);
      const v = !all ? { problem: 'no screen hierarchy was dumped' } : name.startsWith('welcome-') ? welcomeVerdict(all) : screenVerdict(all, log);
      if (v.problem) {
        // Shape only (never screen text), so a Maestro format change is diagnosable from the log.
        const keys = new Set(); const walk = (n) => { if (n && typeof n === 'object') { for (const k of Object.keys(n.attributes ?? {})) keys.add(k); (n.children ?? []).forEach(walk); } };
        for (const f of (await readdir(out)).filter((x) => x.startsWith(`${name}-`) && x.endsWith('.json'))) walk(JSON.parse(await readFile(join(out, f), 'utf8')));
        console.error(`${name}: ${v.problem} (hierarchy attribute keys: ${[...keys].sort().join(',') || 'none'}; buy-labelled nodes: ${all ? all.filter((n) => BUY.test(n.desc) || BUY.test(n.text)).map((n) => `${n.desc ? 'desc' : 'text'}/enabled=${n.enabled}`).join(' ') : 'n/a'})`);
        process.exit(1);
      }
      states.push(`${name}=${v.state}`);
    }
    console.log(states.join(' '));
  }
}
