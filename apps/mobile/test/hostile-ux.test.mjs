// The hostile UX review (docs/36-HOSTILE-UX-REVIEW.md): every CONFIRMED P0–P2 fix pinned.
// Copy is pinned by reading the copy source (src/content/words.ts and sell.ts, bundled), the
// screens by reading their source, and each new guard (the jargon and raw-error rules in
// design-lint, the Button's disabled reason and double-tap lock) is proved negatively: plant
// the break on a copy, watch the guard fail, restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { lintDesign } from '../scripts/design-lint.mjs';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const src = (rel) => readFile(join(appDir, rel), 'utf8');
let outDir; let words; let sell;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-hostile-'));
  await build({
    entryPoints: { words: join(appDir, 'src/content/words.ts'), sell: join(appDir, 'src/content/sell.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  words = await import(pathToFileURL(join(outDir, 'words.js')).href);
  sell = await import(pathToFileURL(join(outDir, 'sell.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const ENGINE_WORDS = /Life Graph|Personal OS|BHPC|execution|deterministic|durable|\bprint|foreground|opening step|Plan step|Guided Start|Hard Start|_/i;

// ---------------------------------------------------------------- copy (Lens B)
test('T1–T4: Today speaks plain words; the check-in button is not "Print" and says why it is waiting', () => {
  for (const [key, value] of Object.entries(words.TODAY_COPY)) assert.doesNotMatch(value, ENGINE_WORDS, `TODAY_COPY.${key}: "${value}"`);
  assert.equal(words.TODAY_COPY.checkInButton, 'Show my plan for today');
  assert.equal(words.TODAY_COPY.priorityLabel, 'Do this first');
  assert.equal(words.TODAY_COPY.checkInLabel, 'Before you start');
  assert.match(words.TODAY_COPY.checkInReason, /Tap a number/);
  assert.match(words.TODAY_COPY.subtitle, /^Your plan for today is ready\./);
  for (const value of Object.values(words.ITEM_KIND_WORDS)) assert.doesNotMatch(value, ENGINE_WORDS);
  assert.equal(words.ITEM_KIND_WORDS.plan_action, 'Toward your goal');
});

test('T9–T11, R1, G1: engine keys become words (radar, approvals, goals, day-90, diary)', () => {
  assert.equal(words.radarTag('slipping', 'high'), 'Slipping · important');
  assert.equal(words.radarTag('unanswered', 'low'), 'Needs a reply');
  assert.equal(words.radarTag('mystery_type', 'critical'), 'Heads up · very important', 'an unknown key still reads as words');
  assert.equal(words.actionTag('email', 'send_reply'), 'Email · send reply');
  for (const map of [words.GOAL_HEALTH_WORDS, words.GOAL_STATUS_WORDS, words.GATE_WORDS, words.VERDICT_WORDS, words.DIARY_KIND_WORDS, words.MODE_WORDS]) {
    for (const value of Object.values(map)) assert.doesNotMatch(value, /_/, value);
  }
  assert.equal(words.GOAL_HEALTH_WORDS.unknown, 'Just started');
  assert.equal(words.GATE_WORDS.park, 'park it for now');
  assert.equal(words.shortDate('2026-10-07').includes('2026'), false, 'no ISO date reaches a person');
  assert.equal(words.shortDate('not a date'), '');
});

test('G2: a goal date is picked from horizons, never typed as YYYY-MM-DD', async () => {
  assert.deepEqual(words.TARGET_HORIZONS.map((h) => h.id), ['none', '30', '90', '180', '365']);
  assert.equal(words.targetDateFor('none'), undefined);
  assert.equal(words.targetDateFor('30', new Date(2026, 9, 7)), '2026-11-06');
  const goals = await src('app/(tabs)/goals.tsx');
  assert.doesNotMatch(goals, /YYYY-MM-DD|placeholder="2027-01-31"/);
  assert.match(goals, /<ChoiceRow options=\{TARGET_HORIZONS\.map/);
  assert.doesNotMatch(goals, /row\.score\.toFixed/, 'no raw arbitration scores');
});

test('I1/I3: the intake shows time left, never "1 of 54"; the express choice is never a dead Continue', async () => {
  assert.equal(words.minutesLeftLabel(54), 'About 6 min left');
  assert.equal(words.minutesLeftLabel(3), 'About 1 min left');
  assert.equal(words.minutesLeftLabel(0), 'Almost done');
  const intake = await src('app/intake.tsx');
  assert.doesNotMatch(intake, /\$\{p\.index \+ 1\} of \$\{p\.total\}/, 'no "N of 54" counter');
  assert.match(intake, /minutesLeftLabel\(p\.total - p\.answered\)/);
  assert.doesNotMatch(intake, /screen\.kind === 'express'\) \{ canNext = Boolean\(answers\.mode\)/, 'express Continue is not disabled with no reason');
  assert.match(intake, /screen\.kind === 'express' && !answers\.mode\) \{\s*nextLabel = 'Build my plan now';/);
  assert.doesNotMatch(intake, /under a minute/, 'the two estimates use the same rate');
});

test('S1: the OS summary never shows a dash for the first step; APM fills it in', async () => {
  const reveal = await src('src/components/intake/Reveal.tsx');
  assert.doesNotMatch(reveal, /first_step \?\? '—'/);
  assert.match(reveal, /goalTemplates\(answers\)\[0\]\)\?\.steps\[0\]/);
});

test('H1: the welcome page sells in an organized way — how it works, the five jobs visible, one persona at a time', async () => {
  assert.match(sell.FIVE_ROLES.title, /hire/i, 'framed as the people you would hire');
  assert.ok(sell.FIVE_ROLES.lead.length > 20);
  assert.equal(sell.WELCOME_TIERS_TEASER.rows.length, 3);
  const welcome = await src('app/welcome.tsx');
  assert.match(welcome, /<Flow steps=\{\[\.\.\.HOW_IT_WORKS\.steps\]\} \/>/, 'how it works, as three numbered steps');
  for (const visible of ['FIVE_ROLES.roles.map((role, i) => (', 'INSIDE.parts.map((part) => <ListItem', 'MODES.modes.map((mode) => <ListItem']) assert.ok(welcome.includes(visible), `${visible} is visible, not folded`);
  assert.doesNotMatch(welcome, /FIVE_ROLES\.roles\.map\(\(role\) => <Expandable/, 'the five jobs are not hidden behind taps');
  assert.match(welcome, /<ChoiceRow options=\{PERSONAS\.personas\.map/, 'pick your game, see your line');
  assert.equal((welcome.match(/<Eyebrow>\{eyebrow\}<\/Eyebrow>/g) ?? []).length, 1, 'every section carries an eyebrow through Section');
  const sections = (welcome.match(/<Section eyebrow=/g) ?? []).length;
  assert.ok(sections >= 11, `${sections} sections`);
});

test('H2/H4: the paywall puts the buy buttons first, folds the 13 grid rows, and says "Introductory offer" once', async () => {
  const paywall = await src('src/billing/PlanChoice.tsx');
  const firstBuy = paywall.indexOf('purchase(planKey)');
  const firstGrid = paywall.indexOf('<TierGrid title=');
  assert.ok(firstBuy > 0 && firstGrid > 0 && firstBuy < firstGrid, 'the plans and their buy buttons come before the comparison grids');
  assert.match(paywall, /<Disclosure icon="columns" title=\{PLAN_SCREEN\.compareTitle\}[\s\S]*<TierGrid[\s\S]*<TierGrid[\s\S]*<\/Disclosure>/, 'both grids fold into one disclosure');
  assert.doesNotMatch(paywall, /Autonomy ceiling/, 'no engineering field on a plan card');
  assert.match(paywall, /\{!isCurrent && availability\.available \? \(/, 'no wall of dead buy buttons where this build cannot buy');
  assert.match(paywall, /isCurrent \? <Pill tone="solid">Current<\/Pill> : planKey === recommended \? <Pill tone="solid">/, 'the plan card pills are solid: a soft pill on the accent card was invisible (successSoft = accentSoft)');
  assert.doesNotMatch(await src('app/(tabs)/goals.tsx'), /<Pill tone="success">Main goal/, 'the main-goal pill is visible on its accent card');
  assert.match(paywall, /disabledReason=\{busy \? undefined : buyBlockedReason\(pkg\)\}/, 'a disabled buy button says why');
  // One highlighted buy button per build: the store button (store builds) and the card button (web,
  // sideload) sit behind mutually exclusive guards, so a screen shows exactly one of them.
  assert.equal((paywall.match(/variant=\{planKey === recommended \? 'accent' : 'secondary'\}/g) ?? []).length, 2, 'one highlighted store button + one highlighted card button');
  assert.match(paywall, /\{!isCurrent && availability\.available \? \(\s*<Button label=\{busy === planKey \? 'Opening the store…'[^\n]*variant=\{planKey === recommended \? 'accent' : 'secondary'\}/, 'the store one is behind availability.available');
  assert.match(paywall, /cardCheckout\.kind === 'ready'[\s\S]{0,400}WEB_CHECKOUT_COPY\.button[^\n]*variant=\{planKey === recommended \? 'accent' : 'secondary'\}/, 'the card one is behind card checkout ready');
  const plan = await src('app/settings/plan.tsx');
  assert.doesNotMatch(plan, /value=\{entitlement\.status\}|maxAutonomyLevel/, 'Settings → plan shows words, not enums or levels');
});

// ---------------------------------------------------------------- behaviour (Lens A)
test('H5: Button never sits dead: a disabled one shows its reason; a promise locks it against a double tap', async () => {
  const ui = await src('src/components/ui.tsx');
  assert.match(ui, /disabledReason\?: string;/);
  assert.match(ui, /const showReason = disabled && Boolean\(disabledReason\);/);
  assert.match(ui, /accessibilityHint=\{showReason \? disabledReason : accessibilityHint\}/, 'the reason is read out too');
  assert.match(ui, /if \(inFlight\.current \|\| working \|\| disabled\) return;/, 'a second tap while working is dropped');
  assert.match(ui, /inFlight\.current = true;\s*setPending\(true\);/, 'the lock is set synchronously (a ref), before the next tap can land');
  assert.match(ui, /accessibilityState=\{\{ disabled, busy: working \}\}/);
  assert.match(ui, /working \? <ActivityIndicator/);
  assert.match(ui, /disabled && \(showReason \? s\.waiting : s\.disabled\)/, 'a disabled button with a reason looks like it is waiting, not dead');
  assert.match(ui, /waiting: \{ backgroundColor: colors\.surfaceMuted, borderColor: colors\.lineStrong/);
  const today = await src('app/(tabs)/today.tsx');
  assert.match(today, /disabled=\{mood === undefined\} disabledReason=\{TODAY_COPY\.checkInReason\}/, 'T3: the check-in button says what unlocks it');
  assert.match(today, /label=\{busyItemId === item\.id \? 'Recording…' : 'Mark done'\}/, 'E22: only the saving card says Recording…');
  const coach = await src('app/(tabs)/apm.tsx');
  assert.match(coach, /disabled=\{!message\.trim\(\) && !coachingBusy\}/, 'Send is not a silent no-op on an empty box');
  const diary = await src('app/diary.tsx');
  assert.match(diary, /disabled=\{!body\.trim\(\) && !busy\} disabledReason="Write a line first\."/);
});

test('H3: a double tap on a coaching-mode chip can never enter a mode and then exit it again', async () => {
  const cards = await src('src/components/today/FirstRunCards.tsx');
  assert.match(cards, /if \(inFlight\.current\) return;\s*inFlight\.current = true;/);
  assert.match(cards, /finally \{ inFlight\.current = false; setBusyMode\(undefined\); \}/);
  assert.match(cards, /role="radio"/, 'one mode at a time is a radio, not a checkbox');
  assert.match(cards, /setError\(plainError\(cause, /);
  assert.match(cards, /Tap it again to go back to your usual day\./, 'the toggle-off is said out loud');
});

test('T16: the last 7 days use the one icon set with words, never emoji or a "· ·" legend', async () => {
  const today = await src('app/(tabs)/today.tsx');
  assert.doesNotMatch(today, /[✅⚡❌]/u, 'no emoji on Today');
  assert.doesNotMatch(today, /day\.symbol/);
  assert.match(today, /<ContinuityStrip days=\{todayLoop\.continuity\} \/>/);
  assert.doesNotMatch(today, /\{firstRadarItem\.type\} · \{firstRadarItem\.severity\}|\{action\.domain\} · \{action\.actionType\}/);
});

test('ST1–ST3, N1: Settings shows her plan, a signed-out deep link has a way in, pushed screens are not titled twice', async () => {
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /planTitle\(entitlement\?\.plan, usable\)/);
  assert.match(settings, /label="Sign in" onPress=\{\(\) => router\.push\('\/account'\)\}/);
  assert.ok(settings.indexOf("'Sign out'") > settings.indexOf('title="Autopilot"'), 'Sign out sits at the bottom, not as the first button');
  const layout = await src('app/_layout.tsx');
  const titled = [...layout.matchAll(/name="([^"]+)" options=\{\{ title: '/g)].map((m) => m[1]);
  assert.ok(titled.length >= 15, `${titled.length} titled routes`);
  for (const name of titled) {
    const file = await src(`app/${name}.tsx`);
    assert.doesNotMatch(file, /<Screen\b[^>]*\beyebrow=/, `app/${name}.tsx repeats its native header as an eyebrow`);
  }
  assert.match(await src('app/(tabs)/_layout.tsx'), /name="apm" options=\{\{ title: 'Coach'/, 'the coach tab is called Coach, not APM');
  assert.match(await src('app/account.tsx'), /router\.canGoBack\(\) \? router\.back\(\) : router\.replace\('\/welcome'\)/, 'Back works from a deep link');
});

// ---------------------------------------------------------------- the guards, proved negatively
test('design-lint FAILS on engineering words and raw error messages in the copy (negative proof)', async () => {
  assert.deepEqual((await lintDesign(appDir)).violations, [], 'the app itself passes');
  const copy = await mkdtemp(join(tmpdir(), 'apm-jargon-'));
  try {
    await cp(join(appDir, 'app'), join(copy, 'app'), { recursive: true });
    await cp(join(appDir, 'src'), join(copy, 'src'), { recursive: true });
    const breaks = [
      ['app/j1.tsx', 'export const X = () => <Body>APM rebuilt Today from your Personal OS.</Body>;', /engineering word/],
      ['app/j2.tsx', "export const X = 'Your Life Graph';", /engineering word/],
      ['src/components/j3.tsx', "export const label = 'Print my agenda';", /engineering word/],
      ['src/content/j4.ts', "export const t = 'Make this the foreground';", /engineering word/],
      ['src/billing/j5.tsx', "export const t = 'Running the BHPC flow';", /engineering word/],
      ['app/e1.tsx', "export const f = (cause) => setError(cause instanceof Error ? cause.message : 'x');", /raw error message/],
    ];
    for (const [file, body, expected] of breaks) {
      await writeFile(join(copy, file), body);
      const { violations } = await lintDesign(copy);
      assert.ok(violations.some((v) => v.startsWith(file) && expected.test(v)), `${file} must fail (got: ${violations.join(' | ') || 'nothing'})`);
      await rm(join(copy, file));
    }
    // Not copy: identifiers, properties, comments and the API layer stay allowed.
    await writeFile(join(copy, 'app/ok.tsx'), "// the Life Graph is the source\nexport const g = graph.personalOS?.foregroundGoalId ?? plan.foreground.label;");
    await writeFile(join(copy, 'src/api/ok.ts'), "export const route = 'deterministic';");
    assert.deepEqual((await lintDesign(copy)).violations, [], 'identifiers, comments and the API layer are not copy');
  } finally { await rm(copy, { recursive: true, force: true }); }
});
