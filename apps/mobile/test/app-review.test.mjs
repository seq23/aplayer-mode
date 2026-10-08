// The app review (docs/35-APP-REVIEW.md): one test per CONFIRMED P0–P2 fix, plus the
// App Store items. Pure modules are bundled with esbuild and exercised; screen wiring
// that only the source can show is pinned against the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const run = promisify(execFile);
const appDir = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const src = (path) => readFile(join(appDir, path), 'utf8');
let outDir; let errors; let api; let access; let external; let osChange; let greet;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-app-review-'));
  await build({
    entryPoints: {
      errors: join(appDir, 'src/api/errors.ts'),
      api: join(appDir, 'src/api/apmApi.ts'),
      access: join(appDir, 'src/billing/access.ts'),
      osChange: join(appDir, 'src/content/osChange.ts'),
      greeting: join(appDir, 'src/content/greeting.ts'),
    },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  // external.ts imports react-native; give it a stub Linking that records what it opened.
  await build({
    entryPoints: { external: join(appDir, 'src/links/external.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
    plugins: [{ name: 'rn-stub', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rn', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Linking = { opened: [], async openURL(u) { this.opened.push(u); } };', loader: 'js' }));
    } }],
  });
  process.env.EXPO_PUBLIC_APM_API_URL = 'https://api.test';
  errors = await import(pathToFileURL(join(outDir, 'errors.js')).href);
  api = await import(pathToFileURL(join(outDir, 'api.js')).href);
  access = await import(pathToFileURL(join(outDir, 'access.js')).href);
  external = await import(pathToFileURL(join(outDir, 'external.js')).href);
  osChange = await import(pathToFileURL(join(outDir, 'osChange.js')).href);
  greet = await import(pathToFileURL(join(outDir, 'greeting.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- E2–E4: the API client
test('E4: a person never sees an error code, an HTTP status or a request id', () => {
  const cases = [
    [403, { error: 'life_os_required' }], [403, { error: 'entitlement_required', message: 'Your plan does not include the daily loop right now.' }],
    [401, { error: 'unauthorized' }], [500, {}], [409, { error: 'install_in_progress' }], [400, { error: 'invalid_request', message: 'invalid_request' }],
    [404, { error: 'not_found' }], [429, {}], [418, { error: 'some_new_code' }],
  ];
  for (const [status, body] of cases) {
    const message = errors.friendlyApiMessage(status, body);
    assert.ok(message.length > 10, `${status} ${JSON.stringify(body)} has words`);
    assert.doesNotMatch(message, /\(\d{3}\)|_[a-z]+_|^[a-z_]+$|request failed|·/, `${status} ${JSON.stringify(body)} → "${message}" leaks a code`);
  }
  const error = new errors.ApiError(403, { error: 'life_os_required' }, 'req-1');
  assert.equal(error.status, 403); assert.equal(error.code, 'life_os_required'); assert.equal(error.requestId, 'req-1');
  assert.doesNotMatch(error.message, /req-1|403/);
  assert.equal(errors.plainError(new Error('EXPO_PUBLIC_APM_API_URL is not configured'), 'Fallback.'), 'Fallback.');
});

test('E3: a 401 refreshes the session once and retries; E2: a stalled request gives up', async () => {
  const original = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      const auth = new Headers(init.headers).get('authorization');
      seen.push(auth);
      if (auth === 'Bearer old') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ graph: { ok: true } }), { status: 200 });
    };
    let refreshed = 0;
    api.setAccessTokenRefresher(async () => { refreshed += 1; return 'fresh'; });
    assert.deepEqual(await api.fetchLifeGraph('old'), { ok: true });
    assert.deepEqual(seen, ['Bearer old', 'Bearer fresh']);
    assert.equal(refreshed, 1);
    // Without a refresher the 401 surfaces as words, never "unauthorized (401)".
    api.setAccessTokenRefresher(undefined);
    await assert.rejects(api.fetchLifeGraph('old'), (e) => e.status === 401 && /Sign in again/.test(e.message));

    // A request that never answers is aborted at the ceiling and explained.
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    api.setRequestTimeoutMs(30);
    await assert.rejects(api.fetchLifeGraph('t'), (e) => e.status === 0 && /taking too long/.test(e.message));
    globalThis.fetch = async () => { throw new TypeError('Network request failed'); };
    await assert.rejects(api.fetchLifeGraph('t'), (e) => e.status === 0 && /offline/.test(e.message));
  } finally { globalThis.fetch = original; api.setRequestTimeoutMs(api.REQUEST_TIMEOUT_MS); api.setAccessTokenRefresher(undefined); }
  assert.equal(api.REQUEST_TIMEOUT_MS, 20_000);
});

