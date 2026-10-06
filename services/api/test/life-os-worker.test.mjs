// Worker-side contract for the governed Life OS write path (migration 0017):
// every Life OS mutation goes through an RPC, the completion path hands the
// planning engine's next schedule + the row version to the database, the
// data-rights read path uses the owner-only export function, and RPC errors map
// to the documented HTTP responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir;
let repo;
let platform;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-api-test-'));
  await build({
    entryPoints: { lifeOs: join(srcDir, 'lifeOsRepository.ts'), platform: join(srcDir, 'platformRepository.ts') },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outdir: outDir,
    logLevel: 'silent',
  });
  repo = await import(pathToFileURL(join(outDir, 'lifeOs.js')).href);
  platform = await import(pathToFileURL(join(outDir, 'platform.js')).href);
});

test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
const USER = '00000000-0000-4000-8000-00000000000a';

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url).replace(env.SUPABASE_URL, ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function assertNoDirectLifeOsWrites(calls) {
  for (const call of calls) {
    if (/^\/rest\/v1\/life_(relationships|admin_items)/.test(call.url)) {
      assert.equal(call.method, 'GET', `direct ${call.method} to ${call.url}`);
    }
  }
}

const itemRow = (overrides = {}) => ({
  id: 'item-1', person_id: null, kind: 'bill', title: 'Rent', status: 'open', importance: 3,
  due_at: '2026-10-01T15:00:00.000Z', starts_at: null, ends_at: null,
  recurrence: { frequency: 'monthly', interval: 1, anchorDueAt: '2026-10-01T15:00:00.000Z' },
  amount_minor: null, currency: null, details: {}, completed_at: null,
  provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1,
  created_at: '2026-09-01T00:00:00.123456+00:00', updated_at: '2026-09-02T00:00:00.654321+00:00',
  ...overrides,
});

test('create/update item call governed RPCs with no system fields and never write the table directly', async () => {
  const mock = mockFetch((call) => ({ json: call.url.startsWith('/rest/v1/rpc/') ? itemRow() : [itemRow()] }));
  try {
    await repo.createLifeAdminItem(env, 'jwt', USER, { kind: 'bill', title: 'Rent', dueAt: '2026-10-01T15:00:00.000Z', recurrence: { frequency: 'monthly' } }, 'America/Chicago');
    await repo.updateLifeAdminItem(env, 'jwt', USER, 'item-1', { title: 'Rent (new)' }, 'America/Chicago');
  } finally { mock.restore(); }

  assertNoDirectLifeOsWrites(mock.calls);
  const create = mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_create_item');
  assert.equal(create.method, 'POST');
  assert.deepEqual(Object.keys(create.body), ['p_item']);
  for (const forbidden of ['user_id', 'provenance_kind', 'source_type', 'source_ref', 'confidence', 'completed_at', 'updated_at']) {
    assert.equal(forbidden in create.body.p_item, false, forbidden);
  }
  assert.deepEqual(create.body.p_item.recurrence, { frequency: 'monthly', interval: 1, timezone: 'America/Chicago', anchorDueAt: '2026-10-01T15:00:00.000Z' });

  const update = mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_update_item');
  assert.deepEqual(update.body, { p_id: 'item-1', p_patch: { title: 'Rent (new)' } });
});

test('completion passes the planning engine schedule and the row version; DB owns completed_at', async () => {
  const existing = itemRow();
  const mock = mockFetch((call) => ({ json: call.url.startsWith('/rest/v1/rpc/') ? itemRow({ due_at: '2026-11-01T15:00:00.000Z' }) : [existing] }));
  try {
    await repo.completeLifeAdminItem(env, 'jwt', USER, 'item-1', 'America/Chicago');
  } finally { mock.restore(); }

  assertNoDirectLifeOsWrites(mock.calls);
  const call = mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_complete_item');
  assert.equal(call.body.p_id, 'item-1');
  assert.equal(call.body.p_expected_updated_at, existing.updated_at);
  // 10:00 Chicago stays 10:00 local across the CDT -> CST change.
  assert.equal(call.body.p_next_due_at, '2026-11-01T16:00:00.000Z');
  assert.equal(call.body.p_next_starts_at, null);
  assert.equal(call.body.p_recurrence.frequency, 'monthly');
  assert.equal(call.body.p_recurrence.anchorDueAt, existing.recurrence.anchorDueAt);
  assert.equal('p_completed_at' in call.body, false);
  assert.equal('p_status' in call.body, false);

  const oneOff = itemRow({ recurrence: {} });
  const mock2 = mockFetch((c) => ({ json: c.url.startsWith('/rest/v1/rpc/') ? itemRow({ status: 'completed', recurrence: {} }) : [oneOff] }));
  try { await repo.completeLifeAdminItem(env, 'jwt', USER, 'item-1'); } finally { mock2.restore(); }
  const call2 = mock2.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_complete_item');
  assert.equal(call2.body.p_next_due_at, null);
  assert.equal(call2.body.p_recurrence, null);
});

test('relationship writes go through RPCs', async () => {
  const relRow = { id: 'rel-1', person_id: 'p-1', birthday: null, next_contact_at: null, cadence_days: 14, notes: null, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };
  const person = { id: 'p-1', name: 'Ada', relationship: null, email: null, phone: null, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z' };
  const mock = mockFetch((call) => {
    if (call.url.startsWith('/rest/v1/rpc/')) return { json: relRow };
    if (call.url.startsWith('/rest/v1/people')) return { json: [person] };
    return { json: [relRow] };
  });
  try {
    await repo.createRelationship(env, 'jwt', USER, { personId: 'p-1', cadenceDays: 14 });
    await repo.updateRelationship(env, 'jwt', USER, 'rel-1', { notes: 'call' });
  } finally { mock.restore(); }
  assertNoDirectLifeOsWrites(mock.calls);
  assert.deepEqual(mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_save_relationship').body,
    { p_person_id: 'p-1', p_birthday: null, p_next_contact_at: null, p_cadence_days: 14, p_notes: null });
  assert.deepEqual(mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_life_os_update_relationship').body,
    { p_id: 'rel-1', p_patch: { notes: 'call' } });
});

test('RPC lifecycle errors surface as typed errors and map to HTTP responses', async () => {
  const mock = mockFetch((c) => (c.url.startsWith('/rest/v1/rpc/')
    ? { status: 400, json: { code: '22023', message: 'life_os_invalid_completion' } }
    : { json: [itemRow()] }));
  try {
    await assert.rejects(repo.updateLifeAdminItem(env, 'jwt', USER, 'item-1', { title: 'x' }), /life_os_invalid_completion/);
  } finally { mock.restore(); }
  assert.deepEqual(repo.lifeOsErrorResponse(new Error('life_os_invalid_completion')), { error: 'invalid_request', status: 400 });
  assert.deepEqual(repo.lifeOsErrorResponse(new Error('life_os_required')), { error: 'life_os_required', status: 403 });
  assert.deepEqual(repo.lifeOsErrorResponse(new Error('life_os_conflict')), { error: 'conflict', status: 409 });
  assert.deepEqual(repo.lifeOsErrorResponse(new Error('life_os_field_not_allowed')), { error: 'invalid_request', status: 400 });
  assert.equal(repo.lifeOsErrorResponse(new Error('something_else')), undefined);

  const opaque = mockFetch((c) => (c.url.startsWith('/rest/v1/rpc/') ? { status: 500, json: { message: 'internal; DROP' } } : { json: [itemRow()] }));
  try {
    await assert.rejects(repo.updateLifeAdminItem(env, 'jwt', USER, 'item-1', { title: 'x' }), (error) => error.name === 'SupabaseRestError');
  } finally { opaque.restore(); }
});

test('data-rights inspection/export reads through the owner-only function, not the entitlement-gated tables', async () => {
  const mock = mockFetch(() => ({ json: { life_relationships: [], life_admin_items: [itemRow({ status: 'completed' })] } }));
  let state;
  try { state = await platform.getLifeOsExportState(env, 'jwt', USER); } finally { mock.restore(); }
  assert.deepEqual(mock.calls.map((c) => [c.method, c.url]), [['POST', '/rest/v1/rpc/apm_life_os_data_rights_export']]);
  assert.equal(state.lifeAdminItems.length, 1);
  assert.equal(state.lifeAdminItems[0].status, 'completed');
});

test('no Worker source writes Life OS tables directly or re-audits governed writes', async () => {
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = await readFile(join(srcDir, file), 'utf8');
    for (const match of text.matchAll(/\/rest\/v1\/life_(?:relationships|admin_items)[^\n]*\n?[^\n]*\n?[^\n]*\n?[^\n]*/g)) {
      assert.doesNotMatch(match[0], /method:\s*'(POST|PATCH|PUT|DELETE)'/, `${file}: direct Life OS write`);
    }
    assert.doesNotMatch(text, /audit\([^)]*'life_os\./, `${file}: Life OS audit is written by the governed RPC`);
  }
  const index = await readFile(join(srcDir, 'index.ts'), 'utf8');
  for (const route of ["'/v1/privacy/life-os'", "'/v1/privacy/export'"]) {
    const body = index.slice(index.indexOf(route), index.indexOf('});', index.indexOf(route)));
    assert.match(body, /getLifeOsExportState/, `${route} must use the data-rights export`);
  }
});
