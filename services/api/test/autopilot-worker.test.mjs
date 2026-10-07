// Worker-side contract for Autopilot standing rules (migration 0018): every
// Autopilot write goes through a governed RPC, standing execution fails closed
// before the claim when any kill switch / entitlement / permission / activation
// is missing, only a successful claim reaches the provider, results and undo
// are recorded through RPCs, replays never re-execute, and the per-action
// approval route can no longer escalate to level 5.
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
let cryptoMod;
let engine;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-autopilot-test-'));
  await build({
    entryPoints: { autopilot: join(srcDir, 'autopilotRepository.ts'), crypto: join(srcDir, 'crypto.ts'), engine: join(srcDir, 'actionEngine.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  repo = await import(pathToFileURL(join(outDir, 'autopilot.js')).href);
  cryptoMod = await import(pathToFileURL(join(outDir, 'crypto.js')).href);
  engine = await import(pathToFileURL(join(outDir, 'engine.js')).href);
});

test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const CONN = '11111111-1111-4111-8111-111111111111';
const baseEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test' };
const liveEnv = {
  ...baseEnv, GLOBAL_ACTION_EXECUTION: 'true', ACTION_CALENDAR_EXECUTION: 'true', ACTION_EMAIL_EXECUTION: 'true', AUTOPILOT_EXECUTION: 'true',
  CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
};

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url).replace(baseEnv.SUPABASE_URL, ''), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function assertNoDirectAutopilotWrites(calls) {
  for (const call of calls) {
    if (/^\/rest\/v1\/(autopilot_|actions|action_attempts|audit_events)/.test(call.url)) {
      assert.equal(call.method, 'GET', `direct ${call.method} to ${call.url}`);
    }
  }
}

const rule = {
  id: 'rule-1', userId: USER, actionClass: 'calendar.create', status: 'active', version: 1,
  constraints: { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], windowStart: '06:00', windowEnd: '09:00', maxDurationMinutes: 60, maxPerDay: 1, horizonDays: 14, collision: 'never_overlap_busy' },
  grantedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
};
const activeState = { entitled: true, masterPaused: false, rules: [rule], executions: [], classes: [{ actionClass: 'calendar.create', domain: 'calendar', actionType: 'calendar.create', reversible: true, undoMethod: 'delete_event', activationStatus: 'active' }] };
const permission = { id: 'perm-1', userId: USER, domain: 'calendar', actionType: 'calendar.create', autonomyLevel: 5, constraints: {}, enabled: true, updatedAt: '2026-10-01T00:00:00Z' };
const entitlement = { userId: USER, plan: 'autopilot', status: 'active' };
const payload = { connectionId: CONN, title: 'Strength', startsAt: '2099-01-05T06:00:00Z', endsAt: '2099-01-05T07:00:00Z' };
const executionRow = (overrides = {}) => ({
  id: 'exec-1', user_id: USER, rule_id: 'rule-1', rule_version: 1, action_class: 'calendar.create', action_id: 'act-1', status: 'claimed',
  idempotency_key: 'idem-0001', proposed_starts_at: payload.startsAt, proposed_ends_at: payload.endsAt, local_day: '2099-01-05',
  external_ref: null, failure_code: null, claimed_at: '2026-10-06T00:00:00Z', completed_at: null, reverted_at: null, ...overrides,
});
const actionRow = { id: 'act-1', user_id: USER, domain: 'calendar', action_type: 'calendar.create', status: 'executing', payload, reason: 'Routine', permission_id: 'perm-1', idempotency_key: 'autopilot:idem-0001', requires_approval: false, approved_at: '2026-10-06T00:00:00Z', executed_at: null, verified_at: null, failure_code: null, created_at: '2026-10-06T00:00:00Z', updated_at: '2026-10-06T00:00:00Z' };

const run = (env, overrides = {}) => repo.runStandingRule({
  env, accessToken: 'jwt', userId: USER, rule, state: activeState, permission, entitlement,
  idempotencyKey: 'idem-0001', reason: 'Routine', payload, ...overrides,
});

