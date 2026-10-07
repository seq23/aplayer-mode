// Worker-side contract for the BHPC daily loop (services/api/src/dailyLoop.ts + routes):
//   * Today never runs dry: an installed user's active goal without a plan gets one
//     (governed RPC, source `backfill`) and Today prints its foreground action;
//   * the intake and the Goals tab create plans through the governed RPCs;
//   * check-in runs the Mood Gate for the user's LOCAL day and locks the agenda;
//   * mid-day negotiation is refused before any write; RPC errors map to HTTP;
//   * the data-rights export carries plans, completions and day records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir; let app; let planning;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-loop-worker-'));
  await build({
    entryPoints: { app: join(srcDir, 'index.ts'), planning: fileURLToPath(new URL('../../../packages/planning/src/index.ts', import.meta.url)) },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  app = (await import(pathToFileURL(join(outDir, 'app.js')).href)).default;
  planning = await import(pathToFileURL(join(outDir, 'planning.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const GOAL = '00000000-0000-4000-8000-0000000000g1'.replace('g', 'a');
const PLAN_ID = '00000000-0000-4000-8000-0000000000p1'.replace('p', 'b');
const TZ = 'Pacific/Auckland';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', AUTH_DEV_BYPASS_USER_ID: USER };
const localToday = () => planning.calendarDateInTimezone(new Date(), TZ);

function personalOsRow() {
  return {
    user_id: USER, north_star: null, core_values: [], non_negotiables: [], failure_patterns: [], body_context: null,
    work_money_context: null, mind_spirit_learning_context: null, weekly_cadence: { heavyDays: [], lightDays: [] },
    coaching_style: { firmness: 'direct' }, accountability: { dayStart: 'guided' }, active_mode: 'standard', foreground_goal_id: GOAL,
    morning_sequence: ['Drink water'], scheduling_preference: 'ordered_stack', hard_boundaries: [], scoring_config: { enabled: true, showSevenDaySnapshot: true },
    stabilization_started_at: '2026-09-01', installed_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    mode_started_at: null, mode_ends_at: null, mode_focus: null, recovery_locked_until: null, mode_resume: null,
  };
}

function harness({ installed = true, rpcErrors = {}, tracks = [], os = {} } = {}) {
  const store = {
    user_profiles: [{ user_id: USER, display_name: 'Ana', timezone: TZ, current_season: null, becoming: null }],
    goals: [{ id: GOAL, title: 'lose 30 lbs', outcome: null, status: 'active', health: 'unknown', pillar: 'body', target_date: null, priority: 1, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z' }],
    personal_os: installed ? [{ ...personalOsRow(), ...os }] : [],
    tracks: tracks.map((key) => ({ id: `t-${key}`, user_id: USER, key, name: key, active: true, foreground: false, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z' })),
    subscription_entitlements: [{ user_id: USER, plan: 'beta', status: 'active', provider: null, current_period_end: null }],
    goal_plans: [],
    plan_action_completions: [],
    day_records: [],
  };
  const calls = { rpc: [], audits: [], writes: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(env.SUPABASE_URL, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const rpc = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc) {
      calls.rpc.push({ fn: rpc, args: body });
      if (rpcErrors[rpc]) return json({ message: rpcErrors[rpc] }, 400);
      if (store.rpcErrorOnce?.[rpc]) { const message = store.rpcErrorOnce[rpc]; delete store.rpcErrorOnce[rpc]; return json({ message }, 400); }
      if (rpc === 'apm_service_save_goal_plan' || rpc === 'apm_service_create_goal') {
        const plan = body.p_plan;
        const goalId = rpc === 'apm_service_save_goal_plan' ? body.p_goal_id : '00000000-0000-4000-8000-0000000000a2';
        if (rpc === 'apm_service_create_goal') store.goals.push({ ...store.goals[0], id: goalId, title: body.p_goal.title, priority: 2 });
        const row = { id: rpc === 'apm_service_save_goal_plan' ? PLAN_ID : '00000000-0000-4000-8000-0000000000b2', user_id: USER, goal_id: goalId, plan_key: plan.id, template_key: plan.provenance.templateKey, persona: plan.persona.key, foreground_pillar: plan.foreground.pillar, start_date: plan.startDate, end_date: plan.endDate, timezone: plan.timezone ?? null, plan, status: 'active', decision: null, decision_reason: null, decided_at: null, gate_reviews: {}, created_at: new Date().toISOString() };
        store.goal_plans = store.goal_plans.filter((existing) => existing.goal_id !== goalId).concat(row);
        return json(rpc === 'apm_service_create_goal' ? { goal: { id: goalId }, plan: row } : row);
      }
      if (rpc === 'apm_service_day_check_in') {
        calls.serviceAuth = new Headers(init.headers).get('apikey');
        const row = { id: 'd1', day: body.p_day, mode: 'standard', verdict: null, completed_action_ids: [], note: null, closed_at: null, mood: body.p_mood, day_state: body.p_state, agenda: body.p_agenda, agenda_status: 'locked', checked_in_at: new Date().toISOString(), replans: [] };
        store.day_records = [row];
        return json({ day: row, replayed: false });
      }
      if (rpc === 'apm_flag_body_referral') { store.personal_os[0].body_referral_at = new Date().toISOString(); store.personal_os[0].body_referral_source = body.p_source; return json({ bodyReferralAt: store.personal_os[0].body_referral_at }); }
      if (rpc === 'apm_record_clinician_clearance') { store.personal_os[0].body_referral_at = null; store.personal_os[0].clinician_cleared_at = new Date().toISOString(); return json({}); }
      if (rpc === 'apm_log_diary') return json({ entry: { id: 'e1' }, reply: 'Logged.' });
      if (rpc === 'apm_draft_os_change') return json({ id: 'chg1', field: body.p_field, status: 'draft' });
      if (rpc === 'apm_apply_os_change') return json(store.applyResult ?? { id: body.p_id, field: 'day_start', status: 'applied', effective_from: '2099-01-01' });
      if (rpc === 'apm_service_pending_pillar_rebuilds') return json({ changes: store.pendingPillar ?? [], effective: store.effectivePillars ?? {} });
      if (rpc === 'apm_service_day_body_replan') { store.day_records[0] = { ...store.day_records[0], agenda: body.p_agenda }; return json(store.day_records[0]); }
      if (rpc === 'apm_service_mark_pillar_rebuilt') { store.pendingPillar = (store.pendingPillar ?? []).filter((change) => change.id !== body.p_id); return json(true); }
      if (rpc === 'apm_service_day_replan') { store.day_records[0] = { ...store.day_records[0], agenda: body.p_agenda }; return json(store.day_records[0]); }
      if (rpc === 'apm_service_day_reprint') { store.day_records[0] = { ...store.day_records[0], agenda: body.p_agenda, reprint_count: 1 }; return json(store.day_records[0]); }
      if (rpc === 'apm_daily_loop_data_rights_export') return json({ goalPlans: store.goal_plans, planActionCompletions: [], dayRecords: store.day_records });
      if (rpc === 'apm_life_os_data_rights_export') return json({ lifeRelationships: [], lifeAdminItems: [] });
      if (rpc === 'apm_autopilot_data_rights_export') return json({ rules: [], executions: [], masterPaused: false });
      return json(null);
    }
    if (path.startsWith('/rest/v1/audit_events') && method === 'POST') { calls.audits.push(...body); return new Response(null, { status: 201 }); }
    if (method !== 'GET') calls.writes.push({ path, method, body });
    if (method !== 'GET') return method === 'POST' && path.startsWith('/rest/v1/data_rights_jobs') ? json([{ id: 'job1', status: 'requested' }]) : new Response(null, { status: 204 });
    const table = path.match(/^\/rest\/v1\/([a-z_]+)/)?.[1];
    return json(store[table] ?? []);
  };
  return { store, calls, restore: () => { globalThis.fetch = original; } };
}

const request = (path, init = {}) => app.fetch(new Request(`https://api.test${path}`, { ...init, headers: { 'content-type': 'application/json' } }), env);

test('Today never runs dry: a planless active goal is planned once (backfill) and Today prints its foreground action', async () => {
  const h = harness();
  try {
    const response = await request('/v1/me/today');
    assert.equal(response.status, 200);
    const body = await response.json();
    const saves = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].args.p_source, 'backfill');
    assert.equal(saves[0].args.p_goal_id, GOAL);
    assert.deepEqual(planning.validatePlan(saves[0].args.p_plan), []);
    assert.equal(saves[0].args.p_plan.startDate, localToday(), 'the plan starts on the user’s LOCAL today');
    assert.equal(body.today.date, localToday());
    assert.equal(body.today.locked, false);
    assert.equal(body.today.agenda.foregroundPriority.goalId, GOAL);
    assert.ok(body.today.agenda.firstHour.priority.title);
    assert.deepEqual(body.today.agenda.firstHour.sequence, ['Drink water']);

    await request('/v1/me/today');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').length, 1, 'planned once, not on every read');
  } finally { h.restore(); }
});

test('no Personal OS, no backfill: planning starts at the intake', async () => {
  const h = harness({ installed: false });
  try {
    await request('/v1/me/today');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').length, 0);
  } finally { h.restore(); }
});

test('the intake creates the primary goal’s plan through the governed RPC', async () => {
  const h = harness();
  try {
    const response = await request('/v1/methodology/intake', { method: 'PUT', body: JSON.stringify({
      displayName: 'Ana', roles: ['Health / rebuilding'], primaryGoal: 'lose 30 lbs', values: [], nonNegotiables: [], failurePatterns: [],
      weeklyCadence: { heavyDays: [], lightDays: [] }, coachingStyle: { firmness: 'direct' }, accountability: { dayStart: 'hard' },
      criticalPillars: ['body'], minimumFloors: { body: 'Walk 10 minutes' }, trackKeys: ['body_foundation'],
    }) });
    assert.equal(response.status, 200);
    const intake = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan');
    assert.equal(intake[0].args.p_source, 'intake');
    assert.equal(intake[0].args.p_plan.persona.key, 'weight_loss');
    assert.equal(intake[0].args.p_plan.minimumFloors, undefined);
    assert.equal(intake[0].args.p_plan.actions.movement_floor.mvd.title, 'Walk 10 minutes', 'the user’s own body floor drives the MVD');
  } finally { h.restore(); }
});

test('check-in runs the Mood Gate for the local day: mood 2 locks a Minimum Viable Day agenda', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    const response = await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 2 }) });
    assert.equal(response.status, 200);
    const checkIn = h.calls.rpc.find((c) => c.fn === 'apm_service_day_check_in');
    assert.equal(checkIn.args.p_user_id, USER);
    assert.equal(h.calls.serviceAuth, 'sb_secret_test', 'the agenda is written with the server-only key, not the user JWT');
    assert.equal(checkIn.args.p_day, localToday());
    assert.equal(checkIn.args.p_mood, 2);
    assert.equal(checkIn.args.p_agenda.mode, 'recovery');
    assert.ok(checkIn.args.p_agenda.reasons.includes('low_mood_mvd'));
    assert.equal(checkIn.args.p_agenda.firstHour.priority.scope, 'mvd');
    const body = await response.json();
    assert.equal(body.today.locked, true);
    assert.equal(body.today.checkedIn, true);

    const again = await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 9 }) });
    assert.equal((await again.json()).replayed, true);
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_day_check_in').length, 1, 'the mood is not renegotiated');
  } finally { h.restore(); }
});

