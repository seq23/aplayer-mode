// The deploy applies pending migrations before the Worker (scripts/db-migrations.mjs). Proves the
// outage case (0107, 21 Nov 2026: a Worker shipped ahead of its migration), the data-loss case
// (never re-runs old files, never treats an unreadable ledger as "nothing applied") and the
// stop-on-failure case, against a fake Management API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { migrationFiles, pendingMigrations, syncMigrations, Refusal } from '../../../scripts/db-migrations.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'services/api/migrations');
const files = migrationFiles(dir);
const REF = 'klzbnchgoqmnwsgolwoe';
const last = files.at(-1);

// Ledger as production has it: recent files by stem, everything else as the server would list it.
const ledgerThrough = (stem) => files.slice(0, files.indexOf(stem) + 1)
  .filter((f) => !/^000[1-3]_|^009[3-8]_/.test(f));

function fakeApi({ ledger, failOn = null, ledgerStatus = 200 }) {
  const applied = [];
  const fetchImpl = async (url, init = {}) => {
    assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${REF}/database/migrations`));
    if ((init.method || 'GET') === 'GET') {
      if (ledgerStatus !== 200) return { ok: false, status: ledgerStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => [...ledger, ...applied].map((name) => ({ name })) };
    }
    const { name, query } = JSON.parse(init.body);
    assert.equal(query, readFileSync(join(dir, `${name}.sql`), 'utf8'), 'the file is sent verbatim');
    if (name === failOn) return { ok: false, status: 400, text: async () => 'syntax error' };
    applied.push(name);
    return { ok: true, status: 201, text: async () => '' };
  };
  return { fetchImpl, applied };
}

test('outage case: a Worker whose newest migration is missing gets it applied before deploy', async () => {
  const api = fakeApi({ ledger: ledgerThrough(files.at(-2)) });
  const done = await syncMigrations({ dir, ref: REF, token: 't', fetchImpl: api.fetchImpl, log: () => {} });
  assert.deepEqual(done, [last]);
  assert.deepEqual(api.applied, [last]);
});

test('several new migrations are applied in number order; an up-to-date ledger applies nothing', async () => {
  const api = fakeApi({ ledger: ledgerThrough(files.at(-4)) });
  await syncMigrations({ dir, ref: REF, token: 't', fetchImpl: api.fetchImpl, log: () => {} });
  assert.deepEqual(api.applied, files.slice(-3));
  const current = fakeApi({ ledger: ledgerThrough(last) });
  assert.deepEqual(await syncMigrations({ dir, ref: REF, token: 't', fetchImpl: current.fetchImpl, log: () => {} }), []);
  assert.deepEqual(current.applied, []);
});

test('a failed migration stops the run: nothing after it is applied, and it refuses', async () => {
  const api = fakeApi({ ledger: ledgerThrough(files.at(-4)), failOn: files.at(-2) });
  await assert.rejects(syncMigrations({ dir, ref: REF, token: 't', fetchImpl: api.fetchImpl, log: () => {} }), Refusal);
  assert.deepEqual(api.applied, [files.at(-3)]);
});

test('data-loss case: an unreadable or empty ledger refuses and never re-runs old migrations', async () => {
  for (const api of [fakeApi({ ledger: [], ledgerStatus: 503 }), fakeApi({ ledger: [] })]) {
    await assert.rejects(syncMigrations({ dir, ref: REF, token: 't', fetchImpl: api.fetchImpl, log: () => {} }), Refusal);
    assert.deepEqual(api.applied, []);
  }
  const down = async () => { throw new Error('fetch failed'); };
  await assert.rejects(syncMigrations({ dir, ref: REF, token: 't', fetchImpl: down, log: () => {} }), Refusal);
});

test('a missing file older than an applied one is a gap: refused, never applied automatically', () => {
  const gap = files.at(-3);
  const ledger = ledgerThrough(last).filter((n) => n !== gap);
  assert.throws(() => pendingMigrations(files, ledger), (e) => e instanceof Refusal && e.message.includes(gap));
});

test('no token refuses with a named stop', async () => {
  await assert.rejects(syncMigrations({ dir, ref: REF, token: '', fetchImpl: fakeApi({ ledger: [] }).fetchImpl }), /NAMED STOP \[SUPABASE_ACCESS_TOKEN_MISSING\]/);
});

test('both deploy paths apply migrations after the tests and before wrangler deploy', () => {
  const sh = readFileSync(join(root, 'scripts/deploy-api-production.sh'), 'utf8');
  const at = sh.indexOf('node scripts/db-migrations.mjs || exit 2');
  assert.ok(at > sh.indexOf('npm run test') && at < sh.indexOf('npx wrangler deploy'));
  const wf = readFileSync(join(root, '.github/workflows/deploy-cloudflare.yml'), 'utf8');
  const step = wf.indexOf('run: node scripts/db-migrations.mjs');
  assert.ok(step > wf.indexOf('npm run test') && step < wf.indexOf('npx wrangler deploy'));
});
