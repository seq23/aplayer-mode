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

// Store screenshots (store/app-store/screenshots, store/google-play/screenshots): every file the
// listings name is there, at the size the store takes (App Store Connect APP_IPHONE_67 1320x2868;
// Play phone 1080x1920), without an alpha channel (App Store Connect refuses one), and in count.
function pngProblems(buf, want) {
  if (!buf || buf.length < 26 || buf.toString('latin1', 1, 4) !== 'PNG') return ['not a PNG'];
  const out = [];
  const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (w !== want[0] || h !== want[1]) out.push(`${w}x${h}, not ${want[0]}x${want[1]}`);
  if (buf[25] === 4 || buf[25] === 6) out.push('has an alpha channel');
  return out;
}
async function shotProblems(files, want, [min, max]) {
  const out = [];
  if (files.length < min || files.length > max) out.push(`${files.length} screenshots, the store takes ${min} to ${max}`);
  for (const file of files) {
    const buf = await readFile(new URL(`../store/${file}`, import.meta.url)).catch(() => undefined);
    for (const p of buf ? pngProblems(buf, want) : ['missing']) out.push(`${file}: ${p}`);
  }
  return out;
}

test('every listed store screenshot is there, at the store\'s size, with no alpha, in count', async () => {
  assert.deepEqual(await shotProblems(listing.screenshots.map((s) => s.file), [1320, 2868], [1, 10]), []);
  assert.deepEqual(await shotProblems(play.graphics.phoneScreenshots, [1080, 1920], [2, 8]), []);
  assert.deepEqual(listing.screenshots.map((s) => s.order), listing.screenshots.map((_, i) => i + 1), 'orders run 1..n');
});

test('the screenshot check fails on a missing file, a wrong size and an alpha channel (negative proof)', async () => {
  assert.ok((await shotProblems(['app-store/screenshots/none.png'], [1320, 2868], [1, 10])).some((p) => p.endsWith('missing')));
  assert.ok((await shotProblems(play.graphics.phoneScreenshots, [1320, 2868], [1, 10])).some((p) => p.includes('1080x1920, not 1320x2868')));
  const rgba = Buffer.from(await readFile(new URL(`../store/${play.graphics.phoneScreenshots[0]}`, import.meta.url)));
  rgba[25] = 6;
  assert.deepEqual(pngProblems(rgba, [1080, 1920]), ['has an alpha channel']);
  assert.ok((await shotProblems([], [1080, 1920], [2, 8]))[0].startsWith('0 screenshots'));
});

// The review notes (store/app-review-notes.md) are what App Review and Play read to reach every
// paid state: they fit Apple's 4,000-character Notes field, and every button or label they put in
// quotes is in the app (app/, src/) or in the review account's sample data (migration 0105).
const notesDoc = await readFile(new URL('../store/app-review-notes.md', import.meta.url), 'utf8');
const textBlocks = [...notesDoc.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
async function appText() {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  for (const root of ['app', 'src']) {
    for (const entry of await readdir(new URL(`../${root}/`, import.meta.url), { recursive: true })) if (/\.tsx?$/.test(entry)) files.push(`../${root}/${entry}`);
  }
  const parts = await Promise.all(files.map((f) => readFile(new URL(f, import.meta.url), 'utf8')));
  parts.push(await readFile(new URL('../../../services/api/migrations/0105_review_account_suite.sql', import.meta.url), 'utf8'));
  // A label written as 'I\'m 18 or older' in code reads I'm 18 or older on screen.
  return parts.join('\n').replaceAll("\\'", "'");
}
export function unquotedLabels(notes, source) {
  const said = [...notes.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]);
  // "3 · Prepare": the level number is drawn beside the label (autonomy.tsx `${current} · ${labels[current]}`).
  return said.filter((label) => !source.includes(label.replace(/^\d · /, '')));
}

test('the review notes fit App Store Connect and every label they quote is in the build', async () => {
  assert.equal(textBlocks.length, 2, 'the App Store notes and the Play App access note');
  const [apple, google] = textBlocks;
  assert.ok([...apple].length <= 4000, `App Store notes are ${[...apple].length} characters; the field takes 4,000`);
  assert.match(apple, /Your review code/, 'the notes name the box the reviewer types the code in');
  assert.match(google, /Your review code/);
  const source = await appText();
  assert.deepEqual(unquotedLabels(apple, source), []);
  assert.deepEqual(unquotedLabels(google, source), []);
  assert.doesNotMatch(notesDoc, /\b\d{6}\b(?!-)/, 'no 6-digit code is written in the repo');
});

test('the label check fails on a button the app does not have (negative proof)', async () => {
  assert.deepEqual(unquotedLabels('Tap "Start my free trial" then "Verify and continue".', await appText()), ['Start my free trial']);
});