test('No Mid-Day Negotiation: a mood replan is refused before any write and audited', async () => {
  const h = harness();
  try {
    const response = await request('/v1/today/replan', { method: 'POST', body: JSON.stringify({ reason: 'mood' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'no_midday_negotiation');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_day_replan').length, 0);
    assert.equal(h.calls.audits.at(-1).event_type, 'day.replan_refused');
  } finally { h.restore(); }
});

test('the opening step and agenda membership come back as 409s from the database', async () => {
  for (const [code, error] of [['loop_opening_step_required', 'opening_step_required'], ['loop_not_on_agenda', 'not_on_agenda'], ['loop_day_closed', 'day_closed']]) {
    const h = harness({ rpcErrors: { apm_complete_plan_action: code } });
    try {
      const response = await request('/v1/today/actions/complete', { method: 'POST', body: JSON.stringify({ planId: PLAN_ID, actionKey: 'movement_floor' }) });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, error);
    } finally { h.restore(); }
  }
});

test('the four LOCKED pillars: family is refused as a life pillar at the API', async () => {
  const h = harness();
  try {
    const goal = await request('/v1/goals', { method: 'POST', body: JSON.stringify({ title: 'Be home for dinner', pillar: 'family' }) });
    assert.equal(goal.status, 400);
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_create_goal').length, 0);
  } finally { h.restore(); }
});

test('the legacy next-action completion maps the opening step to a 409', async () => {
  const h = harness({ rpcErrors: { apm_complete_next_action: 'loop_opening_step_required' } });
  try {
    const response = await request('/v1/next-actions/00000000-0000-4000-8000-0000000000c1/complete', { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'opening_step_required');
  } finally { h.restore(); }
});

test('Goals: a new goal is planned, created through the governed RPC and run through arbitration; Week 1 is a 409', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    const response = await request('/v1/goals', { method: 'POST', body: JSON.stringify({ title: 'Build a 3-month emergency fund', pillar: 'wealth' }) });
    assert.equal(response.status, 201);
    const created = h.calls.rpc.find((c) => c.fn === 'apm_service_create_goal');
    assert.equal(created.args.p_plan.persona.key, 'wealth_building');
    const body = await response.json();
    assert.equal(body.arbitration.ranked.length, 2);
    assert.ok(body.recommendedForegroundGoalId);
    assert.equal(body.today.agenda.foregroundPriority.goalId, GOAL, 'the declared foreground keeps the day until the user moves it');
  } finally { h.restore(); }
  const locked = harness({ rpcErrors: { apm_service_create_goal: 'loop_week_one_lock' } });
  try {
    const response = await request('/v1/goals', { method: 'POST', body: JSON.stringify({ title: 'Run a 10k' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'week_one_lock');
  } finally { locked.restore(); }
});

test('the data-rights export includes plans, completions and day records', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    const response = await request('/v1/privacy/export', { method: 'POST' });
    const body = await response.json();
    assert.equal(body.export.dailyLoop.goalPlans.length, 1);
    assert.ok(Array.isArray(body.export.dailyLoop.planActionCompletions));
    assert.ok(Array.isArray(body.export.dailyLoop.dayRecords));
  } finally { h.restore(); }
});

test('without the server-only key the check-in is a named 503, never a silent success', async () => {
  const h = harness();
  try {
    const response = await app.fetch(new Request('https://api.test/v1/today/check-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mood: 6 }) }), { ...env, SUPABASE_SECRET_KEY: undefined });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'service_unavailable');
    assert.equal(h.calls.rpc.filter((c) => c.fn.includes('check_in')).length, 0);
  } finally { h.restore(); }
});

test('end-of-day close: pillar review → computed verdict, user authority kept, one carry item, no catch-up', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    const refused = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'miss' }], carryForward: 'Double session tomorrow to make up for it' }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, 'invalid_carry_forward');
    const vague = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'miss' }], carryForward: 'Work on fitness' }) });
    assert.equal(vague.status, 400, 'Ambiguity Stop applies to the carry item');
    const duplicate = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'hit' }, { pillar: 'body', score: 'miss' }] }) });
    assert.equal(duplicate.status, 400);
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_close_day_review').length, 0);

    const noCheckIn = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'hit' }], verdict: 'full_day' }) });
    assert.equal(noCheckIn.status, 409, 'evidence before verdict');
    await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'hit' }] }) });
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_close_day_review').at(-1).args.p_verdict, 'miss', 'no check-in closes as a Miss');
    const checkedIn = await (await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) })).json();
    const noEvidence = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'hit' }], verdict: 'full_day' }) });
    assert.equal(noEvidence.status, 409, 'a win needs completion evidence');
    assert.equal((await noEvidence.json()).error, 'verdict_needs_evidence');
    const priority = checkedIn.today.agenda.firstHour.priority;
    h.store.plan_action_completions.push({ id: 'c1', user_id: USER, plan_id: priority.planId, day: localToday(), action_key: priority.actionKey, instance_id: 'i', scope: 'standard', role: 'foreground', note: null, created_at: new Date().toISOString() });

    const response = await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'hit', completed: 'Walked 15 minutes' }], note: 'Felt good', carryForward: 'Book the gym induction for Thursday' }) });
    assert.equal(response.status, 200);
    const close = h.calls.rpc.filter((c) => c.fn === 'apm_close_day_review').at(-1);
    assert.equal(close.args.p_verdict, 'full_day');
    assert.equal(close.args.p_computed_verdict, 'full_day');
    assert.equal(close.args.p_carry_forward, 'Book the gym induction for Thursday');
    assert.ok(close.args.p_insight.length > 10);
    const body = await response.json();
    assert.equal(body.continuity.length, 7);
    assert.equal(body.continuity[6].symbol, '✅');

    await request('/v1/today/close', { method: 'POST', body: JSON.stringify({ pillarReview: [{ pillar: 'body', score: 'miss' }], verdict: 'mvd' }) });
    const override = h.calls.rpc.filter((c) => c.fn === 'apm_close_day_review').at(-1);
    assert.deepEqual([override.args.p_verdict, override.args.p_computed_verdict], ['mvd', 'miss'], 'the user decides; the computed verdict is kept beside it');
  } finally { h.restore(); }
});