test('standing execution fails closed before any claim when a switch, entitlement, permission, activation or rule is missing', async () => {
  const cases = [
    [baseEnv, {}, 'autopilot_execution_disabled'],
    [{ ...liveEnv, GLOBAL_ACTION_EXECUTION: 'false' }, {}, 'global_execution_disabled'],
    [{ ...liveEnv, ACTION_CALENDAR_EXECUTION: 'false' }, {}, 'domain_execution_disabled'],
    [liveEnv, { entitlement: { ...entitlement, plan: 'life_os' } }, 'capability_not_entitled'],
    [liveEnv, { entitlement: { ...entitlement, status: 'past_due' } }, 'capability_not_entitled'],
    [liveEnv, { permission: undefined }, 'permission_missing_or_disabled'],
    [liveEnv, { permission: { ...permission, autonomyLevel: 4 } }, 'permission_too_low'],
    [liveEnv, { rule: { ...rule, status: 'paused' } }, 'rule_inactive'],
    [liveEnv, { rule: { ...rule, expiresAt: '2020-01-01T00:00:00Z' } }, 'rule_expired'],
    [liveEnv, { state: { ...activeState, masterPaused: true } }, 'autopilot_paused'],
    [liveEnv, { state: { ...activeState, classes: [{ ...activeState.classes[0], activationStatus: 'inactive' }] } }, 'class_not_activated'],
  ];
  for (const [env, overrides, reason] of cases) {
    const mock = mockFetch(() => ({ json: {} }));
    try {
      await assert.rejects(run(env, overrides), new RegExp(`autopilot_not_authorized:${reason}$`));
    } finally { mock.restore(); }
    assert.deepEqual(mock.calls, [], `${reason}: no claim and no provider call`);
  }
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_not_authorized:class_not_activated')), { error: 'autopilot_not_authorized', status: 403, reason: 'class_not_activated' });
});

async function providerMock(providerStatus) {
  const sealed = await cryptoMod.encryptConnectorCredential(liveEnv, { accessToken: 'provider-token', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 });
  return mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_autopilot_claim') return { json: { replayed: false, execution: executionRow(), action: actionRow } };
    if (call.url === '/rest/v1/rpc/apm_autopilot_record_result') {
      return { json: executionRow(call.body.p_outcome === 'verified' ? { status: 'verified', external_ref: call.body.p_external_ref } : { status: 'failed', failure_code: call.body.p_failure_code }) };
    }
    if (call.url.startsWith('/rest/v1/integration_connections')) return { json: [{ id: CONN, provider: 'google', kind: 'calendar', encrypted_credentials: sealed.ciphertext, credential_iv: sealed.iv }] };
    if (call.url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events')) return { status: providerStatus, json: providerStatus === 200 ? { id: 'gcal-1' } : { error: 'x' } };
    return { status: 500, json: { message: `unexpected ${call.url}` } };
  });
}

