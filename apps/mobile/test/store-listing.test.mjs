// The App Store listing (store/app-store.json) must fit Apple's field limits, or App Store Connect
// refuses it at submission: name and subtitle 30 characters, keywords 100 bytes, promotional text
// 170, description 4,000. No income or health promises (risk R-ADV-05, R-ADV-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const listing = JSON.parse(await readFile(new URL('../store/app-store.json', import.meta.url), 'utf8'));

export function listingProblems(l) {
  const out = [];
  for (const k of ['name', 'subtitle', 'keywords', 'promotionalText', 'description']) if (!l[k]) out.push(`${k} is empty`);
  if ([...(l.name || '')].length > 30) out.push('name over 30 characters');
  if ([...(l.subtitle || '')].length > 30) out.push('subtitle over 30 characters');
  if (Buffer.byteLength(l.keywords || '') > 100) out.push('keywords over 100 bytes');
  if ([...(l.promotionalText || '')].length > 170) out.push('promotional text over 170 characters');
  if ([...(l.description || '')].length > 4000) out.push('description over 4,000 characters');
  const all = `${l.subtitle} ${l.promotionalText} ${l.description}`;
  if (/\$\s?\d+k\b|make \$|lose \d+ ?(lb|kg|pounds)|guarantee(d)? (results|weight|income)/i.test(all)) out.push('income or health promise');
  return out;
}

test('the App Store listing fits Apple\'s limits and makes no income or health promise', () => {
  assert.deepEqual(listingProblems(listing), []);
});

test('the listing check fails on an over-long subtitle and an income promise (negative proof)', () => {
  const bad = listingProblems({ ...listing, subtitle: 'An AI chief of staff for your whole day', description: 'Make $10K a month.' });
  assert.ok(bad.includes('subtitle over 30 characters'));
  assert.ok(bad.includes('income or health promise'));
});