const STARTED = '2026-09-20';
/** The backfilled plan is moved to an earlier start, as a plan already running would be. */
function backdate(store) {
  for (const row of store.goal_plans) { row.start_date = STARTED; row.plan = { ...row.plan, startDate: STARTED, endDate: new Date(Date.parse(`${STARTED}T00:00:00Z`) + 89 * 86_400_000).toISOString().slice(0, 10) }; }
}

test('Diary: "Logged." with no coaching; a red flag pauses body coaching and rebuilds the body plan with the referral stop', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    backdate(h.store);
    const quiet = await (await request('/v1/diary', { method: 'POST', body: JSON.stringify({ kind: 'diary', body: 'Good walk today' }) })).json();
    assert.equal(quiet.reply, 'Logged.');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_flag_body_referral').length, 0);
    const flagged = await (await request('/v1/diary', { method: 'POST', body: JSON.stringify({ kind: 'slip', body: 'I fainted at the gym this morning' }) })).json();
    assert.equal(flagged.reply, 'Logged.');
    assert.equal(h.calls.rpc.find((c) => c.fn === 'apm_flag_body_referral').args.p_source, 'diary');
    const rebuilt = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').at(-1);
    assert.equal(rebuilt.args.p_source, 'referral');
    assert.equal(rebuilt.args.p_plan.safety.referral, true);
    // The rebuild keeps the live plan's 90 days (0035): same start, same end.
    assert.equal(rebuilt.args.p_plan.startDate, STARTED, 'a referral never restarts the 90 days');
    assert.equal(rebuilt.args.p_plan.endDate, new Date(Date.parse(`${STARTED}T00:00:00Z`) + 89 * 86_400_000).toISOString().slice(0, 10));
    assert.equal(flagged.today.bodyReferral.source, 'diary');

    assert.equal((await request('/v1/body/clearance', { method: 'POST', body: JSON.stringify({}) })).status, 400, 'clearance is an explicit confirmation');
    await request('/v1/body/clearance', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const cleared = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').at(-1);
    assert.equal(cleared.args.p_source, 'clearance');
    assert.equal(cleared.args.p_plan.safety.referral, false);
    assert.equal(cleared.args.p_plan.startDate, STARTED, 'clearance never restarts the 90 days either');
  } finally { h.restore(); }
});

