// Worker side of migration 0043: the action ledger and the erasure processor.
//   * prepare/approve go only through the service-role ledger functions; a losing
//     claim (double tap) never reaches the provider; failures are recorded;
//   * the erasure processor revokes, purges, deletes the auth identity, then records
//     the receipt; any failure returns the job with its code; overdue is a NAMED STOP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let engine; let rights; let crypto;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-governed-worker-'));
  await build({
    entryPoints: { engine: join(srcDir, 'actionEngine.ts'), rights: join(srcDir, 'dataRights.ts'), crypto: join(srcDir, 'crypto.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  engine = await import(pathToFileURL(join(outDir, 'engine.js')).href);
  rights = await import(pathToFileURL(join(outDir, 'rights.js')).href);
  crypto = await import(pathToFileURL(join(outDir, 'crypto.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const CONN = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_server_only',
  GLOBAL_ACTION_EXECUTION: 'true', ACTION_CALENDAR_EXECUTION: 'true', CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const raw = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : undefined;
    const call = { url: String(url).replace(env.SUPABASE_URL, ''), method: init.method ?? 'GET', body: raw, apikey: headers.get('apikey') };
    calls.push(call);
    const { status = 200, json } = await handler(call);
    return new Response(status === 204 ? null : JSON.stringify(json ?? null), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const rpcError = (message) => ({ status: 400, json: { code: 'P0001', message } });

const row = (overrides = {}) => ({
  id: 'act-1', user_id: USER, domain: 'calendar', action_type: 'calendar.create', status: 'prepared',
  payload: { connectionId: CONN, title: 'Lunch', startsAt: '2099-01-05T12:00:00Z', endsAt: '2099-01-05T13:00:00Z', provider: 'google' },
  reason: 'Book lunch', permission_id: 'perm-1', idempotency_key: 'key-12345678', requires_approval: true,
  approved_at: null, executed_at: null, verified_at: null, failure_code: null, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z', ...overrides,
});
const permission = { id: 'perm-1', userId: USER, domain: 'calendar', actionType: 'calendar.create', autonomyLevel: 4, constraints: {}, enabled: true, updatedAt: '2026-10-01T00:00:00Z' };
const entitlement = { userId: USER, plan: 'autopilot', status: 'active' };
const mapped = (r) => ({ id: r.id, userId: USER, domain: r.domain, actionType: r.action_type, status: r.status, payload: r.payload, reason: r.reason, idempotencyKey: r.idempotency_key, requiresApproval: true, createdAt: r.created_at, updatedAt: r.updated_at });

function noDirectLedgerWrites(calls) {
  for (const call of calls) assert.doesNotMatch(call.url, /^\/rest\/v1\/(actions|action_attempts|audit_events)/, `direct ${call.method} ${call.url}`);
  for (const call of calls.filter((c) => c.url.startsWith('/rest/v1/rpc/apm_service_action_'))) assert.equal(call.apikey, env.SUPABASE_SECRET_KEY);
}

test('prepare: the service ledger function is the only write; a replay is returned unchanged; conflicts map to 409', async () => {
  const mock = mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_service_action_prepare') {
      if (call.body.p_idempotency_key === 'key-conflict') return rpcError('action_idempotency_conflict');
      return { json: { action: row({ status: 'verified' }), replayed: true } };
    }
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    const input = { env, accessToken: 'jwt', userId: USER, domain: 'calendar', actionType: 'calendar.create', payload: row().payload, reason: 'Book lunch', idempotencyKey: 'key-12345678', permission, entitlement };
    const out = await engine.prepareAction(input);
    assert.deepEqual([out.replayed, out.action.status], [true, 'verified'], 'a retry after execution is never reset to prepared');
    assert.deepEqual(mock.calls[0].body, { p_user_id: USER, p_domain: 'calendar', p_action_type: 'calendar.create', p_payload: row().payload, p_reason: 'Book lunch', p_permission_id: 'perm-1', p_idempotency_key: 'key-12345678' });
    const conflict = await engine.prepareAction({ ...input, idempotencyKey: 'key-conflict' }).catch((e) => e);
    assert.deepEqual(engine.actionErrorResponse(conflict), { error: 'idempotency_conflict', status: 409 });
    noDirectLedgerWrites(mock.calls);
  } finally { mock.restore(); }
});

test('approve: a losing claim (double tap) never reaches the provider; a winner executes once and records the result', async () => {
  const encrypted = await crypto.encryptConnectorCredential(env, { accessToken: 'ya29.token', expiresAt: Date.now() + 3_600_000 });
  let claims = 0;
  const mock = mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_service_action_claim') {
      claims += 1;
      return claims === 1 ? { json: row({ status: 'executing' }) } : rpcError('action_invalid_state');
    }
    if (call.url.startsWith('/rest/v1/integration_connections')) return { json: [{ id: CONN, provider: 'google', kind: 'calendar', encrypted_credentials: encrypted.ciphertext, credential_iv: encrypted.iv }] };
    if (call.url.startsWith('https://www.googleapis.com/calendar')) return { json: { id: 'evt-1' } };
    if (call.url === '/rest/v1/rpc/apm_service_action_result') return { json: row({ status: call.body.p_outcome, verified_at: '2026-10-06T00:01:00Z' }) };
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    const input = { env, accessToken: 'jwt', userId: USER, action: mapped(row()), permission, entitlement };
    const [first, second] = await Promise.allSettled([engine.approveAndMaybeExecuteAction(input), engine.approveAndMaybeExecuteAction(input)]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(first.value.status, 'verified');
    assert.equal(second.status, 'rejected');
    assert.deepEqual(engine.actionErrorResponse(second.reason), { error: 'invalid_action_state', status: 409 });
    assert.equal(mock.calls.filter((c) => c.url.startsWith('https://www.googleapis.com/calendar')).length, 1, 'one provider call');
    const results = mock.calls.filter((c) => c.url === '/rest/v1/rpc/apm_service_action_result');
    assert.deepEqual(results.map((c) => [c.body.p_outcome, c.body.p_external_ref]), [['verified', 'evt-1']]);
    noDirectLedgerWrites(mock.calls);
  } finally { mock.restore(); }
});

test('approve: a provider failure is recorded as failed through the ledger', async () => {
  const encrypted = await crypto.encryptConnectorCredential(env, { accessToken: 'ya29.token', expiresAt: Date.now() + 3_600_000 });
  const mock = mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_service_action_claim') return { json: row({ status: 'executing' }) };
    if (call.url.startsWith('/rest/v1/integration_connections')) return { json: [{ id: CONN, provider: 'google', kind: 'calendar', encrypted_credentials: encrypted.ciphertext, credential_iv: encrypted.iv }] };
    if (call.url.startsWith('https://www.googleapis.com/calendar')) return { status: 500, json: {} };
    if (call.url === '/rest/v1/rpc/apm_service_action_result') return { json: row({ status: 'failed' }) };
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    await assert.rejects(engine.approveAndMaybeExecuteAction({ env, accessToken: 'jwt', userId: USER, action: mapped(row()), permission, entitlement }), /google_calendar_action_failed:500/);
    const result = mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_service_action_result');
    assert.deepEqual([result.body.p_outcome, result.body.p_failure_code], ['failed', 'google_calendar_action_failed:500']);
    noDirectLedgerWrites(mock.calls);
  } finally { mock.restore(); }
});

test('erasure: revoke, purge, delete the auth identity, then the receipt — in that order, all with the server key', async () => {
  const encrypted = await crypto.encryptConnectorCredential(env, { accessToken: 'ya29.a', refreshToken: '1//refresh' });
  const order = [];
  const mock = mockFetch((call) => {
    const fn = call.url.match(/^\/rest\/v1\/rpc\/(\w+)/)?.[1];
    order.push(fn ?? `${call.method} ${call.url.split('?')[0]}`);
    if (fn) assert.equal(call.apikey, env.SUPABASE_SECRET_KEY);
    if (fn === 'apm_service_data_rights_claim_deletions') return { json: [{ jobId: 'job-1', userId: USER, requestedAt: '2026-10-06T00:00:00Z', connections: [{ id: CONN, provider: 'google', kind: 'email', encryptedCredentials: encrypted.ciphertext, credentialIv: encrypted.iv }, { id: 'c2', provider: 'microsoft', kind: 'calendar', encryptedCredentials: 'x', credentialIv: 'y' }] }] };
    if (call.url === 'https://oauth2.googleapis.com/revoke') { assert.equal(call.body.token, '1//refresh'); return { json: {} }; }
    if (fn === 'apm_service_data_rights_purge') { assert.deepEqual(call.body.p_steps.connectors, { [CONN]: 'revoked', c2: 'credential_destroyed' }); return { status: 204 }; }
    if (call.url === `/auth/v1/admin/users/${USER}`) { assert.equal(call.method, 'DELETE'); assert.equal(call.apikey, env.SUPABASE_SECRET_KEY); return { json: {} }; }
    if (fn === 'apm_service_data_rights_finish') return { json: { jobId: 'job-1', status: 'complete' } };
    if (fn === 'apm_service_data_rights_overdue') return { json: 0 };
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    const result = await rights.runDataRightsErasures(env);
    assert.deepEqual(result, { status: 'ok', claimed: 1, erased: 1, failed: 0, overdue: 0 });
    assert.deepEqual(order, ['apm_service_data_rights_claim_deletions', 'POST https://oauth2.googleapis.com/revoke', 'apm_service_data_rights_purge',
      `DELETE /auth/v1/admin/users/${USER}`, 'apm_service_data_rights_finish', 'apm_service_data_rights_overdue']);
  } finally { mock.restore(); }
});

test('erasure: a failed step returns the job with its code and never records completion; overdue is a NAMED STOP', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  const mock = mockFetch((call) => {
    const fn = call.url.match(/^\/rest\/v1\/rpc\/(\w+)/)?.[1];
    if (fn === 'apm_service_data_rights_claim_deletions') return { json: [{ jobId: 'job-2', userId: USER, requestedAt: '2026-10-01T00:00:00Z', connections: [] }] };
    if (fn === 'apm_service_data_rights_purge') return { status: 204 };
    if (call.url.startsWith('/auth/v1/admin/users/')) return { status: 500, json: {} };
    if (fn === 'apm_service_data_rights_fail') return { status: 204 };
    if (fn === 'apm_service_data_rights_overdue') return { json: 1 };
    throw new Error(`unexpected ${call.url}`);
  });
  try {
    const result = await rights.runDataRightsErasures(env);
    assert.deepEqual(result, { status: 'ok', claimed: 1, erased: 0, failed: 1, overdue: 1 });
    assert.ok(!mock.calls.some((c) => c.url.endsWith('apm_service_data_rights_finish')));
    assert.deepEqual(mock.calls.find((c) => c.url.endsWith('apm_service_data_rights_fail')).body, { p_job_id: 'job-2', p_failure_code: 'auth_delete_failed:500' });
    assert.ok(errors.some((args) => String(args[0]).startsWith('APM NAMED STOP: data-rights erasure overdue')));
  } finally { mock.restore(); console.error = originalError; }
  // Without the server key nothing runs, and it says so.
  assert.equal((await rights.runDataRightsErasures({ ...env, SUPABASE_SECRET_KEY: undefined })).status, 'not_configured');
});