test('a granted claim executes once at the provider and records the verified result through the RPC', async () => {
  const mock = await providerMock(200);
  let result;
  try { result = await run(liveEnv); } finally { mock.restore(); }
  assertNoDirectAutopilotWrites(mock.calls);
  assert.deepEqual(mock.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`), [
    'POST /rest/v1/rpc/apm_autopilot_claim',
    'GET /rest/v1/integration_connections',
    'POST https://www.googleapis.com/calendar/v3/calendars/primary/events',
    'POST /rest/v1/rpc/apm_autopilot_record_result',
  ]);
  assert.deepEqual(mock.calls[0].body, { p_rule_id: 'rule-1', p_idempotency_key: 'idem-0001', p_payload: payload, p_reason: 'Routine' });
  assert.deepEqual(mock.calls[3].body, { p_execution_id: 'exec-1', p_outcome: 'verified', p_external_ref: 'gcal-1', p_failure_code: null });
  assert.equal(result.replayed, false);
  assert.equal(result.execution.status, 'verified');
  assert.equal(result.action.status, 'verified');
});

test('a provider failure is recorded as failed through the RPC and surfaces as execution_failed', async () => {
  const mock = await providerMock(503);
  try {
    await assert.rejects(run(liveEnv), /^Error: autopilot_execution_failed$/);
  } finally { mock.restore(); }
  assertNoDirectAutopilotWrites(mock.calls);
  const record = mock.calls.find((c) => c.url === '/rest/v1/rpc/apm_autopilot_record_result');
  assert.deepEqual(record.body, { p_execution_id: 'exec-1', p_outcome: 'failed', p_external_ref: null, p_failure_code: 'google_calendar_action_failed:503' });
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_execution_failed')), { error: 'execution_failed', status: 502 });
});

test('a replayed idempotency key never reaches the provider', async () => {
  const mock = mockFetch((call) => (call.url === '/rest/v1/rpc/apm_autopilot_claim'
    ? { json: { replayed: true, execution: executionRow({ status: 'verified', external_ref: 'gcal-1' }), action: { ...actionRow, status: 'verified' } } }
    : { status: 500, json: { message: 'must not be called' } }));
  let result;
  try { result = await run(liveEnv); } finally { mock.restore(); }
  assert.equal(result.replayed, true);
  assert.equal(result.execution.externalRef, 'gcal-1');
  assert.deepEqual(mock.calls.map((c) => c.url), ['/rest/v1/rpc/apm_autopilot_claim']);
});

test('database refusals surface as typed errors with documented HTTP mappings', async () => {
  const mock = mockFetch(() => ({ status: 403, json: { code: '42501', message: 'autopilot_outside_rule' } }));
  try {
    await assert.rejects(run(liveEnv), /^Error: autopilot_outside_rule$/);
  } finally { mock.restore(); }
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_outside_rule')), { error: 'outside_rule', status: 403 });
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_collision')), { error: 'collision', status: 409 });
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_required')), { error: 'autopilot_required', status: 403 });
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_class_not_activated')), { error: 'class_not_activated', status: 403 });
  assert.deepEqual(repo.autopilotErrorResponse(new Error('autopilot_unsupported_action_class')), { error: 'unsupported_action_class', status: 400 });
  assert.equal(repo.autopilotErrorResponse(new Error('something_else')), undefined);
  const opaque = mockFetch(() => ({ status: 500, json: { message: 'internal; DROP' } }));
  try {
    await assert.rejects(run(liveEnv), (error) => error.name === 'SupabaseRestError');
  } finally { opaque.restore(); }
});

test('rule lifecycle writes are RPC-only with exactly the documented arguments', async () => {
  const ruleRow = { id: 'rule-1', user_id: USER, action_class: 'calendar.create', status: 'active', constraints: rule.constraints, version: 2, granted_at: rule.grantedAt, expires_at: rule.expiresAt, paused_at: null, revoked_at: null, revoke_reason: null, last_executed_at: null, created_at: rule.createdAt, updated_at: rule.updatedAt };
  const mock = mockFetch((call) => ({ json: call.url.endsWith('set_master_pause') ? { user_id: USER, paused: true, paused_at: null } : ruleRow }));
  try {
    await repo.grantAutopilotRule(baseEnv, 'jwt', { actionClass: 'calendar.create', constraints: rule.constraints, expiresAt: rule.expiresAt });
    await repo.updateAutopilotRule(baseEnv, 'jwt', 'rule-1', { expectedVersion: 1, expiresAt: rule.expiresAt });
    await repo.setAutopilotRuleStatus(baseEnv, 'jwt', 'rule-1', 'paused', 2);
    await repo.revokeAutopilotRule(baseEnv, 'jwt', 'rule-1');
    await repo.setAutopilotMasterPause(baseEnv, 'jwt', true);
  } finally { mock.restore(); }
  assertNoDirectAutopilotWrites(mock.calls);
  const body = (fn) => mock.calls.find((c) => c.url === `/rest/v1/rpc/${fn}`).body;
  assert.deepEqual(body('apm_autopilot_grant_rule'), { p_action_class: 'calendar.create', p_constraints: rule.constraints, p_expires_at: rule.expiresAt });
  assert.deepEqual(body('apm_autopilot_update_rule'), { p_id: 'rule-1', p_expected_version: 1, p_constraints: null, p_expires_at: rule.expiresAt });
  assert.deepEqual(body('apm_autopilot_set_rule_status'), { p_id: 'rule-1', p_status: 'paused', p_expected_version: 2 });
  assert.deepEqual(body('apm_autopilot_revoke_rule'), { p_id: 'rule-1', p_reason: null });
  assert.deepEqual(body('apm_autopilot_set_master_pause'), { p_paused: true });
});

test('ordinary reads are skipped without entitlement; data-rights export reads through the owner-only RPC', async () => {
  const mock = mockFetch(() => ({ json: [] }));
  try {
    const state = await repo.getAutopilotState(baseEnv, 'jwt', USER, false);
    assert.equal(state.entitled, false);
    assert.deepEqual(state.rules, []);
  } finally { mock.restore(); }
  assert.deepEqual(mock.calls.map((c) => c.url), ['/rest/v1/autopilot_action_classes?select=*&order=class_key.asc']);

  const exp = mockFetch(() => ({ json: { autopilot_rules: [], autopilot_executions: [executionRow({ status: 'reverted' })], autopilot_settings: { user_id: USER, paused: true } } }));
  let exported;
  try { exported = await repo.getAutopilotExportState(baseEnv, 'jwt'); } finally { exp.restore(); }
  assert.deepEqual(exp.calls.map((c) => [c.method, c.url]), [['POST', '/rest/v1/rpc/apm_autopilot_data_rights_export']]);
  assert.equal(exported.executions[0].status, 'reverted');
  assert.equal(exported.masterPaused, true);
});

test('undo reads the owner-only target, needs the provider switches, and records the reversal by RPC', async () => {
  const target = { executionId: 'exec-1', domain: 'calendar', undoMethod: 'delete_event', externalRef: 'gcal-1', connectionId: CONN };
  const off = mockFetch(() => ({ json: target }));
  try {
    await assert.rejects(repo.undoStandingExecution({ env: baseEnv, accessToken: 'jwt', userId: USER, executionId: 'exec-1' }), /autopilot_not_authorized/);
  } finally { off.restore(); }
  assert.deepEqual(off.calls.map((c) => c.url), ['/rest/v1/rpc/apm_autopilot_undo_target']);

  const sealed = await cryptoMod.encryptConnectorCredential(liveEnv, { accessToken: 'provider-token', expiresAt: Date.now() + 3_600_000 });
  const live = mockFetch((call) => {
    if (call.url === '/rest/v1/rpc/apm_autopilot_undo_target') return { json: target };
    if (call.url.startsWith('/rest/v1/integration_connections')) return { json: [{ id: CONN, provider: 'google', kind: 'calendar', encrypted_credentials: sealed.ciphertext, credential_iv: sealed.iv }] };
    if (call.url.startsWith('https://www.googleapis.com/')) return { status: 404, json: {} };
    if (call.url === '/rest/v1/rpc/apm_autopilot_record_undo') return { json: executionRow({ status: 'reverted', external_ref: 'gcal-1', reverted_at: '2026-10-06T01:00:00Z' }) };
    return { status: 500, json: {} };
  });
  let reverted;
  try { reverted = await repo.undoStandingExecution({ env: liveEnv, accessToken: 'jwt', userId: USER, executionId: 'exec-1' }); } finally { live.restore(); }
  assertNoDirectAutopilotWrites(live.calls);
  assert.deepEqual(live.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`), [
    'POST /rest/v1/rpc/apm_autopilot_undo_target',
    'GET /rest/v1/integration_connections',
    'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/gcal-1',
    'POST /rest/v1/rpc/apm_autopilot_record_undo',
  ]);
  assert.equal(reverted.status, 'reverted');
});