test('the Drafting Room validates before drafting and applies explicitly', async () => {
  const h = harness();
  try {
    assert.equal((await request('/v1/os/changes', { method: 'POST', body: JSON.stringify({ field: 'pillar', value: { name: 'family', critical: true } }) })).status, 400);
    assert.equal((await request('/v1/os/changes', { method: 'POST', body: JSON.stringify({ field: 'track_settings', value: { salary: 1 } }) })).status, 400);
    const drafted = await request('/v1/os/changes', { method: 'POST', body: JSON.stringify({ field: 'day_start', value: 'hard', reason: 'Mornings drift' }) });
    assert.equal(drafted.status, 201);
    assert.deepEqual(h.calls.rpc.find((c) => c.fn === 'apm_draft_os_change').args, { p_field: 'day_start', p_value: 'hard', p_reason: 'Mornings drift' });
    const applied = await (await request('/v1/os/changes/chg1/apply', { method: 'POST' })).json();
    assert.match(applied.message, /today's locked agenda is not rewritten/);
  } finally { h.restore(); }
});

test('Hard Start: the server serves nothing but the opening step before the check-in', async () => {
  const h = harness({ os: { accountability: { dayStart: 'hard' } } });
  try {
    const body = await (await request('/v1/me/today')).json();
    assert.equal(body.today.redacted, true);
    assert.equal(body.today.agenda.firstHour.priority, undefined);
    assert.deepEqual(body.today.agenda.dailyStack, []);
    assert.ok(body.today.agenda.foregroundPriority.label, 'the foreground is named, nothing else');
  } finally { h.restore(); }
});

test('REPRINT needs a locked agenda and rewrites only the flagged item through the service path', async () => {
  const h = harness();
  try {
    assert.equal((await request('/v1/today/reprint', { method: 'POST', body: JSON.stringify({}) })).status, 409);
    const checkedIn = await (await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) })).json();
    assert.equal((await request('/v1/today/reprint', { method: 'POST', body: JSON.stringify({}) })).status, 409, 'a valid agenda has nothing to reprint');
    const priority = checkedIn.today.agenda.firstHour.priority;
    const response = await (await request('/v1/today/reprint', { method: 'POST', body: JSON.stringify({ itemIds: [priority.id] }) })).json();
    const call = h.calls.rpc.find((c) => c.fn === 'apm_service_day_reprint');
    assert.equal(call.args.p_user_id, USER);
    assert.notEqual(call.args.p_agenda.firstHour.priority.actionKey, priority.actionKey);
    assert.equal(call.args.p_agenda.mode, checkedIn.today.agenda.mode);
    assert.equal(response.replaced.length, 1);
  } finally { h.restore(); }
});

