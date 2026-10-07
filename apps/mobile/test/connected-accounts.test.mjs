// Connected accounts (0065; owner decision 7 Oct 2026): what the app SAYS about the
// one-calendar / one-inbox limit. The database enforces it; the app must never show a button
// that would fail, must name Autopilot from PLAN_PRICES, and must say plainly what a paused
// account means. Today names the source account only when more than one is connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const appDir = fileURLToPath(new URL('../', import.meta.url));
let outDir; let accounts; let policy;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-accounts-'));
  await build({ entryPoints: { accounts: join(appDir, 'src/integrations/accounts.ts'), policy: join(appDir, '../../packages/policy/src/index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  accounts = await import(pathToFileURL(join(outDir, 'accounts.js')).href);
  policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const conn = (id, kind, extra = {}) => ({ id, userId: 'u', provider: 'google', kind, status: 'connected', scopes: [], ...extra });
const plan = (p, status = 'active') => ({ userId: 'u', plan: p, status });

test('"Add another account" is a button on Autopilot and an upgrade note naming Autopilot everywhere else', () => {
  const one = [conn('w', 'calendar', { isPrimary: true, label: 'Work' })];
  assert.deepEqual(accounts.addAnotherAccount(plan('autopilot'), one, 'calendar'), { allowed: true });
  assert.deepEqual(accounts.addAnotherAccount(plan('autopilot', 'trialing'), one, 'calendar'), { allowed: true });
  for (const p of ['beta', 'chief_of_staff', 'life_os']) {
    const result = accounts.addAnotherAccount(plan(p), one, 'calendar');
    assert.equal(result.allowed, false, p);
    assert.ok(result.upgradeNote.includes(policy.PLAN_PRICES.autopilot.displayName), 'names Autopilot from PLAN_PRICES');
    assert.match(result.upgradeNote, /one calendar/);
  }
  assert.equal(accounts.addAnotherAccount(plan('autopilot', 'expired'), one, 'calendar').allowed, false, 'a lapsed Autopilot is one account');
  // The first account of a kind (and the other kind) is always allowed.
  assert.deepEqual(accounts.addAnotherAccount(plan('life_os'), one, 'email'), { allowed: true });
  assert.deepEqual(accounts.addAnotherAccount(plan('chief_of_staff'), [], 'calendar'), { allowed: true });
});

test('a paused account says what it means and how to get it back, in plain words', () => {
  const paused = conn('p', 'email', { pausedAt: '2026-10-07T00:00:00Z', pausedReason: 'plan', label: 'Personal' });
  const note = accounts.pausedNote(paused, plan('life_os'));
  assert.match(note, /^Paused: your plan includes one inbox/);
  assert.match(note, /Nothing was deleted/);
  assert.ok(note.includes(`Upgrade to ${policy.PLAN_PRICES.autopilot.displayName}`));
  assert.match(accounts.pausedNote(paused, plan('autopilot')), /Reactivate it/);
  assert.equal(accounts.pausedNote(conn('x', 'email'), plan('life_os')), undefined);
});

test('Today names the source account only when more than one is connected', () => {
  const work = conn('w', 'calendar', { isPrimary: true, label: 'Work' });
  const personal = conn('p', 'calendar', { accountLabel: 'me@home.example' });
  assert.equal(accounts.sourceAccountLabel([work], 'calendar', ['w']), undefined);
  assert.equal(accounts.sourceAccountLabel([work, personal], 'calendar', ['p']), 'me@home.example');
  assert.equal(accounts.sourceAccountLabel([work, personal], 'calendar', ['w', 'p']), 'Work + me@home.example');
  assert.equal(accounts.sourceAccountLabel([work, conn('d', 'calendar', { status: 'disconnected' })], 'calendar', ['w']), undefined);
});

test('the connections screen lists accounts with labels, a primary picker and Add another account, never a dead button', async () => {
  const src = await readFile(join(appDir, 'app/settings/privacy/connections.tsx'), 'utf8');
  for (const needle of ['accountsOfKind(', 'addAnotherAccount(', 'add.upgradeNote', "'Add another account'", 'setPrimaryConnection(', 'Make this my primary', 'setConnectionLabel(', 'disconnectConnection(', 'pausedNote(']) {
    assert.ok(src.includes(needle), `connections screen uses ${needle}`);
  }
  // Disconnect is offered for every account, paused or not, on every plan.
  assert.match(src, /label=\{busy === `disconnect:\$\{account\.id\}` \? 'Disconnecting…' : 'Disconnect'\}/);
  assert.ok(!/Autopilot \(\$/.test(src) && !/'Autopilot'/.test(src), 'the plan name comes from PLAN_PRICES, never typed by hand');
});