test('no Worker source writes Autopilot tables directly, re-audits governed transitions, or escalates approvals to level 5', async () => {
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = await readFile(join(srcDir, file), 'utf8');
    for (const match of text.matchAll(/\/rest\/v1\/autopilot_[a-z_]+[^\n]*\n?[^\n]*\n?[^\n]*/g)) {
      assert.doesNotMatch(match[0], /method:\s*'(POST|PATCH|PUT|DELETE)'/, `${file}: direct Autopilot write`);
    }
    assert.doesNotMatch(text, /audit\([^)]*'autopilot\./, `${file}: Autopilot audit is written by the governed RPC`);
  }
  const engine = await readFile(join(srcDir, 'actionEngine.ts'), 'utf8');
  assert.match(engine, /const requestedLevel: AutonomyLevel = 4;/);
  assert.doesNotMatch(engine, /requiresApproval \? 4 : 5/);
  assert.match(engine, /requires_approval: true/);
  const index = await readFile(join(srcDir, 'index.ts'), 'utf8');
  const exportRoute = index.slice(index.indexOf("'/v1/privacy/export'"), index.indexOf("app.post('/v1/privacy/delete'"));
  assert.match(exportRoute, /getAutopilotExportState/);
  for (const route of ["'/v1/autopilot/rules'", "'/v1/autopilot/rules/:id/run'"]) {
    const body = index.slice(index.indexOf(route), index.indexOf('\n});', index.indexOf(route)));
    assert.match(body, /autopilot_required/, `${route} must check the entitlement before calling the database`);
  }
});

test('email actions with control characters in To/Subject are refused before any credential or provider call', async () => {
  const mock = mockFetch(() => ({ status: 500, json: {} }));
  try {
    for (const [to, subject] of [['teacher@school.example.org', 'Hi\r\nBcc: x@elsewhere.example.com'], ['a@b.org\r\nCc: c@d.org', 'Hi']]) {
      const action = { id: 'a', userId: USER, domain: 'email', actionType: 'email.draft', status: 'executing', payload: { connectionId: CONN, to, subject, body: 'x' }, reason: 'r', idempotencyKey: 'k', requiresApproval: false, createdAt: '', updatedAt: '' };
      await assert.rejects(engine.executeConnectorAction(action, { env: liveEnv, accessToken: 'jwt', userId: USER }), /email_action_invalid/);
    }
  } finally { mock.restore(); }
  assert.deepEqual(mock.calls, []);
});