test('Operator Discipline requires a declared reason to replan; Strategic Patience gates new projects', async () => {
  const h = harness({ tracks: ['operator_discipline', 'strategic_patience'] });
  try {
    await request('/v1/me/today');
    await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) });
    const undeclared = await request('/v1/today/replan', { method: 'POST', body: JSON.stringify({ reason: 'external_change' }) });
    assert.equal(undeclared.status, 409);
    assert.equal((await undeclared.json()).error, 'declare_the_change');
    const declared = await request('/v1/today/replan', { method: 'POST', body: JSON.stringify({ reason: 'external_change', detail: 'Client moved the meeting to 9am' }) });
    assert.equal(declared.status, 200);
    const pivot = await request('/v1/goals', { method: 'POST', body: JSON.stringify({ title: 'Run a 10k' }) });
    assert.equal(pivot.status, 409);
    assert.equal((await pivot.json()).reasonCode, 'patience.premature_pivot');
    assert.equal((await request('/v1/goals', { method: 'POST', body: JSON.stringify({ title: 'Run a 10k', confirmPivot: true }) })).status, 201);
  } finally { h.restore(); }
});

test('weekly debrief: Execution Score, Foreground Focus, Friction and one adjustment, recorded through the RPC', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    const preview = await (await request('/v1/reviews/weekly')).json();
    assert.equal(preview.debrief.executionScore.of, 7);
    assert.equal(preview.debrief.diaryQuestion, 'Did you log any major breakthroughs in your Diary to review now?');
    await request('/v1/reviews/weekly', { method: 'POST', body: JSON.stringify({ adjustment: 'Walk before work on Mondays' }) });
    const saved = h.calls.rpc.find((c) => c.fn === 'apm_save_weekly_review');
    assert.equal(saved.args.p_week_start, preview.debrief.weekStart);
    assert.equal(saved.args.p_adjustment, 'Walk before work on Mondays');
  } finally { h.restore(); }
});

