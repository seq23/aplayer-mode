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
let outDir; let pay; let quotes; let sell; let summary; let greet; let menu;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-pay-first-'));
  await build({
    entryPoints: { menu: join(appDir, 'src/content/accountMenu.ts'), greet: join(appDir, 'src/content/greeting.ts'), summary: join(appDir, 'src/billing/planSummary.ts'), pay: join(appDir, 'src/billing/precheckout.ts'), quotes: join(appDir, 'src/content/testimonials.ts'), sell: join(appDir, 'src/content/sell.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  pay = await import(pathToFileURL(join(outDir, 'pay.js')).href);
  summary = await import(pathToFileURL(join(outDir, 'summary.js')).href);
  greet = await import(pathToFileURL(join(outDir, 'greet.js')).href);
  menu = await import(pathToFileURL(join(outDir, 'menu.js')).href);
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
  const claimAt = ret.indexOf('await claimUntilPaid(() => claimPrecheckout({ checkoutId: pending.id');
  const codeAt = ret.indexOf('await sendEmailCode(email);\n    setStage');
  assert.ok(claimAt > 0 && codeAt > claimAt, 'the account must exist (id = checkout id) before the code is sent');
  assert.match(ret, /clearPendingCheckout\(\);\n    router\.replace\(healthDecision \? '\/intake' : '\/health-consent'\)/);
  // The page claims the id RevenueCat returned with, and retries quietly while it confirms.
  assert.match(ret, /returnCheckout\(\(globalThis as \{ location\?: \{ search\?: string \} \}\)\.location\?\.search\)/);
  assert.doesNotMatch(ret, /\? pendingCheckout\(\) : undefined;\n      if \(waiting\) \{ setPending/, 'the signed-out claim never reads the stored id alone');
  assert.match(ret, /PRECHECKOUT_COPY\.confirming/);
  // Email already has an account (0096): no claim-side grant; the code-proven session attaches.
  assert.match(ret, /if \(existingAccount\) \{ onExistingAccount\(\); return; \}/);
  // The attach waits for the 18+ record, re-asks until attached or refused for good, and only then
  // forgets the checkout (9 Oct 2026: a single attach sent before 18+ got a 403 and was swallowed).
  assert.match(ret, /if \(!ageConfirmed\) return;\n/);
  assert.ok(ret.indexOf('if (!ageConfirmed) return;') < ret.indexOf('attachUntilDone(() => attachPrecheckout(target, accessToken)'), 'never attach before 18+ is on the server');
  assert.match(ret, /const result = await attachUntilDone\(\(\) => attachPrecheckout\(target, accessToken\), sleep, undefined, \(\) => active\);\n\s+if \(!active\) return;\n\s+if \(result\.attached\) clearPendingCheckout\(\);/);
  assert.doesNotMatch(ret, /attachPrecheckout\([^)]*\)[^;]*;\s*clearPendingCheckout\(\); \} catch \{/, 'an attach failure is never swallowed');
  const api = await src('src/api/apmApi.ts');
  assert.match(api, /\/v1\/billing\/precheckout\/claim/);
  assert.match(api, /\/v1\/billing\/precheckout\/attach/);
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

test('return page: the app_user_id RevenueCat returned with wins over the stored checkout id', () => {
  const paid = 'd3fa1e01-1047-4b41-8aaa-4a30a8a0fe98';
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    const NOW = 1_791_462_000_000;
    store.set(pay.PRECHECKOUT_STORAGE_KEY, JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', createdAt: NOW - 1000 }));
    assert.equal(pay.checkoutIdFromReturn(`?app_user_id=${paid}`), paid);
    assert.equal(pay.checkoutIdFromReturn(`?foo=1&app_user_id=${paid.toUpperCase()}`), paid);
    assert.equal(pay.returnCheckout(`?app_user_id=${paid}`, NOW).id, paid);
    assert.equal(JSON.parse(store.get(pay.PRECHECKOUT_STORAGE_KEY)).id, paid, 'kept for a reload');
    // Malformed or absent: the stored id, never a guess.
    for (const bad of ['?app_user_id=not-a-uuid', '?app_user_id=', '', undefined, '?app_user_id=%24RCAnonymousID%3Aabc']) assert.equal(pay.checkoutIdFromReturn(bad), undefined, String(bad));
    assert.equal(pay.returnCheckout('?app_user_id=nope', NOW).id, paid);
    store.clear();
    assert.equal(pay.returnCheckout('', NOW), undefined);
  } finally { delete globalThis.localStorage; }
});

test('return page: not_paid right after paying is re-asked quietly for about a minute, within the server limit', async () => {
  const schedule = pay.CLAIM_RETRY_SCHEDULE_S;
  assert.ok(schedule.at(-1) >= 50 && schedule.at(-1) <= 60, 'about a minute');
  assert.ok(schedule.length + 1 <= 6, 'never more than the 6-a-minute claim limit');
  assert.equal(schedule[0], 5);
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  // RevenueCat records it on the third ask: the buyer never sees not_paid.
  let calls = 0;
  const r = await pay.claimUntilPaid(async () => (++calls < 3 ? { claimed: false, error: 'not_paid' } : { claimed: true }), sleep);
  assert.deepEqual([r.claimed, calls], [true, 3]);
  assert.deepEqual(slept, [5000, 5000]);
  // Never recorded: every scheduled ask, then the message.
  calls = 0; slept.length = 0;
  const never = await pay.claimUntilPaid(async () => { calls += 1; return { claimed: false, error: 'not_paid' }; }, sleep);
  assert.deepEqual([never.error, calls, slept.reduce((a, b) => a + b, 0)], ['not_paid', schedule.length + 1, schedule.at(-1) * 1000]);
  // Any other answer (wrong email, already claimed) is shown at once.
  calls = 0;
  const mismatch = await pay.claimUntilPaid(async () => { calls += 1; return { claimed: false, error: 'email_mismatch' }; }, sleep);
  assert.deepEqual([mismatch.error, calls], ['email_mismatch', 1]);
});

test('Settings home names the current plan and its status, from the plan screen\'s own source, and taps through', async () => {
  assert.equal(summary.planSummary({ displayName: 'Executive Suite', status: 'active' }), 'Executive Suite · active');
  assert.equal(summary.planSummary({ displayName: 'Executive Roundtable', status: 'trialing' }), 'Executive Roundtable · active');
  assert.equal(summary.planSummary({ displayName: 'Life OS', status: 'past_due' }), 'Life OS · payment problem');
  assert.equal(summary.planSummary({ displayName: 'Life OS', status: 'expired' }), 'Life OS · ended');
  assert.equal(summary.planSummary({ displayName: 'Life OS', status: 'weird' }), 'Life OS · not active');
  assert.equal(summary.planSummary(undefined), undefined);
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /fetchProductPlan\(accessToken\)\.then\(\(next\) => \{ if \(active\) setProduct\(next\); \}\)/, 'the same GET /v1/product/plan the plan screen reads');
  assert.match(settings, /<ListRow icon="credit-card" title=\{planSummary\(product\?\.entitlement\) \?\? 'Loading your plan…'\}[^>]*onPress=\{\(\) => router\.push\('\/settings\/plan'\)\}/);
  // One set of status words for both screens.
  const plan = await src('app/settings/plan.tsx');
  assert.match(plan, /import \{ PLAN_STATUS_WORDS as STATUS_WORDS \} from '\.\.\/\.\.\/src\/billing\/planSummary'/);
  assert.doesNotMatch(plan, /const STATUS_WORDS/);
});

test('Today: the greeting and the date are in HER time zone and locale, never UTC', async () => {
  // 03:30 UTC on Sat 10 Oct 2026 is still Friday evening in Chicago and already Saturday afternoon in Tokyo.
  const now = new Date('2026-10-10T03:30:00Z');
  assert.equal(greet.todayLine(now, 'America/Chicago', 'en-US'), 'Friday, October 9');
  assert.equal(greet.todayLine(now, 'Asia/Tokyo', 'en-US'), 'Saturday, October 10');
  assert.equal(greet.todayLine(now, 'UTC', 'en-US'), 'Saturday, October 10');
  assert.equal(greet.hourIn(now, 'America/Chicago'), 22);
  assert.equal(greet.greeting(greet.hourIn(now, 'America/Chicago')), 'Good evening');
  assert.equal(greet.greeting(greet.hourIn(new Date('2026-10-09T14:00:00Z'), 'America/Chicago')), 'Good morning');
  // Her locale, not a fixed one.
  assert.equal(greet.todayLine(now, 'America/Chicago', 'fr-FR'), 'vendredi 9 octobre');
  // A bad zone never throws: the device's own zone.
  assert.equal(typeof greet.todayLine(now, 'Not/AZone', 'en-US'), 'string');
  const today = await src('app/(tabs)/today.tsx');
  assert.match(today, /title=\{`\$\{greeting\(hourIn\(now, graph\.identity\.timezone\)\)\}, \$\{name\}\.`\}/);
  assert.match(today, /subtitle=\{`\$\{todayLine\(now, graph\.identity\.timezone\)\} · /);
  assert.doesNotMatch(today, /new Date\(\)\.getHours\(\)/, 'never the device clock alone');
});

test('the typed name is saved to the identity Today reads, for a new and an existing account, and editable in Settings', async () => {
  const session = await src('src/state/session.tsx');
  // Every sign-in path's saveName also writes PUT /v1/profile/name with the signed-in token.
  assert.match(session, /const token = \(await supabase\(\)\.auth\.getSession\(\)\)\.data\.session\?\.access_token;\n\s+if \(!token\) throw new Error\('not signed in'\);\n\s+await saveDisplayName\(clean, token\);/);
  assert.match(session, /updateName: \(name\) => saveName\(name, true\)/);
  const api = await src('src/api/apmApi.ts');
  assert.match(api, /request\('\/v1\/profile\/name', accessToken, \{ method: 'PUT', body: JSON\.stringify\(\{ displayName \}\) \}\)/);
  // /billing/return asks for the name on BOTH paths and passes it to the code check.
  const ret = await src('app/billing/return.tsx');
  assert.match(ret, /\n\s+<TextField accessibilityLabel="First name" value=\{name\}/, 'never hidden for an existing account');
  assert.match(ret, /await verifyEmailCode\(email, code, name\);\n\s+\/\/ An existing account/);
  // Settings: edit it.
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /<TextField accessibilityLabel="Your first name" value=\{shownName\}/);
  assert.match(settings, /await updateName\(shownName\); await refresh\(\)/);
});

test('existing-account attach (9 Oct 2026 repro): a 403 before 18+ reaches the server is re-asked until it attaches', async () => {
  // The live failure: the first attach answered 403 age_confirmation_required, nothing asked again.
  const answers = [
    Object.assign(new Error('Confirm you are 18 or older.'), { status: 403, code: 'age_confirmation_required' }),
    Object.assign(new Error('busy'), { status: 429, code: 'rate_limited' }),
    { attached: true, outcomes: ['applied'] },
  ];
  let calls = 0; const slept = [];
  const result = await pay.attachUntilDone(async () => { const a = answers[calls++]; if (a instanceof Error) throw a; return a; }, async (ms) => { slept.push(ms); });
  assert.deepEqual(result, { attached: true });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [4000, 6000]);
  // Never more than 6 calls a minute (the server's per-checkout limit), about a minute in all.
  assert.equal(pay.ATTACH_RETRY_SCHEDULE_S.length + 1, 6);
  assert.ok(pay.ATTACH_RETRY_SCHEDULE_S.at(-1) < 60);
  // A final answer stops at once and is reported, never retried: the email-match rule stands.
  for (const code of ['email_mismatch', 'already_claimed']) {
    let n = 0;
    const refused = await pay.attachUntilDone(async () => { n += 1; throw Object.assign(new Error('Use the same email address you entered at checkout.'), { status: 409, code }); }, async () => {});
    assert.equal(n, 1); assert.equal(refused.attached, false); assert.equal(refused.error, code);
  }
  // Leaving the page stops the retries.
  let m = 0;
  const left = await pay.attachUntilDone(async () => { m += 1; throw Object.assign(new Error('x'), { code: 'not_paid' }); }, async () => {}, undefined, () => false);
  assert.equal(m, 1); assert.equal(left.error, 'not_paid');
  assert.equal(pay.attachErrorCode(new TypeError('Failed to fetch')), 'unavailable');
});

test('return page: a visible wait, a clear next step on timeout, and another signed-in email is named, never attached', async () => {
  const ret = await src('app/billing/return.tsx');
  // Waiting moves (spinner) and says how long.
  assert.match(ret, /<LoadingState label=\{WEB_CHECKOUT_COPY\.confirming\} \/>\n\s+<Muted align="center">\{RETURN_COPY\.waitingHint\}<\/Muted>/);
  assert.match(pay.RETURN_COPY.waitingHint, /up to a minute/);
  // Timeout: what happens next, plus Check again (one more round of the same checks).
  assert.match(ret, /<Button label=\{RETURN_COPY\.checkAgain\} icon="refresh-cw" onPress=\{\(\) => setRound\(\(n\) => n \+ 1\)\} \/>/);
  assert.match(ret, /attaching, ageConfirmed, round\]\);/);
  assert.doesNotMatch(pay.RETURN_COPY.stillConfirming, /as soon as it is confirmed/);
  assert.match(pay.RETURN_COPY.stillConfirming, /Check again/);
  // Signed in as someone else: the page says so and offers sign-out; the server refused the attach.
  assert.equal(pay.RETURN_COPY.otherAccount('a@example.com'), "You're signed in as a@example.com. This purchase was made with another email — sign out to attach it.");
  assert.match(ret, /else if \(result\.error === 'email_mismatch' && !attaching\) \{ setView\('otherAccount'\); return; \}/);
  assert.match(ret, /RETURN_COPY\.otherAccount\(user\?\.email/);
  // The id RevenueCat returned with is checked even when someone is already signed in.
  assert.match(ret, /const fromUrl = payFirst \? checkoutIdFromReturn\(\(globalThis as \{ location\?: \{ search\?: string \} \}\)\.location\?\.search\) : undefined;/);
  // An anonymous draft session is not an account: the buyer still claims.
  assert.match(ret, /const signedIn = Boolean\(accessToken\) && !isAnonymous;/);
});

test('the typed name reaches the profile once 18+ is on the server, and mends a blank profile name', async () => {
  assert.equal(greet.nameToCarry('', 'Boss'), 'Boss');
  assert.equal(greet.nameToCarry('  ', '  Boss Bitch '), 'Boss Bitch');
  assert.equal(greet.nameToCarry('Simone', 'Boss'), undefined, 'a saved name is never overwritten');
  assert.equal(greet.nameToCarry('', ''), undefined);
  assert.equal(greet.nameToCarry(undefined, 'x'.repeat(80)).length, 60);
  const consent = await src('src/state/consent.tsx');
  assert.match(consent, /if \(!signedIn \|\| !accessToken \|\| !server\?\.ageConfirmedAt \|\| syncStatus !== 'ready' \|\| !user \|\| graph\.identity\.userId !== user\.id\) return;/);
  assert.match(consent, /const name = nameToCarry\(graph\.identity\.displayName, meta\?\.display_name \?\? meta\?\.given_name\);/);
  assert.match(consent, /void saveDisplayName\(name, accessToken\)\.then\(\(\) => refresh\(\)\)/);
  // One account's typed name never carries to the next account on this device.
  const session = await src('src/state/session.tsx');
  assert.match(session, /if \(!signOutError\) setFirstName\(undefined\);/);
});

test('account menu: top right of every signed-in page, with email, plan and Sign out', async () => {
  for (const path of ['/today', '/radar', '/goals', '/apm', '/settings', '/settings/plan', '/billing/return', '/diary']) assert.equal(menu.accountMenuShown(path, true), true, path);
  for (const path of ['/', '/welcome', '/age', '/join', '/health-consent', '/intake', '/account', '/welcome/']) assert.equal(menu.accountMenuShown(path, true), false, path);
  assert.equal(menu.accountMenuShown('/today', false), false, 'never for an anonymous draft or a signed-out visitor');
  assert.equal(menu.accountInitial('cryptoclearr@gmail.com'), 'C');
  assert.equal(menu.accountInitial(''), '?');
  const layout = await src('app/_layout.tsx');
  assert.ok(layout.indexOf('<AccountMenu />') > layout.indexOf('</Stack>') && layout.indexOf('<AccountMenu />') < layout.indexOf('<ConsentGate />'));
  const comp = await src('src/components/AccountMenu.tsx');
  assert.match(comp, /<Small strong>\{user\.email\}<\/Small>/);
  assert.match(comp, /planSummary\(product\.entitlement\) \?\? 'No plan yet'/);
  assert.match(comp, /fetchProductPlan\(accessToken\)/, 'the plan comes from the same source as Settings');
  assert.match(comp, /<Button label=\{busy \? 'Signing out…' : 'Sign out'\}/);
  assert.match(comp, /accountMenuShown\(pathname, status === 'signed_in' && !isAnonymous && Boolean\(user\?\.email\)\)/);
});
