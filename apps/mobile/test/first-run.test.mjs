// The first-run experience (docs/34): the selling copy and the paywall offer, pinned against
// the ONE sources of truth (@apm/policy prices, @apm/domain Track names), and the build rules
// that only the code can show (one setup route, swipe-back off, Android back handled,
// synchronous device writes, Apple on iOS only, dead onboarding screens gone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
let outDir; let sell; let policy; let domain;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-first-run-'));
  await build({
    entryPoints: {
      sell: join(appDir, 'src/content/sell.ts'),
      policy: fileURLToPath(new URL('../../../packages/policy/src/index.ts', import.meta.url)),
      domain: fileURLToPath(new URL('../../../packages/domain/src/index.ts', import.meta.url)),
    },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  sell = await import(pathToFileURL(join(outDir, 'sell.js')).href);
  policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
  domain = await import(pathToFileURL(join(outDir, 'domain.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const usd = (cents) => policy.formatUsdCents(cents);

test('the welcome page carries all 12 sections in order (how it works second), with the CTA', () => {
  assert.deepEqual(sell.WELCOME_SECTIONS.map((s) => s.id), ['hero', 'how', 'continuity', 'roles', 'personas', 'inside', 'modes', 'tracks', 'situations', 'without_with', 'tiers', 'privacy']);
  assert.equal(sell.HOW_IT_WORKS.steps.length, 3, 'docs/34 §3.3: three steps');
  assert.match(sell.HOW_IT_WORKS.steps[0], /3 minutes/);
  assert.match(sell.HOW_IT_WORKS.steps[2], /arrives on its own/);
  assert.equal(sell.HERO.headline, 'Reduce your cognitive load.');
  assert.equal(sell.CTA_LABEL, 'Start: reduce my load');
  assert.equal(sell.CONTINUITY.title, 'You don\'t have a knowledge problem. You have a continuity problem.');
  assert.deepEqual(sell.CONTINUITY.loop, ['Clarity', 'Motivation', 'Strong Start', 'Missed Day', 'Avoidance', 'Reset', 'New Plan', 'Repeat']);
  assert.equal(sell.CONTINUITY.close, 'You are not lazy. You are overloaded.');
  for (const point of ['Clearer priorities.', 'Cleaner execution.', 'Faster recovery after imperfect days.', 'Less renegotiating with yourself.']) assert.ok(sell.HERO.definition.includes(point));
  assert.match(sell.HERO.notThis, /not hustle cosplay/);
  const text = sell.welcomeText();
  assert.ok(!/gumroad|paste|prompt pack|ChatGPT/i.test(text), 'an app, not prompts you paste; no Gumroad');
  assert.match(sell.PRIVACY_LINE, /zero-retention, no-training/);
});

test('five roles, five personas (plus the broader list), six modes, eight situations, advice vs system', () => {
  assert.deepEqual(sell.FIVE_ROLES.roles.map((r) => r.title), ['Executive Coach', 'Executive Assistant', 'Chief of Staff', 'Accountability Partner', 'Cognitive Behavioral Mindset Coach']);
  assert.match(sell.FIVE_ROLES.framing, /Billionaires do not rely on motivation\. They buy structure/);
  assert.deepEqual(sell.PERSONAS.personas.map((p) => p.title), ['Wealth building', 'Weight loss', 'Founder / Entrepreneur', 'Operator', 'Parent+']);
  for (const extra of ['Creatives and makers', 'Students and researchers', 'Athletes and competitors', 'Career-switchers', 'Executives in a new seat', 'Anyone at 2 a.m. trying to get their life together']) assert.ok(sell.PERSONAS.alsoFor.includes(extra), extra);
  assert.deepEqual(sell.INSIDE.parts.map((p) => p.title), ['Daily agenda engine', 'Morning trigger', 'Never Miss Twice', 'Minimum Viable Day', 'Arbitration engine', 'End-of-day check-in']);
  assert.deepEqual(sell.MODES.modes.map((m) => m.title), ['High-Pressure Coaching', 'Executive Review', 'Recovery', 'Sprint', 'Deep Work', 'Standard']);
  assert.deepEqual(sell.SITUATIONS.rows.map((r) => r[1]), ['Morning Start Sequence', 'Recovery Day', 'No-Catch-Up reset', 'Stabilization', 'Arbitration', 'Minimum Viable Day', 'Re-entry', 'No-Redesign stabilization']);
  assert.ok(sell.WITHOUT_WITH.without.lines.length >= 3 && sell.WITHOUT_WITH.with.lines.length >= 3);
});

test('all 7 Tracks by their ONE display name, with the Billionaire High Performance Coach spotlight', () => {
  assert.deepEqual(sell.TRACKS.tracks.map((t) => t.title), Object.values(domain.TRACK_DISPLAY_NAMES));
  assert.equal(sell.TRACKS.tracks.length, 7);
  assert.equal(sell.TRACKS.spotlight.title, domain.TRACK_DISPLAY_NAMES.billionaire_mindset);
  assert.match(sell.TRACKS.spotlight.body, /High-Pressure Coaching/);
  for (const t of sell.TRACKS.tracks) assert.ok(t.body.length > 20, t.title);
});

test('the welcome page only teases the tiers; the grids and every price live on the plan screen', () => {
  assert.equal(sell.WELCOME_TIERS_TEASER.line, 'Executive Roundtable plans and coaches you · Executive Suite acts when you tap yes · Autopilot handles it inside your rules');
  assert.equal(sell.WELCOME_TIERS_TEASER.line, ['chief_of_staff', 'life_os', 'autopilot'].map((p) => `${policy.PLAN_PRICES[p].displayName} ${policy.PLAN_PRICES[p].tagline}`).join(' · '), 'derived from PLAN_PRICES');
  assert.deepEqual(sell.TIER_GRID_WHO.columns, ['Executive Roundtable', 'Executive Suite', 'Autopilot']);
  assert.equal(sell.WELCOME_TIERS_TEASER.offer, `Introductory offer: start at ${usd(policy.CHIEF_OF_STAFF_INTRO_OFFERS.introductory.monthlyUsdCents)}/month`);
  const welcome = sell.welcomeText();
  for (const plan of ['chief_of_staff', 'life_os', 'autopilot']) {
    assert.ok(!welcome.includes(usd(policy.PLAN_PRICES[plan].monthlyUsdCents)), `no ${plan} list price on the welcome page`);
  }
  assert.ok(!welcome.includes(sell.TIER_GRID_WHO.title) && !welcome.includes(sell.TIER_GRID_WHAT.title), 'no grids on the welcome page');
  assert.ok(!/Founding 100/.test(welcome), 'never the bare "Founding 100"');
  const plan = sell.planScreenText(sell.offerBanner({ founding: false }));
  for (const p of ['chief_of_staff', 'life_os', 'autopilot']) {
    assert.ok(plan.includes(usd(policy.PLAN_PRICES[p].monthlyUsdCents)), `${p} monthly`);
    assert.ok(plan.includes(usd(policy.PLAN_PRICES[p].annualUsdCents)), `${p} annual`);
  }
  assert.equal(sell.TIER_GRID_WHO.rows.length, 5);
  assert.equal(sell.TIER_GRID_WHAT.rows.length, 8);
  assert.match(sell.PLAN_SCREEN.annualLine, /2 months free/);
  assert.match(sell.PLAN_SCREEN.autonomyLine, /never grants autonomy/);
  assert.equal(sell.recommendedTier(['parent', 'founder']), 'life_os');
  assert.equal(sell.recommendedTier(['founder']), 'chief_of_staff');
});

test('the introductory offer reads as a promotion in both states; scarcity is the server number or nothing', () => {
  const intro = usd(policy.CHIEF_OF_STAFF_INTRO_OFFERS.founding100.monthlyUsdCents);
  const list = usd(policy.PLAN_PRICES.chief_of_staff.monthlyUsdCents);
  const founding = sell.offerBanner({ founding: true, spotsLeft: 37 });
  assert.equal(founding.kind, 'founding');
  assert.equal(founding.ribbon, 'Introductory offer');
  assert.equal(founding.headline, 'Founding Member price');
  assert.equal(founding.now, `${intro}/month`);
  assert.equal(founding.was, `${list}/month`);
  assert.equal(founding.saving, 'Save 60%');
  assert.equal(founding.explain, `For our first 100 members only. Your price stays ${intro} for as long as you stay subscribed.`);
  assert.equal(founding.scarcity, '37 of 100 spots left');
  const unknown = sell.offerBanner({ founding: true, spotsLeft: null });
  assert.equal(unknown.kind, 'founding');
  assert.equal(unknown.scarcity, undefined, 'count unavailable → hidden, never invented');
  for (const fallback of [sell.offerBanner({ founding: false, spotsLeft: 12 }), sell.offerBanner({ founding: true, spotsLeft: 0 })]) {
    assert.equal(fallback.kind, 'introductory');
    assert.equal(fallback.ribbon, 'Introductory offer');
    assert.equal(fallback.headline, `${intro}/month for your first 3 months, then ${list}`);
    assert.equal(fallback.was, `${list}/month`);
    assert.equal(fallback.saving, 'Save 60%');
    assert.equal(fallback.scarcity, undefined);
  }
  // docs/36 H4: the ribbon and the headline sit one above the other; the words are never said twice.
  for (const banner of [founding, unknown, sell.offerBanner({ founding: false })]) {
    assert.ok(!banner.headline.toLowerCase().includes(banner.ribbon.toLowerCase()), `"${banner.ribbon}" is not repeated in "${banner.headline}"`);
  }
});

const read = (rel) => readFile(join(appDir, rel), 'utf8');

test('one setup route: no header, no swipe-back, Android back handled; dead onboarding screens are gone', async () => {
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /name="intake" options=\{\{ headerShown: false, gestureEnabled: false/);
  const intake = await read('app/intake.tsx');
  assert.match(intake, /BackHandler\.addEventListener\('hardwareBackPress'/);
  assert.match(intake, /Leave setup\?/);
  assert.match(intake, /<PlanChoice\b/, 'the paywall sits on the setup path, after the summary');
  for (const gone of ['app/onboarding.tsx', 'app/sign-in.tsx', 'app/privacy-primer.tsx']) {
    await assert.rejects(access(join(appDir, gone)), `${gone} is deleted`);
  }
  const all = [layout, intake, await read('app/index.tsx'), await read('app/(tabs)/_layout.tsx'), await read('app/(tabs)/today.tsx')].join('\n');
  assert.doesNotMatch(all, /\/onboarding'|\/sign-in'|\/privacy-primer'/, 'no route points at a deleted screen');
});

test('answers hit the device synchronously on native; web storage never crashes; Apple only on iOS; no vendor names in user copy', async () => {
  const native = await read('src/intake/storage.native.ts');
  assert.match(native, /expo-sqlite\/kv-store/);
  assert.match(native, /setItemSync/);
  const web = await read('src/intake/storage.ts');
  assert.doesNotMatch(web, /from 'expo-sqlite/, 'the web build never loads the native store');
  assert.match(web, /try \{/);
  const account = await read('src/components/intake/AccountPanel.tsx');
  assert.match(account, /Platform\.OS === 'ios' \? <AppleButton/);
  assert.match(account, /Not now, keep going/);
  assert.match(account, /textContentType="oneTimeCode"/);
  const session = await read('src/state/session.tsx');
  assert.match(session, /signInAnonymously/);
  assert.match(session, /email_change/);
  assert.match(session, /mergeAnonymousIntakeDraft/);
  for (const rel of ['app/welcome.tsx', 'app/intake.tsx', 'src/components/intake/AccountPanel.tsx', 'src/content/sell.ts']) {
    const text = await read(rel);
    const strings = [...text.matchAll(/'([^'\n]{12,})'|"([^"\n]{12,})"|>([^<>{}\n]{12,})</g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const s of strings) assert.doesNotMatch(s, /Supabase|Cloudflare|RevenueCat|OpenRouter/, `${rel}: "${s}" names a vendor`);
  }
});