test('a Drafting Room pillar-floor change reaches its plans on the effective date, once, keeping their 90 days', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    backdate(h.store);
    const saves = () => h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan');
    const before = saves().length;
    h.store.pillar_settings = [{ name: 'body', active: true, critical: true, minimum_floor: 'Walk 15 minutes after lunch' }];
    h.store.applyResult = { id: 'chg2', field: 'pillar', status: 'applied', effective_from: '2099-01-01', proposed: { name: 'body', critical: true, minimumFloor: 'Walk 15 minutes after lunch' } };
    assert.equal((await request('/v1/os/changes/chg2/apply', { method: 'POST' })).status, 200);
    assert.equal(saves().length, before, 'applying never rewrites today: nothing rebuilds before the effective date');

    // The effective date arrives: the next read rebuilds the affected plan in place, once.
    h.store.pendingPillar = [{ id: 'chg2', pillar: 'body' }];
    h.store.rpcErrorOnce = { apm_service_save_goal_plan: 'loop_service_unavailable' };
    await request('/v1/me/today');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_mark_pillar_rebuilt').length, 0, 'a failed rebuild stays pending');
    await request('/v1/me/today');
    const rebuilt = saves().slice(before).filter((c) => c.args.p_source === 'os_change');
    assert.equal(rebuilt.length, 2, 'the failed attempt, then the retry on the next read');
    assert.equal(rebuilt.at(-1).args.p_plan.startDate, STARTED, 'its 90 days continue');
    assert.match(JSON.stringify(rebuilt.at(-1).args.p_plan.actions), /Walk 15 minutes after lunch/, 'the new floor is in the plan');
    assert.deepEqual(h.calls.rpc.filter((c) => c.fn === 'apm_service_mark_pillar_rebuilt').map((c) => c.args), [{ p_user_id: USER, p_id: 'chg2' }]);
    await request('/v1/me/today');
    assert.equal(saves().slice(before).filter((c) => c.args.p_source === 'os_change').length, 2, 'marked: never rebuilt again');
  } finally { h.restore(); }
});

