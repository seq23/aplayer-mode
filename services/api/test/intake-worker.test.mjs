// Worker-side contract for the first-run intake (docs/34):
//   * install is idempotent: a replayed key never installs twice (AT8), a concurrent one is refused;
//   * the body safety question ("Yes" / "Prefer not to say") pauses body coaching at install;
//   * area payloads reach the governed RPC; legacy pillar keys from older clients are mapped;
//   * the draft endpoints validate shape and size; the anonymous merge proves both sessions;
//   * intake_profile_synthesis is NOT production: without a promoted extraction route it is
//     deterministic, and a model proposal is re-validated field by field;
//   * drop-off analytics carry ids and timings only, never answers;
//   * the paywall gets the server's Founding 100 count (or null), never an invented one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let app; let synthesis; let mod;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-intake-worker-'));
  await build({
    entryPoints: { app: join(srcDir, 'index.ts'), synthesis: join(srcDir, 'intakeSynthesis.ts') },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  mod = await import(pathToFileURL(join(outDir, 'app.js')).href);
  app = mod.default;
  synthesis = await import(pathToFileURL(join(outDir, 'synthesis.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const ANON = '00000000-0000-4000-8000-0000000000a9';
const BASE_ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const TOKENS = { 'tok-account-0000000000000000': { id: USER, is_anonymous: false }, 'tok-anon-00000000000000000000': { id: ANON, is_anonymous: true } };
const COACHING_ROUTE = { route_id: 'r1', model_id: 'm', provider_id: 'p', status: 'approved', cost_class: 'low', capabilities: ['conversation', 'reasoning', 'structured_output'], data_classes_allowed: ['private_life'], training_allowed: false, retention: 'zero', approved_for_highly_sensitive: false, quality_score: 100, reliability_score: 100, latency_score: 95, last_policy_reviewed_at: '2026-10-07', last_eval_run_at: null };

function harness({ claim = 'claimed', routes = [COACHING_ROUTE], spotsLeft = 37, weekOne = false, goals = [], planError, permissionError, age = true, health = 'granted', carriedAge = true } = {}) {
  const calls = { rpc: [], analytics: [], deletes: [], openrouter: 0 };
  const consentState = () => ({ ageConfirmedAt: age ? '2026-10-08T00:00:00Z' : null, healthData: health ? { decision: health, recordedAt: '2026-10-08T00:00:00Z', policyVersion: '2026-10-08' } : null });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (href.includes('openrouter')) { calls.openrouter += 1; return json({ error: 'should not be called' }, 500); }
    const path = href.replace(BASE_ENV.SUPABASE_URL, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/auth/v1/user') {
      const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '');
      return TOKENS[token] ? json(TOKENS[token]) : json({ message: 'bad jwt' }, 401);
    }
    if (path.startsWith('/auth/v1/admin/users/') && init.method === 'DELETE') { calls.deletes.push(path.split('/').pop()); return new Response(null, { status: 200 }); }
    const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc) {
      calls.rpc.push({ fn: rpc, args: body });
      if (rpc === 'apm_my_consents') return json(consentState());
      if (rpc === 'apm_service_carry_consents') return json({ ...consentState(), ageConfirmedAt: carriedAge ? '2026-10-08T00:00:00Z' : null });
      if (rpc === 'apm_claim_intake_install') return json(claim);
      if (rpc === 'apm_set_permission') return permissionError ? json({ message: permissionError }, 400) : json({ id: 'p1', domain: body.p_domain, action_type: body.p_action_type, autonomy_level: body.p_autonomy_level, constraints: {}, enabled: body.p_enabled, granted_at: null, updated_at: '2026-10-07T00:00:00Z' });
      if (rpc === 'apm_service_save_goal_plan' && planError) return json({ message: planError }, 400);
      if (rpc === 'apm_save_intake_draft') return json({ ...body.p_draft, status: 'open', installedVersion: null });
      if (rpc === 'apm_get_intake_draft') return json(null);
      if (rpc === 'apm_service_merge_anonymous_draft') return json({ outcome: 'draft' });
      if (rpc === 'apm_service_billing_offering') return json({ offering: 'founding', founding: false, reservedUntil: null });
      if (rpc === 'apm_service_billing_founding_spots_left') return spotsLeft === 'error' ? json({ message: 'down' }, 500) : json(spotsLeft);
      if (rpc === 'apm_flag_body_referral') return json({});
      if (rpc === 'apm_update_intake_profile') return weekOne ? json({ message: 'loop_week_one_lock' }, 400) : json({ updated: true });
      return json(null);
    }
    if (path.startsWith('/rest/v1/analytics_events')) { calls.analytics.push(...body); return new Response(null, { status: 201 }); }
    if (path.startsWith('/rest/v1/model_routes')) return json(routes);
    if (path.startsWith('/rest/v1/goals')) return json(goals);
    if (init.method && init.method !== 'GET') return new Response(null, { status: 204 });
    return json([]);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const request = (path, init = {}, { token = 'tok-account-0000000000000000', env = BASE_ENV } = {}) =>
  app.fetch(new Request(`https://api.test${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }), env);

const INTAKE = {
  roles: ['Losing weight / getting healthy'], primaryGoal: 'Lose 20 lb', values: [], nonNegotiables: [], failurePatterns: [],
  weeklyCadence: { heavyDays: [], lightDays: [] }, coachingStyle: { firmness: 'direct' }, accountability: { dayStart: 'guided' },
  criticalPillars: ['movement'], minimumFloors: { movement: 'Walk 10 minutes' }, activeAreas: ['work', 'movement', 'meditation'],
  pillarsEnabled: ['mind', 'body', 'spirit'], trackKeys: ['operator_discipline', 'body_foundation'],
  intakeProfile: { bankVersion: 2, games: ['weight'], mentalLoadItems: [], fixedCommitments: [], lineIds: [], deadlines: [], realWork: [], fakeWork: [], wealthContext: [], careerLevers: [], mindPractices: ['journaling'], spiritPractices: ['meditation'], faithLanguage: false, coachingHelps: [], coachingAvoid: [], quickStart: true, deferredQuestionIds: ['heavy'], suggestedAreas: [], bodySafety: 'skip', bedRoutine: { gentle: true } },
  idempotencyKey: 'intake-v42',
};

test('install: areas and the profile reach the governed RPC; the key is claimed then finished; display name may be empty', async () => {
  const h = harness();
  try {
    const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INTAKE) });
    assert.equal(response.status, 200);
    const fns = h.calls.rpc.map((c) => c.fn);
    assert.ok(fns.indexOf('apm_claim_intake_install') < fns.indexOf('apm_save_methodology_intake'));
    const payload = h.calls.rpc.find((c) => c.fn === 'apm_save_methodology_intake').args.p_payload;
    assert.deepEqual(payload.active_areas, ['work', 'movement', 'meditation']);
    assert.deepEqual(payload.critical_pillars, ['movement']);
    assert.equal(payload.intake_profile.bodySafety, 'skip');
    assert.equal(payload.display_name, '');
    const finish = h.calls.rpc.find((c) => c.fn === 'apm_finish_intake_install');
    assert.deepEqual(finish.args, { p_key: 'intake-v42', p_ok: true, p_version: 42 });
    assert.ok(fns.includes('apm_flag_body_referral'), 'prefer-not-to-say pauses body pace until a clinician clears it');
    const completed = h.calls.analytics.find((e) => e.event_name === 'onboarding_completed');
    assert.deepEqual(completed.properties, { quickStart: true, games: 'weight' }, 'only Q1 game ids, never answers');
  } finally { h.restore(); }
});

test('install twice (AT8): a replayed key returns the state without installing again; a concurrent tap is refused', async () => {
  for (const [claim, status] of [['replay', 200], ['in_progress', 409]]) {
    const h = harness({ claim });
    try {
      const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INTAKE) });
      assert.equal(response.status, status, claim);
      assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_save_methodology_intake').length, 0, `${claim}: no second install`);
    } finally { h.restore(); }
  }
});

test('older clients: legacy pillar keys are mapped to areas, never refused', async () => {
  const h = harness();
  try {
    const { activeAreas, pillarsEnabled, intakeProfile, idempotencyKey, ...legacy } = INTAKE;
    void activeAreas; void pillarsEnabled; void intakeProfile; void idempotencyKey;
    const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify({ ...legacy, displayName: 'Ana', criticalPillars: ['body', 'execution'], minimumFloors: { body: 'Walk 10 minutes', wealth: 'Move any amount to savings' } }) });
    assert.equal(response.status, 200);
    const payload = h.calls.rpc.find((c) => c.fn === 'apm_save_methodology_intake').args.p_payload;
    assert.deepEqual(payload.critical_pillars, ['movement', 'work']);
    assert.deepEqual(payload.minimum_floors, { movement: 'Walk 10 minutes', money: 'Move any amount to savings' });
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_claim_intake_install').length, 0, 'no key, no claim');
  } finally { h.restore(); }
});

test('the profile never carries free text: unknown fields and catch-all text are refused', async () => {
  const h = harness();
  try {
    const bad = { ...INTAKE, intakeProfile: { ...INTAKE.intakeProfile, catchAll: 'my private worries' } };
    assert.equal((await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(bad) })).status, 400);
    const prose = { ...INTAKE, intakeProfile: { ...INTAKE.intakeProfile, mentalLoadItems: ['my ex keeps texting me'] } };
    assert.equal((await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(prose) })).status, 400);
  } finally { h.restore(); }
});

test('draft: shape and size are checked before the RPC; a valid draft is merged by the server', async () => {
  const h = harness();
  try {
    const draft = { bankVersion: 2, version: 3, answers: { games: ['founder'], load: 8, equity: true }, answeredAt: { games: 1, load: 2, equity: 3 }, cursor: 'season', updatedAt: 3 };
    assert.equal((await request('/v1/intake/draft', { method: 'PUT', body: JSON.stringify(draft) })).status, 200);
    assert.deepEqual(h.calls.rpc.find((c) => c.fn === 'apm_save_intake_draft').args.p_draft, draft);
    assert.equal((await request('/v1/intake/draft', { method: 'PUT', body: JSON.stringify({ ...draft, cursor: '../etc' }) })).status, 400);
    assert.equal((await request('/v1/intake/draft', { method: 'PUT', body: JSON.stringify({ ...draft, answers: { 'Bad Key': 1 } }) })).status, 400);
    assert.equal((await request('/v1/intake/draft', { method: 'PUT', body: JSON.stringify({ ...draft, answers: { catchall: 'x'.repeat(90_000) } }) })).status, 413);
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_save_intake_draft').length, 1);
  } finally { h.restore(); }
});

test('anonymous merge (§5 9c): both sessions are proven; the anonymous user is deleted; nothing else is trusted', async () => {
  const h = harness();
  try {
    const ok = await request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-anon-00000000000000000000' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(h.calls.rpc.find((c) => c.fn === 'apm_service_merge_anonymous_draft').args, { p_from: ANON, p_to: USER });
    assert.deepEqual(h.calls.deletes, [ANON]);
    // A non-anonymous "anonymous" token (someone else's account) is refused.
    const other = await request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-account-0000000000000000' }) });
    assert.equal(other.status, 403);
    const forged = await request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-forged-000000000000000000' }) });
    assert.equal(forged.status, 403);
    // The caller must be the real account, not another anonymous session.
    const fromAnon = await request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-anon-00000000000000000000' }) }, { token: 'tok-anon-00000000000000000000' });
    assert.equal(fromAnon.status, 409);
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_merge_anonymous_draft').length, 1);
    assert.equal(h.calls.deletes.length, 1);
    // Without the service credential the app keeps its local copy and re-saves it.
    const { SUPABASE_SECRET_KEY, ...noSecret } = BASE_ENV;
    void SUPABASE_SECRET_KEY;
    assert.equal((await request('/v1/intake/draft/merge', { method: 'POST', body: JSON.stringify({ anonymousAccessToken: 'tok-anon-00000000000000000000' }) }, { env: noSecret })).status, 503);
  } finally { h.restore(); }
});

test('intake_profile_synthesis is candidate-only: the approved coaching route does not unlock it; deterministic fallback', async () => {
  const h = harness();
  try {
    const response = await request('/v1/intake/synthesis', { method: 'POST', body: JSON.stringify({ catchAll: 'Mom moves in next month. No calls before 9.', games: ['founder'], trackKeys: ['operator_discipline'], floors: { work: 'Send one decisive follow-up' }, suggestedAreas: ['My marriage'] }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.source, 'deterministic');
    assert.equal(result.fallbackReason, 'route_not_promoted');
    assert.deepEqual(result.proposal.suggestedAreas, [{ label: 'My marriage', area: 'family', by: 'keyword' }]);
    assert.equal(h.calls.openrouter, 0, 'no model call without a promoted extraction route');
    const fallback = h.calls.analytics.find((e) => e.event_name === 'os_ai_fallback');
    assert.equal(fallback.properties.reason, 'route_not_promoted');
    assert.ok(!JSON.stringify(h.calls.analytics).includes('Mom'), 'analytics never carry the text');
  } finally { h.restore(); }
});

test('a model proposal is validated field by field: bad Tracks, unsafe floors and fake areas fall back', () => {
  const input = { games: ['operator'], ownership: false, trackKeys: ['operator_discipline'], floors: { work: 'Finish one concrete deliverable step' } };
  const out = synthesis.validateProposal({
    trackKeys: ['billionaire_mindset', 'resilience', 'manifestation_mastery'],
    floors: { work: 'work on it', movement: 'Walk 10 minutes', body: 'Walk', food: 'Take a diet pill' },
    extracted: { boundaries: ['No calls before 9', 'x'], deadlines: ['Launch on 1 Dec'], commitments: [], radarSeeds: ['Call the landlord'] },
    suggestedAreas: [{ label: 'Church', area: 'faith' }, { label: 'Guitar', area: 'hobbies' }],
  }, input);
  assert.deepEqual(out.trackKeys, ['operator_discipline', 'resilience'], 'BHPC Track only for ownership games; unknown Tracks dropped; baseline kept');
  assert.deepEqual(out.floors, { work: 'Finish one concrete deliverable step', movement: 'Walk 10 minutes' }, 'vague, unsafe and non-area floors are refused');
  assert.deepEqual(out.extracted.boundaries, ['No calls before 9']);
  assert.deepEqual(out.suggestedAreas, [{ label: 'Church', area: 'faith', by: 'model' }, { label: 'Guitar', area: 'learning', by: 'keyword' }]);
  assert.deepEqual(synthesis.validateProposal('garbage', input).trackKeys, ['operator_discipline']);
  assert.deepEqual(synthesis.INTAKE_SYNTHESIS_ROUTE_REQUEST.requiredCapabilities.includes('extraction'), true);
  assert.equal(synthesis.SYNTHESIS_TIMEOUT_MS, 8000);
});

test('intake analytics: ids and timings only; answer text is refused', async () => {
  const h = harness();
  try {
    assert.equal((await request('/v1/analytics/event', { method: 'POST', body: JSON.stringify({ eventName: 'intake_question_answered', properties: { qid: 'carry', ms: 2300, changed: false, index: 5, pathLength: 49 } }) })).status, 200);
    assert.equal((await request('/v1/analytics/event', { method: 'POST', body: JSON.stringify({ eventName: 'intake_question_answered', properties: { qid: 'catchall', value: 'my ex' } }) })).status, 400, 'no value key');
    assert.equal((await request('/v1/analytics/event', { method: 'POST', body: JSON.stringify({ eventName: 'intake_question_viewed', properties: { qid: 'I feel overwhelmed' } }) })).status, 400, 'no free text');
    assert.equal((await request('/v1/analytics/event', { method: 'POST', body: JSON.stringify({ eventName: 'onboarding_started', properties: { games: 'founder,parent' } }) })).status, 200);
    assert.equal((await request('/v1/analytics/event', { method: 'POST', body: JSON.stringify({ eventName: 'onboarding_started', properties: { games: 'founder,lose_20_lb' } }) })).status, 400);
    assert.equal(h.calls.analytics.length, 2);
    assert.equal(mod.intakeAnalyticsProblem({ qid: 'games', ms: 10 }), null);
  } finally { h.restore(); }
});

test('the paywall gets the live Founding 100 count from the server, or null; never an invented number', async () => {
  for (const [spots, expected] of [[37, 37], [0, 0], ['error', null]]) {
    const h = harness({ spotsLeft: spots });
    try {
      const body = await (await request('/v1/billing/offering')).json();
      assert.equal(body.spotsLeft, expected);
    } finally { h.restore(); }
  }
  const h = harness();
  try {
    const { SUPABASE_SECRET_KEY, ...noSecret } = BASE_ENV;
    void SUPABASE_SECRET_KEY;
    const body = await (await request('/v1/billing/offering', {}, { env: noSecret })).json();
    assert.equal(body.spotsLeft, null);
  } finally { h.restore(); }
});

test('later answers: the body safety answer pauses body pace at once; the rest waits for Day 8', async () => {
  const profile = { ...INTAKE.intakeProfile, bodySafety: 'yes' };
  const h = harness({ weekOne: true });
  try {
    const response = await request('/v1/intake/profile', { method: 'PUT', body: JSON.stringify({ intakeProfile: profile }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).held, 'week_one');
    const fns = h.calls.rpc.map((c) => c.fn);
    assert.ok(fns.indexOf('apm_flag_body_referral') < fns.indexOf('apm_update_intake_profile'), 'safety first, whatever the day');
  } finally { h.restore(); }
  const after = harness();
  try {
    const response = await request('/v1/intake/profile', { method: 'PUT', body: JSON.stringify({ intakeProfile: { ...INTAKE.intakeProfile, bodySafety: 'none' } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).held, undefined);
    assert.equal(after.calls.rpc.filter((c) => c.fn === 'apm_flag_body_referral').length, 0);
    assert.equal((await request('/v1/intake/profile', { method: 'PUT', body: JSON.stringify({ intakeProfile: { ...INTAKE.intakeProfile, catchAll: 'x' } }) })).status, 400);
  } finally { after.restore(); }
});

test('install without access yet (0044: no plan bought, not on the beta list): the OS installs; the plan waits for the Today backfill', async () => {
  const goal = { id: '00000000-0000-4000-8000-0000000000c1', title: 'Lose 20 lb', outcome: null, status: 'active', health: 'unknown', pillar: 'movement', target_date: null, priority: 1, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-10-07T00:00:00Z' };
  const h = harness({ goals: [goal], planError: 'loop_entitlement_required' });
  try {
    const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INTAKE) });
    assert.equal(response.status, 200);
    assert.ok(h.calls.rpc.some((c) => c.fn === 'apm_service_save_goal_plan'), 'the plan was attempted');
    assert.deepEqual(h.calls.rpc.find((c) => c.fn === 'apm_finish_intake_install').args.p_ok, true);
  } finally { h.restore(); }
  const broken = harness({ goals: [goal], planError: 'loop_invalid_plan' });
  try {
    const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify(INTAKE) });
    assert.notEqual(response.status, 200, 'any other plan failure still fails the install');
    assert.deepEqual(broken.calls.rpc.find((c) => c.fn === 'apm_finish_intake_install').args.p_ok, false);
  } finally { broken.restore(); }
});

test('permissions go through the governed RPC (0064); a database ceiling refusal is a 403, never a direct table write', async () => {
  const h = harness();
  try {
    const response = await request('/v1/permissions/calendar/create_event', { method: 'PUT', body: JSON.stringify({ autonomyLevel: 0, enabled: false }) });
    assert.equal(response.status, 200);
    assert.deepEqual(h.calls.rpc.find((c) => c.fn === 'apm_set_permission').args, { p_domain: 'calendar', p_action_type: 'create_event', p_autonomy_level: 0, p_constraints: {}, p_enabled: false });
  } finally { h.restore(); }
  const refused = harness({ permissionError: 'permission_above_plan_ceiling' });
  try {
    assert.equal((await request('/v1/permissions/calendar/create_event', { method: 'PUT', body: JSON.stringify({ autonomyLevel: 0 }) })).status, 403);
  } finally { refused.restore(); }
});
