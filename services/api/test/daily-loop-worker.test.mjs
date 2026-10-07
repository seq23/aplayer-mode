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

function harness({ installed = true, rpcErrors = {} } = {}) {
  const store = {
    user_profiles: [{ user_id: USER, display_name: 'Ana', timezone: TZ, current_season: null, becoming: null }],
    goals: [{ id: GOAL, title: 'lose 30 lbs', outcome: null, status: 'active', health: 'unknown', pillar: 'body', target_date: null, priority: 1, provenance_kind: 'stated', source_type: 'manual', source_ref: null, confidence: 1, created_at: '2026-09-01T00:00:00Z' }],
    personal_os: installed ? [personalOsRow()] : [],
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
      if (rpc === 'apm_save_goal_plan' || rpc === 'apm_create_goal') {
        const plan = rpc === 'apm_save_goal_plan' ? body.p_plan : body.p_plan;
        const goalId = rpc === 'apm_save_goal_plan' ? body.p_goal_id : '00000000-0000-4000-8000-0000000000a2';
        if (rpc === 'apm_create_goal') store.goals.push({ ...store.goals[0], id: goalId, title: body.p_goal.title, priority: 2 });
        const row = { id: rpc === 'apm_save_goal_plan' ? PLAN_ID : '00000000-0000-4000-8000-0000000000b2', user_id: USER, goal_id: goalId, plan_key: plan.id, template_key: plan.provenance.templateKey, persona: plan.persona.key, foreground_pillar: plan.foreground.pillar, start_date: plan.startDate, end_date: plan.endDate, timezone: plan.timezone ?? null, plan, status: 'active', decision: null, decision_reason: null, decided_at: null, gate_reviews: {}, created_at: new Date().toISOString() };
        store.goal_plans = store.goal_plans.filter((existing) => existing.goal_id !== goalId).concat(row);
        return json(rpc === 'apm_create_goal' ? { goal: { id: goalId }, plan: row } : row);
      }
      if (rpc === 'apm_service_day_check_in') {
        calls.serviceAuth = new Headers(init.headers).get('apikey');
        const row = { id: 'd1', day: body.p_day, mode: 'standard', verdict: null, completed_action_ids: [], note: null, closed_at: null, mood: body.p_mood, day_state: body.p_state, agenda: body.p_agenda, agenda_status: 'locked', checked_in_at: new Date().toISOString(), replans: [] };
        store.day_records = [row];
        return json({ day: row, replayed: false });
      }
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
    const saves = h.calls.rpc.filter((c) => c.fn === 'apm_save_goal_plan');
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
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_save_goal_plan').length, 1, 'planned once, not on every read');
  } finally { h.restore(); }
});

test('no Personal OS, no backfill: planning starts at the intake', async () => {
  const h = harness({ installed: false });
  try {
    await request('/v1/me/today');
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_save_goal_plan').length, 0);
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
    const intake = h.calls.rpc.filter((c) => c.fn === 'apm_save_goal_plan');
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
    assert.equal(h.calls.rpc.filter((c) => c.fn === 'apm_create_goal').length, 0);
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
    const created = h.calls.rpc.find((c) => c.fn === 'apm_create_goal');
    assert.equal(created.args.p_plan.persona.key, 'wealth_building');
    const body = await response.json();
    assert.equal(body.arbitration.ranked.length, 2);
    assert.ok(body.recommendedForegroundGoalId);
    assert.equal(body.today.agenda.foregroundPriority.goalId, GOAL, 'the declared foreground keeps the day until the user moves it');
  } finally { h.restore(); }
  const locked = harness({ rpcErrors: { apm_create_goal: 'loop_week_one_lock' } });
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
