// Worker-side contract for the 18+ gate and the consumer health data consent (migration 0093):
//   * every account route answers 403 age_confirmation_required, and touches no data, until
//     the confirmation is on file; the open routes (consents, export, delete) still work;
//   * POST /v1/consents/age accepts only an explicit true and never a client timestamp;
//   * a health-data grant must name the current policy version; withdraw / decline are recorded;
//   * without a live grant the install and the later answers lose every health field, a
//     clinician clearance and a health-routine reminder are refused;
//   * the anonymous → account merge carries the decisions first and refuses without 18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let app;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-consent-worker-'));
  await build({ entryPoints: { app: join(srcDir, 'index.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  app = (await import(pathToFileURL(join(outDir, 'app.js')).href)).default;
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const V = '2026-10-08';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A fake Supabase for one user. `age` / `health` are the stored decisions. */
function harness({ user = id(1), anonymous = false, age = false, health = null, carriedAge = true, entitlement = 'life_os' } = {}) {
  const token = `tok-${user}`;
  const calls = [];
  const state = { age, health };
  const consents = () => ({ ageConfirmedAt: state.age ? '2026-10-08T09:00:00Z' : null, healthData: state.health ? { decision: state.health, recordedAt: '2026-10-08T09:00:00Z', policyVersion: V } : null });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(ENV.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/auth/v1/user') {
      const bearer = new Headers(init.headers).get('authorization')?.replace('Bearer ', '');
      if (bearer === token) return json({ id: user, is_anonymous: anonymous });
      if (bearer === 'tok-anon-0000000000000000000000') return json({ id: id(900), is_anonymous: true });
      return json({ message: 'bad jwt' }, 401);
    }
    calls.push({ path, method: init.method ?? 'GET', body });
    const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc === 'apm_my_consents') return json(consents());
    if (rpc === 'apm_record_consent') {
      if (body.p_kind === 'age_18_plus') state.age = true; else state.health = body.p_decision;
      return json(consents());
    }
    if (rpc === 'apm_service_carry_consents') { if (carriedAge) state.age = true; return json(consents()); }
    if (rpc === 'apm_claim_intake_install') return json('claimed');
    if (rpc === 'apm_request_data_rights') return json({ id: 'job-1', status: 'requested' });
    if (rpc === 'apm_service_merge_anonymous_draft') return json({ outcome: 'draft' });
    if (rpc === 'apm_get_intake_draft') return json(null);
    if (rpc === 'apm_create_life_admin_item') return json({ id: 'i1', kind: body?.p_item?.kind ?? 'bill' });
    if (rpc) return json(null);
    if (path.startsWith('/rest/v1/subscription_entitlements')) return json([{ user_id: user, plan: entitlement, status: 'active' }]);
    if (path.startsWith('/auth/v1/admin/users/')) return new Response(null, { status: 200 });
    if (init.method && init.method !== 'GET') return new Response(null, { status: 204 });
    return json([]);
  };
  const request = (route, init = {}, bearer = token) => app.fetch(new Request(`https://api.test${route}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } }), ENV);
  const rpcs = (fn) => calls.filter((c) => c.path === `/rest/v1/rpc/${fn}`);
  return { calls, state, request, rpcs, restore: () => { globalThis.fetch = original; } };
}

test('18+: account routes refuse with 403 and touch no data until the confirmation exists; the open routes still work', async () => {
  const h = harness({ user: id(11) });
  try {
    for (const [route, init] of [['/v1/me/today', {}], ['/v1/intake/draft', {}], ['/v1/intake/draft', { method: 'PUT', body: JSON.stringify({ bankVersion: 2, version: 1, answers: {}, cursor: 'games' }) }], ['/v1/methodology/intake', { method: 'PUT', body: '{}' }], ['/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 5 }) }]]) {
      const before = h.calls.length;
      const res = await h.request(route, init);
      assert.equal(res.status, 403, `${init.method ?? 'GET'} ${route}`);
      assert.equal((await res.json()).error, 'age_confirmation_required');
      assert.deepEqual(h.calls.slice(before).map((c) => c.path), ['/rest/v1/rpc/apm_my_consents'], `${route}: only the consent lookup ran`);
    }
    assert.equal((await h.request('/v1/consents')).status, 200);
    const deletion = await h.request('/v1/privacy/delete', { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) });
    assert.equal(deletion.status, 202, 'anyone may delete their account, confirmed or not');
    assert.equal((await h.request('/v1/me/today', {}, 'nobody')).status, 401, 'no session is still 401, not 403');
  } finally { h.restore(); }
});

test('POST /v1/consents/age: only an explicit true; the server stamps the time; then the account opens', async () => {
  const h = harness({ user: id(12) });
  try {
    for (const body of [{}, { confirmed: false }, { confirmed: 'yes' }, { confirmed: 1 }, { confirmed: true, confirmedAt: '2001-01-01T00:00:00Z' }, null]) {
      const res = await h.request('/v1/consents/age', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error, 'age_confirmation_required');
    }
    assert.equal(h.rpcs('apm_record_consent').length, 0, 'nothing recorded for a refusal');
    const ok = await h.request('/v1/consents/age', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).consents.ageConfirmedAt);
    assert.deepEqual(h.rpcs('apm_record_consent')[0].body, { p_kind: 'age_18_plus', p_decision: 'confirmed', p_policy_version: V }, 'no client time reaches the database');
    assert.equal((await h.request('/v1/me/today')).status === 403, false, 'the account opens after the confirmation');
  } finally { h.restore(); }
});

test('health-data consent: a grant names the current policy; decline and withdraw are recorded; bad input is refused', async () => {
  const h = harness({ user: id(13), age: true });
  try {
    const send = (body) => h.request('/v1/consents/health-data', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await send({ decision: 'granted' })).status, 409, 'a grant without the policy version on screen');
    assert.equal((await send({ decision: 'granted', policyVersion: '2025-01-01' })).status, 409);
    assert.equal((await send({ decision: 'maybe' })).status, 400);
    assert.equal((await send({ decision: 'granted', policyVersion: V, at: 'x' })).status, 400);
    assert.equal(h.rpcs('apm_record_consent').length, 0);
    const granted = await send({ decision: 'granted', policyVersion: V });
    assert.equal(granted.status, 200);
    assert.equal((await granted.json()).consents.healthData.decision, 'granted');
    assert.equal((await send({ decision: 'withdrawn' })).status, 200);
    assert.deepEqual(h.rpcs('apm_record_consent').map((c) => c.body), [
      { p_kind: 'consumer_health_data', p_decision: 'granted', p_policy_version: V },
      { p_kind: 'consumer_health_data', p_decision: 'withdrawn', p_policy_version: V },
    ]);
    const state = await (await h.request('/v1/consents')).json();
    assert.equal(state.consents.healthData.decision, 'withdrawn');
    assert.equal(state.healthPolicyVersion, V);
  } finally { h.restore(); }
});

const INSTALL = {
  roles: ['Founder / entrepreneur'], primaryGoal: 'Launch', values: [], nonNegotiables: [], failurePatterns: [],
  weeklyCadence: { heavyDays: [], lightDays: [] }, coachingStyle: { firmness: 'direct' }, accountability: { dayStart: 'guided' },
  criticalPillars: ['work'], minimumFloors: { work: 'Ship one thing' }, activeAreas: ['work', 'movement'], pillarsEnabled: ['mind', 'body', 'spirit'], trackKeys: [],
  bodyContext: 'Walks most days; knee injury last year.',
  intakeProfile: { bankVersion: 2, games: ['founder', 'weight'], foregroundGame: 'weight', mentalLoadItems: [], fixedCommitments: [], lineIds: [], deadlines: [], realWork: [], fakeWork: [], wealthContext: [], careerLevers: [], mindPractices: [], spiritPractices: [], faithLanguage: false, coachingHelps: [], coachingAvoid: [], quickStart: true, deferredQuestionIds: [], suggestedAreas: [], bodySafety: 'skip', bedRoutine: { gentle: true } },
};

test('without a live health grant: the install and later answers lose every health field; clearance and health reminders are refused', async () => {
  for (const health of [null, 'declined', 'withdrawn']) {
    const h = harness({ user: id(20 + ['x', 'declined', 'withdrawn'].indexOf(health ?? 'x')), age: true, health });
    try {
      assert.equal((await h.request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INSTALL) })).status, 200);
      const payload = h.rpcs('apm_save_methodology_intake')[0].body.p_payload;
      assert.equal(payload.body_context ?? null, null, `${health}: no body context`);
      assert.equal(payload.intake_profile.bodySafety, undefined);
      assert.equal(payload.intake_profile.bedRoutine, undefined);
      assert.deepEqual(payload.intake_profile.games, ['founder']);
      assert.equal(payload.intake_profile.foregroundGame, undefined);
      assert.equal(h.rpcs('apm_flag_body_referral').length, 0, 'no health answer, nothing to act on');

      assert.equal((await h.request('/v1/intake/profile', { method: 'PUT', body: JSON.stringify({ intakeProfile: INSTALL.intakeProfile }) })).status, 200);
      assert.equal(h.rpcs('apm_update_intake_profile')[0].body.p_profile.bodySafety, undefined);

      const clearance = await h.request('/v1/body/clearance', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      assert.equal(clearance.status, 403);
      assert.equal((await clearance.json()).error, 'health_data_consent_required');
      assert.equal(h.rpcs('apm_record_clinician_clearance').length, 0);

      const reminder = await h.request('/v1/life-os/items', { method: 'POST', body: JSON.stringify({ kind: 'health_routine', title: 'Vitamins' }) });
      assert.equal(reminder.status, 403);
      assert.equal(h.rpcs('apm_create_life_admin_item').length, 0);
    } finally { h.restore(); }
  }
  // With the grant, the same install keeps them.
  const h = harness({ user: id(30), age: true, health: 'granted' });
  try {
    await h.request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INSTALL) });
    const payload = h.rpcs('apm_save_methodology_intake')[0].body.p_payload;
    assert.equal(payload.intake_profile.bodySafety, 'skip');
    assert.deepEqual(payload.intake_profile.games, ['founder', 'weight']);
    assert.equal(h.rpcs('apm_flag_body_referral').length, 1, 'prefer-not-to-say still pauses body pace');
  } finally { h.restore(); }
});

test('merge: the anonymous decisions are carried before the draft; an account without 18+ is refused and nothing merges', async () => {
  const ok = harness({ user: id(40) });
  try {
    const res = await ok.request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-anon-0000000000000000000000' }) });
    assert.equal(res.status, 200);
    const order = ok.calls.map((c) => c.path.replace('/rest/v1/rpc/', ''));
    assert.ok(order.indexOf('apm_service_carry_consents') > -1 && order.indexOf('apm_service_carry_consents') < order.indexOf('apm_service_merge_anonymous_draft'));
    assert.deepEqual(ok.rpcs('apm_service_carry_consents')[0].body, { p_from: id(900), p_to: id(40) });
  } finally { ok.restore(); }
  const refused = harness({ user: id(41), carriedAge: false });
  try {
    const res = await refused.request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-anon-0000000000000000000000' }) });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'age_confirmation_required');
    assert.equal(refused.rpcs('apm_service_merge_anonymous_draft').length, 0);
  } finally { refused.restore(); }
});