// App Review 27 Nov 2026 (F1): the notes told the reviewer to stop at "3 · Prepare", and the server
// shows Approve only at the level an approval asks for (approvalAvailable, services/api/src/index.ts).
// The level the notes name for the Executive Suite step is read here, never assumed.
export function notesSuiteLevel(notes) {
  const line = notes.split('\n').find((l) => l.includes('"Goal checklists and task moves"'));
  return Number(line?.match(/until it shows "(\d) · [^"]+"/)?.[1] ?? NaN);
}
test('the notes raise "Goal checklists and task moves" to the level Approve needs on the server', async () => {
  const server = await readFile(new URL('../../../services/api/src/index.ts', import.meta.url), 'utf8');
  const needed = Number(server.match(/approvalAvailable:[\s\S]{0,400}?requestedLevel: (\d)/)?.[1]);
  assert.ok(needed >= 1, 'read the level an approval asks for');
  assert.equal(notesSuiteLevel(textBlocks[0]), needed);
  assert.equal(notesSuiteLevel('tap "Increase to" until it shows "3 · Prepare"'), NaN, 'a line without the control name is not read');
  assert.equal(notesSuiteLevel('"Goal checklists and task moves": tap "Increase to" until it shows "3 · Prepare".'), 3);
});

// App Review 27 Nov 2026 (F3, Guideline 3.1.2): an auto-renewing subscription's listing names each
// plan's price and period, how renewal works, and links the Terms of Use and the Privacy Policy. The
// prices are read from @apm/policy (what the paywall and the stores charge), never typed here.
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
export async function subscriptionProblems(text, store) {
  const policy = await readFile(new URL('../../../packages/policy/src/index.ts', import.meta.url), 'utf8');
  const out = [];
  const plans = [...policy.matchAll(/displayName: '([^']+)', tagline: '[^']*', monthlyUsdCents: (\d+), annualUsdCents: (\d+)/g)];
  if (plans.length !== 3) out.push(`read ${plans.length} plans from PLAN_PRICES, not 3`);
  for (const [, name, monthly, annual] of plans) {
    if (!text.includes(`${name} ${usd(Number(monthly))}/month or ${usd(Number(annual))}/year`)) out.push(`${name}: price missing or wrong`);
  }
  const intro = policy.match(/introductory: \{ monthlyUsdCents: (\d+), months: (\d+)/);
  if (!intro || !text.includes(`pay ${usd(Number(intro[1]))}/month for the first ${intro[2]} months`)) out.push('intro offer missing or wrong');
  const renewal = store === 'apple' ? 'renew automatically unless cancelled at least 24 hours before the end of the current period' : 'renew automatically until cancelled';
  if (!text.includes(renewal)) out.push('renewal terms missing');
  if (!text.includes('Terms of Use: https://app.aplayermode.com/terms')) out.push('Terms of Use link missing');
  if (!text.includes('Privacy Policy: https://app.aplayermode.com/privacy')) out.push('Privacy Policy link missing');
  return out;
}
test('both listings carry every plan price, the renewal terms and the Terms of Use and Privacy links', async () => {
  assert.deepEqual(await subscriptionProblems(listing.description, 'apple'), []);
  assert.deepEqual(await subscriptionProblems(play.fullDescription, 'google'), []);
  const workflow = await readFile(new URL('../../../.github/workflows/app-preview.yml', import.meta.url), 'utf8');
  const appTerms = workflow.match(/EXPO_PUBLIC_TERMS_URL: (\S+)/)?.[1];
  assert.equal(listing.termsOfUseUrl, appTerms, 'the listing links the Terms the app links');
  assert.equal(play.termsOfUseUrl, appTerms);
  assert.equal(listing.privacyPolicyUrl, play.privacyPolicyUrl);
});
test('the subscription check fails on a wrong price, no renewal terms and no Terms link (negative proof)', async () => {
  const problems = await subscriptionProblems(listing.description.replace('$39.99/month', '$29.99/month').replace('Terms of Use: ', '').replace('at least 24 hours', 'soon'), 'apple');
  assert.deepEqual(problems, ['Executive Suite: price missing or wrong', 'renewal terms missing', 'Terms of Use link missing']);
});

// App Review 27 Nov 2026 (F6): the tap-through never walked the notes' Executive Suite steps. The
// review-path flow (tap-through-review.json) is run by the preview workflow and reaches every label
// the notes' Suite steps quote.
test('the preview workflow walks the notes\' Executive Suite labels in tap-through-review.json', async () => {
  const flow = JSON.parse(await readFile(new URL('../../../tap-through-review.json', import.meta.url), 'utf8'));
  const workflow = await readFile(new URL('../../../.github/workflows/app-preview.yml', import.meta.url), 'utf8');
  assert.match(workflow, /flow_file: tap-through-review\.json/, 'the preview workflow runs the review-path flow');
  const steps = flow.journeys.flatMap((j) => j.steps);
  assert.ok(steps.length <= 40, `${steps.length} steps; one review takes 40`);
  const walked = JSON.stringify(steps);
  const suite = textBlocks[0].split('\n').filter((l) => /^\s+[12]\. /.test(l)).join('\n');
  const labels = [...suite.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((l) => !/\(sample\)/.test(l));
  assert.ok(labels.length >= 4, `read the Suite step labels: ${labels}`);
  for (const label of labels) assert.ok(walked.includes(label.replace(/^\d · /, '')), `the flow reaches "${label}"`);
});