test('a body red flag after check-in replans the rest of today as a declared safety change; clearance as a permission change', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    assert.equal((await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) })).status < 300, true);
    await request('/v1/diary', { method: 'POST', body: JSON.stringify({ kind: 'slip', body: 'I fainted at the gym this morning' }) });
    const safety = h.calls.rpc.filter((c) => c.fn === 'apm_service_day_body_replan').at(-1);
    assert.equal(safety.args.p_source, 'referral');
    assert.equal(safety.args.p_agenda.state, 'recovery');
    assert.equal(safety.args.p_agenda.safety.referral, true, 'the locked agenda now carries the referral stop');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_day_replan').length, 0, 'never through the capped declared-replan path');
    await request('/v1/body/clearance', { method: 'POST', body: JSON.stringify({ confirm: true }) });
    const permission = h.calls.rpc.filter((c) => c.fn === 'apm_service_day_body_replan').at(-1);
    assert.equal(permission.args.p_source, 'clearance');
    assert.equal(permission.args.p_agenda.safety.referral, false);
  } finally { h.restore(); }
});

test('a decided plan still in execution (promote/maintain) gets the pillar rebuild; a parked one does not', async () => {
  for (const [decision, expected] of [['maintain', 1], ['park', 0]]) {
    const h = harness();
    try {
      await request('/v1/me/today');
      backdate(h.store);
      for (const row of h.store.goal_plans) Object.assign(row, { status: 'decided', decision, decision_reason: 'Day 90', decided_at: '2026-10-01T00:00:00Z' });
      const before = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').length;
      h.store.pendingPillar = [{ id: 'chg9', pillar: 'body' }];
      await request('/v1/me/today');
      assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan' && c.args.p_source === 'os_change').length - 0, expected, decision);
      assert.ok(h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan').length >= before);
    } finally { h.restore(); }
  }
});

test('rebuilds use the pillar state in effect today, and a check-in waits while a due rebuild is pending', async () => {
  const h = harness();
  try {
    await request('/v1/me/today');
    backdate(h.store);
    // The body change is due; a LATER body change (effective tomorrow) is already in pillar_settings.
    h.store.pillar_settings = [{ name: 'body', active: true, critical: true, minimum_floor: 'Walk 25 minutes from tomorrow' }];
    h.store.effectivePillars = { body: { name: 'body', active: true, critical: true, minimum_floor: 'Walk 15 minutes after lunch' } };
    h.store.pendingPillar = [{ id: 'chg4', pillar: 'body' }];
    await request('/v1/me/today');
    const rebuilt = h.calls.rpc.filter((c) => c.fn === 'apm_service_save_goal_plan' && c.args.p_source === 'os_change').at(-1);
    const actions = JSON.stringify(rebuilt.args.p_plan.actions);
    assert.match(actions, /Walk 15 minutes after lunch/, 'today’s floor');
    assert.doesNotMatch(actions, /Walk 25 minutes from tomorrow/, 'never tomorrow’s');

    h.store.pendingPillar = [{ id: 'chg5', pillar: 'body' }];
    h.store.rpcErrorOnce = { apm_service_save_goal_plan: 'loop_service_unavailable' };
    const blocked = await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) });
    assert.equal(blocked.status, 503, 'no agenda is locked from a plan still missing an in-effect change');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_service_day_check_in').length, 0);
    const ok = await request('/v1/today/check-in', { method: 'POST', body: JSON.stringify({ mood: 7 }) });
    assert.ok(ok.status < 300, 'once the retry lands, the check-in proceeds');
  } finally { h.restore(); }
});
