// The trust line (src/billing/catalog.ts trustLines) on the paywall and in Settings makes four
// promises. Each is pinned here to the code that keeps it, so the line cannot drift from it
// (App Review check 13: every promise is built):
//   * the yearly renewal email is promised exactly for the channels the server reminder covers
//     (migration 0098's due query, sent by services/api/src/renewalReminders.ts);
//   * "undo" holds: every reversible standing action is a calendar change or a draft and has an
//     undo; every irreversible one is labelled "Can't undo" before it runs;
//   * "never spends": the only subscription action APM may take on its own is cancelling;
//   * both screens show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const repoDir = join(appDir, '../..');
let outDir; let catalog; let policy;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-trust-'));
  await build({
    entryPoints: { catalog: join(appDir, 'src/billing/catalog.ts'), policy: join(repoDir, 'packages/policy/src/index.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  catalog = await import(pathToFileURL(join(outDir, 'catalog.js')).href);
  policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const promisesRenewalEmail = (channel) => catalog.trustLines(channel).some((line) => /email you .*renews/i.test(line.body));

test('the renewal email is promised for exactly the channels the server reminder sends to', async () => {
  const sql = await readFile(join(repoDir, 'services/api/migrations/0098_billing_renewal_reminders.sql'), 'utf8');
  const match = sql.match(/where e\.provider in \(([^)]*)\)/);
  assert.ok(match, 'the due query names the providers it reminds');
  const covered = new Set(match[1].split(',').map((s) => s.trim().replace(/'/g, '')));
  const channels = { app_store: 'app_store', google_play: 'google_play', web: 'web' };
  assert.ok(covered.size > 0);
  for (const channel of Object.keys(channels)) {
    assert.equal(promisesRenewalEmail(channel), covered.has(channel), `${channel}: renewal email promised only where it is sent`);
  }
});

test('each channel says who bills it, and that cancelling needs no call', () => {
  const billed = (channel) => catalog.trustLines(channel).find((line) => /^Billed/.test(line.title));
  assert.match(billed('app_store').title, /Apple/);
  assert.match(billed('google_play').title, /Google Play/);
  assert.match(billed('web').title, /card/);
  for (const channel of ['app_store', 'google_play', 'web']) assert.match(billed(channel).body, /no call needed/);
});

test('undo is true: reversible actions are calendar changes or drafts with an undo; the rest say "Can\'t undo"', () => {
  const classes = Object.values(policy.standingActionClasses);
  assert.ok(classes.length >= 5, 'the allow-list is read');
  for (const action of classes) {
    if (action.reversible) {
      assert.notEqual(action.undo, 'none', action.actionClass);
      assert.ok(action.actionClass.startsWith('calendar.') || action.actionClass === 'email.draft', `${action.actionClass} undoes but is not a calendar change or draft`);
    } else {
      assert.equal(action.undo, 'none', action.actionClass);
      assert.match(action.undoLabel, /^Can't undo/, action.actionClass);
    }
  }
});

test('never spends: the only money action APM can take on its own is a cancellation', () => {
  const money = Object.values(policy.standingActionClasses).filter((action) => action.domain === 'subscription').map((action) => action.actionClass);
  assert.deepEqual(money, ['subscription.cancel']);
});

test('the paywall and Settings both show the trust line', async () => {
  for (const file of ['src/billing/PlanChoice.tsx', 'app/settings/index.tsx']) {
    assert.match(await readFile(join(appDir, file), 'utf8'), /<TrustLine\b/, file);
  }
});