// Google Play (store/google-play.json): title 30, short 80, full 4,000; no income or health promise;
// and the account-deletion URL Google requires (Play Help 13327111) is a real page shipped with the
// web app, saying how to ask without the app, what is deleted, what is kept and how long it takes.
const play = JSON.parse(await readFile(new URL('../store/google-play.json', import.meta.url), 'utf8'));
export function playProblems(p) {
  const out = [];
  if (!p.title || [...p.title].length > 30) out.push('title empty or over 30 characters');
  if (!p.shortDescription || [...p.shortDescription].length > 80) out.push('short description empty or over 80 characters');
  if (!p.fullDescription || [...p.fullDescription].length > 4000) out.push('full description empty or over 4,000 characters');
  if (/\$\s?\d+k\b|make \$|lose \d+ ?(lb|kg|pounds)|guarantee(d)? (results|weight|income)/i.test(`${p.shortDescription} ${p.fullDescription}`)) out.push('income or health promise');
  if (/#\w/.test(`${p.shortDescription} ${p.fullDescription}`)) out.push('hashtag');
  return out;
}

test('the Google Play listing fits Google\'s limits and makes no promise', () => {
  assert.deepEqual(playProblems(play), []);
  assert.ok(playProblems({ ...play, shortDescription: 'x'.repeat(81), fullDescription: 'Make $10K a month. #hustle' }).length === 3, 'negative proof');
});

test('the Play account-deletion URL is a real static page, not the app\'s catch-all route', async () => {
  const url = new URL(play.accountDeletionUrl);
  assert.equal(url.host, 'app.aplayermode.com');
  const html = await readFile(new URL(`../public${url.pathname}/index.html`, import.meta.url), 'utf8');
  for (const part of ['support@aplayermode.com', 'What is deleted', 'What is kept', 'How long it takes', '/settings/privacy/export-delete']) assert.ok(html.includes(part), `delete-account page lacks ${part}`);
});

// Play's Data safety and permission answers (store/google-play/play-console.md) say the app uses no
// overlay, no shared storage and no biometrics; the 19 Nov 2026 AAB listed all three. WRITE_CALENDAR
// stays: expo-calendar's Android requestCalendarPermissionsAsync asks for READ and WRITE together and
// getCalendarsAsync/getEventsAsync refuse without both (CalendarModule.kt checkPermissions).
test('the Android build blocks every permission the app does not use, and keeps calendar access working', async () => {
  const android = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8')).expo.android;
  for (const p of ['SYSTEM_ALERT_WINDOW', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'USE_BIOMETRIC', 'USE_FINGERPRINT'])
    assert.ok(android.blockedPermissions.includes(`android.permission.${p}`), `${p} must be blocked`);
  for (const p of ['READ_CALENDAR', 'WRITE_CALENDAR']) assert.ok(!android.blockedPermissions.some((b) => b.endsWith(p)), `${p} must not be blocked`);
});

test('the store listings promise the same setup time the app computes from its question path (10 s a question, measured)', async () => {
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const bundle = await build({ stdin: { contents: "export { QUICK_SETUP_MINUTES } from './src/content/sell';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent', external: ['react-native', 'expo-*'] });
  const { QUICK_SETUP_MINUTES } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  assert.ok(Number.isInteger(QUICK_SETUP_MINUTES) && QUICK_SETUP_MINUTES > 0);
  const play = JSON.parse(await readFile(new URL('../store/google-play.json', import.meta.url), 'utf8'));
  for (const [name, text] of [['App Store', listing.description], ['Google Play', play.fullDescription]]) {
    const claims = [...text.matchAll(/about (\d+) minutes/g)].map((m) => Number(m[1]));
    assert.ok(claims.length >= 1, `${name}: states the setup time`);
    assert.deepEqual([...new Set(claims)], [QUICK_SETUP_MINUTES], `${name}: about ${QUICK_SETUP_MINUTES} minutes, like the app`);
  }
});

// App Review check 13 (every promise matches what is built): the daily AI limit the server enforces
// (PAID_AI_DAILY_LIMIT, services/api/src/paidCalls.ts) is disclosed in ONE sentence, and the paywall,
// both store listings and the Terms carry exactly that sentence.
test('the daily AI limit is disclosed in the same words on the paywall, both listings and the Terms, at the enforced number', async () => {
  const policy = await readFile(new URL('../../../packages/policy/src/index.ts', import.meta.url), 'utf8');
  const limit = Number(policy.match(/export const PAID_AI_DAILY_LIMIT = (\d+);/)?.[1]);
  assert.ok(limit > 0, 'read the enforced limit');
  const template = policy.match(/export const DAILY_AI_LIMIT_LINE = `([^`]+)`;/)?.[1];
  assert.ok(template, 'read the disclosure sentence');
  const line = template.replace('${PAID_AI_DAILY_LIMIT}', String(limit));
  assert.match(line, new RegExp(`up to ${limit} AI requests a day`));
  const paid = await readFile(new URL('../../../services/api/src/paidCalls.ts', import.meta.url), 'utf8');
  assert.match(paid, /perUserPerDay: PAID_AI_DAILY_LIMIT,/, 'the server enforces the disclosed number');
  assert.ok(listing.description.includes(line), 'App Store description');
  assert.ok(play.fullDescription.includes(line), 'Google Play full description');
  const terms = await readFile(new URL('../public/terms/index.html', import.meta.url), 'utf8');
  assert.ok(terms.includes(line), 'Terms');
  const sell = await readFile(new URL('../src/content/sell.ts', import.meta.url), 'utf8');
  const paywall = await readFile(new URL('../src/billing/PlanChoice.tsx', import.meta.url), 'utf8');
  assert.match(sell, /limitLine: DAILY_AI_LIMIT_LINE,/, 'the paywall copy uses the sentence itself');
  assert.match(paywall, /PLAN_SCREEN\.limitLine/, 'and the plan screen shows it');
});
