// Promise audit fixes, 27 Nov 2026: each line a person reads is true in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const root = join(appDir, '../../');
const outDir = await mkdtemp(join(tmpdir(), 'apm-promise-fixes-'));
await build({
  entryPoints: {
    exportFile: join(appDir, 'src/integrations/exportFile.ts'),
    coachEngine: join(appDir, 'src/content/coachEngine.ts'),
    policy: join(root, 'packages/policy/src/index.ts'),
  },
  bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
});
const exportFile = await import(pathToFileURL(join(outDir, 'exportFile.js')).href);
const { coachEngineLine } = await import(pathToFileURL(join(outDir, 'coachEngine.js')).href);
const policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
test.after(() => rm(outDir, { recursive: true, force: true }));
const read = (path) => readFile(join(root, path), 'utf8');

const sample = { generatedAt: '2026-11-27T18:00:00.000Z', lifeGraph: { goals: [{ title: 'Run a 10K' }] }, activity: [{ type: 'calendar.move' }] };

test('export on the web downloads the whole export as a dated JSON file', async () => {
  const saved = [];
  const handoff = await exportFile.handOverExport({ web: true, download: (name, text) => saved.push({ name, text }) }, sample, sample.generatedAt);
  assert.equal(handoff, 'downloaded');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'a-player-mode-export-2026-11-27.json');
  assert.deepEqual(JSON.parse(saved[0].text), sample, 'the file holds the export itself, not just its timestamp');
  assert.match(exportFile.exportMessage(handoff, sample.generatedAt), /downloaded as a-player-mode-export-2026-11-27\.json/);
});

test('export on a phone opens the share sheet with the export; closing it never reads as saved', async () => {
  const shared = [];
  const ok = await exportFile.handOverExport({ web: false, share: async (name, text) => { shared.push(JSON.parse(text)); return { action: 'sharedAction' }; } }, sample, sample.generatedAt);
  assert.equal(ok, 'shared');
  assert.deepEqual(shared[0], sample);
  const closed = await exportFile.handOverExport({ web: false, share: async () => ({ action: 'dismissedAction' }) }, sample, sample.generatedAt);
  assert.equal(closed, 'dismissed');
  assert.doesNotMatch(exportFile.exportMessage(closed, sample.generatedAt), /downloaded|went where/);
});

test('export with no way to hand it over, or an empty export, fails instead of claiming a copy', async () => {
  await assert.rejects(exportFile.handOverExport({ web: true }, sample, sample.generatedAt), /export_download_unavailable/);
  await assert.rejects(exportFile.handOverExport({ web: false }, sample, sample.generatedAt), /export_share_unavailable/);
  await assert.rejects(exportFile.handOverExport({ web: true, download: () => {} }, {}, sample.generatedAt), /export_empty/);
});

test('the export screen hands the export over instead of keeping only its timestamp', async () => {
  const screen = await read('apps/mobile/app/settings/privacy/export-delete.tsx');
  assert.match(screen, /handOverExport\(\{/);
  assert.match(screen, /result\.export, result\.export\.generatedAt\)/);
  assert.doesNotMatch(screen, /Your export is ready \(made/);
});

test('coaching: a scripted reply says "no AI model saw your words" only when no model was asked', () => {
  assert.match(coachEngineLine({ engine: 'scripted', modelSaw: false }), /no AI model saw your words/);
  for (const reply of [{ engine: 'scripted', modelSaw: true }, { engine: 'scripted' }]) {
    assert.doesNotMatch(coachEngineLine(reply), /no AI model saw/, 'asked, or unknown (an older server), is never the no-AI promise');
  }
  assert.match(coachEngineLine({ engine: 'model', modelSaw: true }), /AI model/);
});

// The production switches decide what the plan copy may promise (services/api/wrangler.jsonc).
async function productionVars() {
  const text = await read('services/api/wrangler.jsonc');
  const block = text.slice(text.indexOf('"production"'));
  const vars = {};
  for (const [, key, value] of block.matchAll(/"([A-Z_]+)":\s*"([^"]*)"/g)) if (!(key in vars)) vars[key] = value;
  return vars;
}

test('plan copy and store listings promise no inbox action while production leaves email execution off', async () => {
  const vars = await productionVars();
  assert.equal(vars.ACTION_CALENDAR_EXECUTION, 'true', 'read the production switches');
  const store = JSON.parse(await read('apps/mobile/store/app-store.json'));
  const play = JSON.parse(await read('apps/mobile/store/google-play.json'));
  const catalog = await read('apps/mobile/src/billing/catalog.ts');
  const copies = [
    ['Executive Suite plan line', policy.productPlanPolicies.life_os.promise],
    ['Autopilot plan line', policy.productPlanPolicies.autopilot.promise],
    ['App Store description', store.description],
    ['Google Play description', play.fullDescription],
    ['paywall trust lines', catalog.slice(catalog.indexOf('export function trustLines'), catalog.indexOf('export function subscriptionDisclosure'))],
  ];
  if (vars.ACTION_EMAIL_EXECUTION !== 'true') {
    for (const [name, text] of copies) {
      assert.doesNotMatch(text, /every calendar and inbox|calendars and inboxes|cancel a subscription you name|and drafts undo|approve-and-execute/i, `${name} promises an inbox action that production does not run`);
    }
  }
  assert.match(policy.productPlanPolicies.life_os.promise, /acts on your calendar when you tap yes/);
  assert.ok((vars.AUTOPILOT_ENABLED_CLASSES ?? '').split(',').includes('calendar.create'), 'Autopilot books calendar time in production');
  assert.match(policy.productPlanPolicies.autopilot.promise, /moves and books calendar time on its own/);
});

test('the Gmail gap is named wherever mail is offered (Outlook Mail only until Gmail ships)', async () => {
  const radar = await read('apps/mobile/app/(tabs)/radar.tsx');
  assert.match(radar, /Connect your calendar and it watches that too/);
  assert.doesNotMatch(radar, /or email|Outlook Mail/, 'mail promises need an AI route production does not have (email_signal_extraction)');
  const store = JSON.parse(await read('apps/mobile/store/app-store.json'));
  assert.doesNotMatch(store.description, /who you owe a reply/, 'reply-owed flags come from mail extraction, which has no approved route');
  const errors = await read('apps/mobile/src/api/errors.ts');
  assert.doesNotMatch(errors, /You can connect an Outlook calendar/, 'a Google failure never offers Outlook, which needs its own production keys');
});
