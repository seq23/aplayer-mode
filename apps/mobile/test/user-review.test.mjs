// The first-time user review of 14 Nov 2026 (20 findings, all approved): the behaviours that
// live in the app rather than the planning engine. Engine-side guards are in
// packages/planning/test/intake.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
let outDir; let m = {};
const src = (path) => readFile(join(appDir, path), 'utf8');

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-user-review-'));
  const entries = { sell: 'src/content/sell.ts', words: 'src/content/words.ts', scale: 'src/components/intake/scale.ts', summary: 'src/billing/planSummary.ts', dates: 'src/components/dateField.ts' };
  await build({
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(appDir, v)])),
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  for (const key of Object.keys(entries)) m[key] = await import(pathToFileURL(join(outDir, `${key}.js`)).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('#1/#14: the setup length promised is the real one, everywhere it is said', async () => {
  const minutes = m.sell.QUICK_SETUP_MINUTES;
  assert.ok(minutes >= 3 && minutes <= 6, `quick setup ${minutes} min`);
  assert.ok(m.sell.HERO.emptyLine.includes(`${minutes} minutes`));
  assert.ok(m.sell.HOW_IT_WORKS.steps[0].includes(`${minutes} minutes`));
  const store = JSON.parse(await src('store/app-store.json'));
  assert.ok(store.description.includes(`about ${minutes} minutes`), 'the store listing says the same length');
  assert.doesNotMatch(store.description, /3 minutes/);
  const welcome = await src('app/welcome.tsx');
  assert.match(welcome, /CTA_LABEL[^\n]*\n\s*<Muted align="center">\{START_PRICE_SHORT\}<\/Muted>/, 'the price sits right under Start');
});

test('#5/#20: steppers start unset; times wrap around midnight; a typed weight saves only in range', () => {
  assert.equal(m.scale.scaleStep({ type: 'slider', min: 1, max: 10, def: 7, delta: 1 }), 8, 'first tap moves from the suggestion');
  assert.equal(m.scale.scaleStep({ type: 'slider', min: 1, max: 10, value: 10, def: 7, delta: 5 }), 10, 'a number stays in range');
  assert.equal(m.scale.scaleStep({ type: 'time', min: 0, max: 1425, value: 1410, def: 390, delta: 60 }), 30, '11:30 PM + 1 h = 12:30 AM');
  assert.equal(m.scale.scaleStep({ type: 'time', min: 0, max: 1425, value: 0, def: 390, delta: -15 }), 1425);
  assert.equal(m.scale.typedNumber('', 70, 700), undefined, 'blank saves nothing');
  assert.equal(m.scale.typedNumber('18', 70, 700), undefined, 'out of range saves nothing');
  assert.equal(m.scale.typedNumber('182', 70, 700), 182);
});

test('#2/#5: QuestionView never writes a default on its own', async () => {
  const view = await src('src/components/intake/QuestionView.tsx');
  assert.doesNotMatch(view, /useEffect\(\(\) => \{\s*if \(isScale/, 'no answer written when the screen appears');
  assert.doesNotMatch(view, /onAnswer\(unit === 'kg' \? 80 : 180\)/, 'switching the unit never invents a weight');
});

test('#8: a person who never bought a plan reads "No plan yet", never "<plan> · ended"', async () => {
  assert.equal(m.summary.planSummary({ hasPlan: false, displayName: 'No plan yet', status: 'expired' }), 'No plan yet');
  assert.equal(m.summary.planSummary({ hasPlan: true, displayName: 'Executive Roundtable', status: 'expired' }), 'Executive Roundtable · ended');
  const api = await readFile(join(appDir, '../../services/api/src/index.ts'), 'utf8');
  assert.match(api, /hasPlan: Boolean\(entitlement\),\s*displayName: entitlement \? policy\.displayName : 'No plan yet'/, 'the live server says it at source');
});

test('#9: an unsaved plan cannot be lost to one tap on Sign out', async () => {
  const settings = await src('app/settings/index.tsx');
  assert.match(settings, /isAnonymous \? \(/);
  assert.match(settings, /Not saved yet/);
  assert.match(settings, /setConfirmSignOut\(true\)/, 'Sign out asks first');
});

test('#10: a refused notification prompt offers the phone Settings', async () => {
  const push = await src('src/integrations/push.ts');
  assert.match(push, /Linking\.openSettings\(\)/);
  assert.match(push, /throw new PushBlockedError\(\)/);
  for (const file of ['app/settings/notifications.tsx', 'app/intake.tsx']) assert.match(await src(file), /openPhoneSettings/, file);
});

test('#17: a sync time reads "Synced 2:49 PM", never an ISO timestamp', () => {
  const now = new Date(2026, 10, 14, 16, 0);
  const today = new Date(2026, 10, 14, 14, 49).toISOString();
  assert.match(m.words.syncedWords(today, now), /^Synced \d{1,2}:49/);
  assert.doesNotMatch(m.words.syncedWords(today, now), /T\d\d:|Z$/);
  assert.equal(m.words.syncedWords(undefined, now), 'Not synced yet');
});

test('#11: a deadline date round-trips the local calendar day', () => {
  const iso = m.dates.localDateToIso(new Date(2026, 11, 12, 9));
  assert.equal(iso, '2026-12-12');
  assert.equal(m.dates.localDateToIso(m.dates.isoToLocalDate(iso)), iso);
  assert.equal(m.dates.longDate('nope'), '');
});

test('#18: no system jargon on the screens she reads first', async () => {
  for (const file of ['app/intake.tsx', 'app/settings/index.tsx', 'app/_layout.tsx', 'app/(tabs)/apm.tsx', 'app/review.tsx']) {
    const text = await src(file);
    assert.doesNotMatch(text, /'Install my OS'|title="Drafting Room"|title: 'Drafting Room'/, file);
  }
});

// ---------------------------------------------------------------- the simulator first-time test (14 Nov 2026)

test('sim #1: one setup count everywhere on the intake; a jump says why in one line', async () => {
  const intake = await src('app/intake.tsx');
  assert.match(intake, /const count = setupCount\(answers, mode\);/);
  assert.match(intake, /<ProgressBar done=\{count\.done\} total=\{count\.total\}/, 'the bar reads the one count');
  assert.doesNotMatch(intake, /questionsLeft\(|deferredQuestionIds\(/, 'no second count on the intake screen');
  assert.match(intake, /BRANCH_QUESTIONS\[lastAnswer\.current\]/, 'a change names the answer that caused it');
  assert.equal(m.words.countChangeLine(22, 22, undefined), undefined, 'no change, no line');
  assert.equal(m.words.countChangeLine(18, 22, 'each game brings its own questions'), 'Your last answer added 4 questions (each game brings its own questions). Now 22 in all.');
  assert.equal(m.words.countChangeLine(23, 22, 'this goal needs a number'), 'Your last answer removed 1 question (this goal needs a number). Now 22 in all.');
});

test('sim #2: nothing is pre-picked: no demo game on the welcome page, no plan name ticked', async () => {
  const welcome = await src('app/welcome.tsx');
  assert.match(welcome, /useState<string \| undefined>\(undefined\)/, 'the game picker starts empty');
  assert.doesNotMatch(welcome, /useState<string>\(PERSONAS\.personas\[0\]/);
  assert.match(welcome, /\{shown \? \(/, 'the example card shows only after a tap');
  assert.match(welcome, /\{WELCOME_LEGAL\}/, 'the disclaimer is on the page');
  const reveal = await src('src/components/intake/Reveal.tsx');
  assert.match(reveal, /selected=\{answers\.sysname === name\}/, 'a name chip is ticked only when she tapped it');
  assert.doesNotMatch(reveal, /selected=\{s\.systemName === name\}/, 'the default name is never shown as picked');
  assert.match(reveal, /placeholder=\{`e\.g\. \$\{DEFAULT_SYSTEM_NAME\}`\}/, 'an empty box with a placeholder');
});

test('sim #3/#4: plain words about saving to an account; the save step has one forward button, never a dead Continue', async () => {
  const intake = await src('app/intake.tsx');
  const panel = await src('src/components/intake/AccountPanel.tsx');
  for (const [file, text] of [['intake', intake], ['panel', panel]]) {
    assert.doesNotMatch(text, /ask again at install|to install it|Save your OS/, `${file}: no "install" talk in an installed app`);
  }
  assert.match(intake, /if \(screen\.kind === 'account' && !answers\._acct\) \{\s*nextLabel = 'Not now, keep going';\s*nextVariant = 'secondary';/);
  assert.doesNotMatch(intake, /screen\.kind === 'account'\) \{ canNext = Boolean\(answers\._acct\)/, 'no disabled Continue on the save step');
  assert.doesNotMatch(intake, /onLater=\{\(\) => \{ answer\('_acct', 'later'\)/, 'the panel carries no second "Not now"');
});

test('sim #5: Finish later sits low and quiet; its note counts her answers right', async () => {
  const intake = await src('app/intake.tsx');
  const top = intake.slice(intake.indexOf('const top ='), intake.indexOf('let body'));
  assert.doesNotMatch(top, /Finish later/, 'not in the top corner where a quick tap lands');
  assert.match(intake, /<LinkButton label="Finish later" muted align="center" onPress=\{finishLater\} \/>/);
  assert.match(intake, /savedAnswersLine\(count\.done, /, 'the note reads the one count');
  assert.equal(m.words.savedAnswersLine(1, false), 'Your 1 answer is saved on this phone. Open APM any time and you\'ll be right back on this question.');
  assert.match(m.words.savedAnswersLine(2, true), /^Your 2 answers are saved on this phone and in your account\./);
  assert.match(m.words.savedAnswersLine(0, false), /^Nothing is lost\./);
  for (const n of [0, 1, 2, 9]) assert.doesNotMatch(m.words.savedAnswersLine(n, false), /\bAll\b|1 answers/);
});

test('sim #8: a disabled Start my plan says why and what to tap', async () => {
  const intake = await src('app/intake.tsx');
  assert.match(intake, /if \(noSession\) reason = `Start my plan unlocks once your plan is saved to an account\. Scroll up to "Save your plan to an account" and tap/);
  assert.match(intake, /title="Save your plan to an account"/, 'the box the reason points at has that title');
});