// ---------------------------------------------------------------- E1: offline launch of an installed OS
test('E1: an installed user who opens the app offline gets "Try again", never the setup again', async () => {
  const index = await src('app/index.tsx');
  assert.match(index, /installedHere = draft\.installedVersion !== undefined && draft\.installedVersion !== null/);
  assert.match(index, /syncStatus === 'error' && \(!started \|\| installedHere\)/);
  assert.match(index, /label="Try again"/);
});

// ---------------------------------------------------------------- E5/E6: plan gating never dead-ends
test('E5: daily-loop access mirrors the server; Today offers the plan instead of a check-in it would refuse', async () => {
  const now = new Date('2026-10-07T12:00:00Z');
  const ok = (e) => access.hasDailyLoopAccess(e, now);
  assert.equal(ok(undefined), false, 'a new account with no plan');
  assert.equal(ok({ plan: 'chief_of_staff', status: 'expired' }), false);
  assert.equal(ok({ plan: 'chief_of_staff', status: 'active' }), true);
  assert.equal(ok({ plan: 'autopilot', status: 'trialing' }), true);
  assert.equal(ok({ plan: 'beta', status: 'active' }), false, 'beta needs an end date');
  assert.equal(ok({ plan: 'beta', status: 'active', currentPeriodEnd: '2026-12-01T00:00:00Z' }), true);
  assert.equal(ok({ plan: 'beta', status: 'active', currentPeriodEnd: '2026-10-01T00:00:00Z' }), false, 'an ended beta window');
  assert.equal(ok({ plan: 'beta', status: 'active', provider: 'app_store', currentPeriodEnd: '2026-12-01T00:00:00Z' }), false);
  for (const canBuy of [true, false]) {
    const copy = access.noPlanCopy(canBuy);
    assert.match(copy.title, /Your OS is ready/);
    assert.ok(copy.action.length > 3);
    assert.doesNotMatch(`${copy.title} ${copy.body}`, /Continue to Day 1|Expo|configured/);
  }
  const server = await readFile(join(repoRoot, 'services/api/src/entitlement.ts'), 'utf8');
  assert.match(server, /entitlement\.plan === 'beta'/, 'the server rule the app mirrors is still the beta-window rule');
  const today = await src('app/(tabs)/today.tsx');
  assert.match(today, /const loopOpen = hasDailyLoopAccess\(graph\.entitlement\)/);
  assert.match(today, /graph\.personalOS && !loopOpen \?/);
  assert.match(today, /loopOpen && !todayLoop\.checkedIn && !todayLoop\.closed/, 'no check-in without a plan');
  assert.match(today, /todayLoop && loopOpen \?/, 'no close-the-day without a plan');
  assert.match(today, /router\.push\('\/settings\/plan'\)/);
});

test('E6: the onboarding paywall always has a way on, and an anonymous session can save its account right there', async () => {
  const paywall = await src('src/billing/PlanChoice.tsx');
  assert.match(paywall, /\{onboarding && !CLOSED_BETA_BUILD \? \(/, 'the way on is shown on every store build, not only when purchases are unavailable');
  assert.match(paywall, /Decide later, show me Today/);
  assert.doesNotMatch(paywall, /Continue to Day 1/);
  // Store builds AND card-checkout builds (web, sideload APK): a subscription belongs to an account.
  assert.match(paywall, /\(availability\.available \|\| cardCheckout\.kind === 'ready'\) && isAnonymous \? \([\s\S]*<AccountPanel/);
  assert.match(paywall, /label="Try again"/, 'a failed load can be retried');
});

// ---------------------------------------------------------------- App Store items
test('App Store: account deletion is two taps from Settings and calls the real data-rights delete', async () => {
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /label="Delete my account"[^>]*onPress=\{\(\) => setConfirmDelete\(true\)\}/, 'tap 1');
  assert.match(settings, /label=\{busy === 'delete' \? 'Deleting…' : 'Delete everything'\}[^>]*onPress=\{\(\) => void deleteAccount\(\)\}/, 'tap 2');
  assert.match(settings, /await requestDeletion\(accessToken\)/);
  const apiSource = await src('src/api/apmApi.ts');
  assert.match(apiSource, /requestDeletion[\s\S]{0,200}'\/v1\/privacy\/delete'[\s\S]{0,80}confirmation: 'DELETE'/);
  const exportDelete = await src('app/settings/privacy/export-delete.tsx');
  assert.match(exportDelete, /setConfirmDelete\(true\)/, 'the Privacy page asks before deleting too');
});

test('App Store: Restore Purchases is in Settings as well as on the paywall', async () => {
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /'Restore purchases'/);
  assert.match(settings, /await restoreStorePurchases\(\)/);
  assert.match(await src('src/billing/PlanChoice.tsx'), /Restore purchases/);
});

test('App Store: "Report this" on every coach reply that has a stored turn', async () => {
  const coach = await src('app/(tabs)/apm.tsx');
  assert.match(coach, /turn\.role === 'apm' && turn\.turnId/);
  assert.match(coach, />Report this</);
  assert.match(coach, /await reportCoachReply\(\{ turnId, reason \}, accessToken\)/);
  assert.match(await src('src/api/apmApi.ts'), /'\/v1\/apm\/coach\/report'/);
});

test('App Store: external links open in the system browser through one helper; https only', async () => {
  assert.equal(external.externalUrl({ kind: 'web', url: 'https://aplayermode.com/privacy' }), 'https://aplayermode.com/privacy');
  assert.equal(external.externalUrl({ kind: 'web', url: 'http://aplayermode.com' }), undefined, 'never plain http');
  assert.equal(external.externalUrl({ kind: 'web', url: 'javascript:alert(1)' }), undefined);
  assert.equal(external.externalUrl({ kind: 'call', number: '988' }), 'tel:988');
  assert.equal(external.externalUrl({ kind: 'text', number: '741741' }), 'sms:741741', 'a "text" crisis line opens Messages, not the dialer');
  assert.equal(external.externalUrl({ kind: 'call', number: '9; rm' }), undefined);
  assert.equal(await external.openExternal({ kind: 'web', url: 'https://example.org/terms' }), true);
});

test('App Store: iPad decision is supportsTablet:false; no placeholder Household card', async () => {
  const appJson = JSON.parse(await src('app.json'));
  assert.equal(appJson.expo.ios.supportsTablet, false);
  const plan = await src('app/settings/plan.tsx');
  assert.doesNotMatch(plan, /Household|Later<|not activating/);
  assert.doesNotMatch(await src('app/settings/index.tsx'), /Household OS is later/);
});

test('presubmit:ios passes on the app and FAILS on each violation (negative proof)', async () => {
  const script = join(repoRoot, 'scripts/presubmit-ios.mjs');
  const ok = await run(process.execPath, [script, appDir]);
  assert.match(ok.stdout, /presubmit:ios passed/);
  const copy = await mkdtemp(join(tmpdir(), 'apm-presubmit-'));
  try {
    await cp(join(appDir, 'app'), join(copy, 'app'), { recursive: true });
    await cp(join(appDir, 'src'), join(copy, 'src'), { recursive: true });
    await cp(join(appDir, 'app.json'), join(copy, 'app.json'));
    await cp(join(appDir, 'package.json'), join(copy, 'package.json'));
    const breaks = [
      ['app/coming.tsx', 'export default () => "Coming soon";', /placeholder copy/],
      ['src/pay.ts', "import Stripe from 'stripe';", /Stripe/],
      ['src/link.ts', "export const site = 'https://aplayermode.com';", /http\(s\) link outside/],
      ['src/open.ts', "import { Linking } from 'react-native'; Linking.openURL('x');", /Linking\.openURL outside/],
      ['src/web.tsx', "import * as W from 'expo-web-browser'; W.openBrowserAsync('x');", /in-app webview/],
    ];
    for (const [file, body, expected] of breaks) {
      await writeFile(join(copy, file), body);
      await assert.rejects(run(process.execPath, [script, copy]), (e) => { assert.match(e.stderr, expected); return true; }, `${file} must fail the check`);
      await rm(join(copy, file));
    }
    const appJson = JSON.parse(await readFile(join(copy, 'app.json'), 'utf8'));
    appJson.expo.ios.supportsTablet = true;
    await writeFile(join(copy, 'app.json'), JSON.stringify(appJson));
    await assert.rejects(run(process.execPath, [script, copy]), (e) => /supportsTablet must be false/.test(e.stderr));
    await assert.rejects(run(process.execPath, [script, join(copy, 'nothing-here')]), (e) => /NO SOURCE FILES/.test(e.stderr), 'zero files is a failure, not a pass');
  } finally { await rm(copy, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the rest of the CONFIRMED fixes
test('E7–E13: confirmation, retries, double-submit, keyboard, sign-out, install refusal', async () => {
  const review = await src('app/review.tsx');
  assert.match(review, /if \(busy \|\| done\) return;/, 'E11: the debrief records once');
  assert.match(review, /loadFailed \? <Card><Button label="Try again"/, 'E11: a failed load can be retried, not "Loading…" forever');
  const ui = await src('src/components/ui.tsx');
  assert.match(ui, /<KeyboardAvoidingView behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/, 'E10');
  assert.match(ui, /keyboardShouldPersistTaps="handled"/);
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /catch \(cause\) \{ setError\(plainError\(cause, 'Sign-out did not finish/, 'E12');
  const store = await src('src/intake/store.tsx');
  assert.match(store, /if \(status !== undefined && status >= 400 && status < 500 && status !== 409\) throw error;\s*\/\/ Offline/, 'E13: a refusal is thrown BEFORE the install is queued');
  const coach = await src('app/(tabs)/apm.tsx');
  assert.match(coach, /setMessage\(input\.message\)/, 'E9: a failed send puts the words back');
  assert.match(coach, /focus: \(focus\.trim\(\) \|\| suggestedFocus\)/, 'U2: APM names the Deep Work task');
  const layout = await src('app/_layout.tsx');
  for (const name of ['diary', 'review', 'settings/os']) assert.match(layout, new RegExp(`name="${name}" options=\\{\\{ title: '`), `E14: ${name} has a title`);
});

test('U1/U4/U5: APM fills in the area, the Drafting Room reads as words, Day 90 is one tap', async () => {
  const goals = await src('app/(tabs)/goals.tsx');
  assert.match(goals, /classifySuggestedArea\(title\)\.area/);
  assert.match(goals, /Change the area/);
  for (const [field, proposed] of [
    ['morning_sequence', ['Water', 'Walk']], ['coaching_firmness', 'high_pressure'], ['day_start', 'hard'], ['tracks', ['billionaire_mindset']],
    ['pillar', { name: 'movement', critical: true, minimumFloor: 'Walk 10 minutes' }], ['track_settings', { hardStop: '18:00' }],
    ['show_seven_day_snapshot', false], ['review_day', 'Sunday'], ['north_star', 'Be present'], ['coaching_reminder_days', 7],
  ]) {
    const text = osChange.describeOsChange(field, proposed);
    assert.doesNotMatch(text, /[{}[\]"]{2}|\{"|_/, `${field} → "${text}" is not JSON or a key`);
    assert.ok(text.length > 5);
  }
  assert.equal(osChange.describeOsChange('tracks', ['billionaire_mindset']), 'Tracks: Billionaire High Performance Coach Track');
  const today = await src('app/(tabs)/today.tsx');
  assert.match(today, /const chosenDecision = decision \?\? decisionDue\?\.recommended;/, "APM's recommendation is pre-selected");
  assert.doesNotMatch(today, /decisionReason\.trim\(\)\.length >= 3 && run/, 'the button never silently does nothing');
  assert.doesNotMatch(today, /Server-backed|not pretending local state is durable/, 'U3: no engineering words on Today');
  assert.deepEqual([3, 9, 14, 20].map(greet.greeting), ['Hello', 'Good morning', 'Good afternoon', 'Good evening']);
});
