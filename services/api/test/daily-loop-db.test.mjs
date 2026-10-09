// Executes the REAL migration chain in PGlite and proves the 0021 daily-loop
// contract as the `authenticated` role:
//   * goal_plans / plan_action_completions / day_records cannot be written directly;
//   * plans are saved only through the governed RPC (shape-checked, audited, one live
//     plan per goal), reads need ownership AND entitlement, export does not;
//   * the opening step (check-in) gates execution, only agenda items can be completed,
//     completion is idempotent and leaves evidence;
//   * the day is the user's LOCAL today, the mood is recorded once, mid-day
//     negotiation is refused in the database too;
//   * Week 1 blocks new projects; gates and the day-90 decision only open on time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const planningEntry = fileURLToPath(new URL('../../../packages/planning/src/index.ts', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const GOAL_A = '00000000-0000-4000-8000-00000000a0a1';
const GOAL_B = '00000000-0000-4000-8000-00000000b0b1';

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;
`;

let db; let planning; let outDir;
async function admin(sql, params) { await db.exec('reset role'); return db.query(sql, params); }
async function as(userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
    return tx.query(sql, params);
  });
}
async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
}
const asEvidence = (userId) => as(userId, "insert into public.evidence (user_id, kind, summary, source_type) values ($1, 'user_completion', 'Fake win', 'manual')", [userId]);
async function svc(fn, args) {
  const result = await db.transaction(async (tx) => {
    await tx.exec("set local role service_role; select set_config('request.jwt.claim.sub', '', true);");
    return tx.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args);
  });
  return result.rows[0].r;
}
const rpc = async (userId, fn, args) => (await as(userId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const localToday = async (userId) => (await admin('select private.apm_local_today($1)::text as d', [userId])).rows[0].d;
/** Phase Bridge (0035): the First Hour begins, then the Daily Stack opens. */
const beginDay = async (userId) => { await rpc(userId, 'apm_set_day_phase', ['first_hour']); await rpc(userId, 'apm_set_day_phase', ['executing']); };
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function plan(goal, startDate) {
  return planning.generateGoalPlan(goal, { roles: [], startDate, timezone: 'America/Chicago' });
}
function agendaFor(storedPlan, date, { state = 'normal', mood } = {}) {
  return planning.composeAgenda({
    date, state, mood,
    plans: [{ record: { id: storedPlan.id, goalId: storedPlan.goal_id, status: storedPlan.status, gateReviews: {}, startDate: storedPlan.start_date }, plan: storedPlan.plan }],
    goals: [{ id: storedPlan.goal_id, title: 'lose 30 lbs', status: 'active', priority: 1 }],
    completions: [], morningSequence: ['Drink water'],
  });
}

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-loop-db-'));
  await build({ entryPoints: { planning: planningEntry }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  planning = await import(pathToFileURL(join(outDir, 'planning.js')).href);

  db = new PGlite();
  await db.exec(SUBSTRATE);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.includes('0021_goal_plans_and_daily_loop.sql'));
  for (const name of files) await db.exec(await migration(name));
  await admin(`insert into auth.users (id) values ('${USER_A}'), ('${USER_B}')`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  // 0044: no account gets beta by default; these users hold a paid plan.
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
  await admin(`update public.user_profiles set timezone = 'America/Chicago' where user_id = '${USER_A}'`);
  await admin(`update public.user_profiles set timezone = 'Not/AZone' where user_id = '${USER_B}'`);
  // Installed 10 days ago: past Week 1.
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER_A}', 'standard', current_date - 10), ('${USER_B}', 'standard', current_date)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values
    ('${GOAL_A}', '${USER_A}', 'lose 30 lbs', 'active', 'unknown', 1, 'stated', 'manual'),
    ('${GOAL_B}', '${USER_B}', 'Pass the CPA exam', 'active', 'unknown', 1, 'stated', 'manual')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('three pillars, areas inside (0060): legacy pillar keys are refused everywhere; areas roll up to their pillar', async () => {
  for (const legacy of ['execution', 'wealth', 'body', 'spirit']) {
    await rejects(admin(`insert into public.pillar_settings (user_id, name) values ('${USER_A}', '${legacy}')`), /pillar_settings_name_check/);
    await rejects(admin(`insert into public.routines (user_id, title, pillar) values ('${USER_A}', 'x', '${legacy}')`), /routines_pillar_check/);
    await rejects(admin(`update public.goals set pillar = '${legacy}' where id = '${GOAL_A}'`), /goals_pillar_check/);
  }
  // 0043: a client cannot write pillar settings at all (only the governed intake / OS change flow can).
  await rejects(as(USER_A, "insert into public.pillar_settings (user_id, name) values ($1, 'movement')", [USER_A]), /permission denied/);
  // Family is a real area now (Spirit), no longer a plan-only floor.
  await admin(`insert into public.pillar_settings (user_id, name, critical) values ('${USER_A}', 'family', true) on conflict (user_id, name) do update set critical = true`);
  await admin(`insert into public.pillar_settings (user_id, name) values ('${USER_A}', 'learning') on conflict do nothing`);
  const rows = (await admin(`select name, pillar from public.pillar_settings where user_id = '${USER_A}' and name in ('family', 'learning') order by name`)).rows;
  assert.deepEqual(rows, [{ name: 'family', pillar: 'spirit' }, { name: 'learning', pillar: 'mind' }], 'the pillar is generated from the area');
  await rejects(admin(`update public.pillar_settings set pillar = 'body' where user_id = '${USER_A}' and name = 'family'`), /can only be updated to DEFAULT|generated/);
  await admin(`update public.goals set pillar = 'family' where id = '${GOAL_A}'`);
  await admin(`update public.goals set pillar = null where id = '${GOAL_A}'`);
  await admin(`delete from public.pillar_settings where user_id = '${USER_A}' and name in ('family', 'learning')`);
  const check = (await admin("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'goal_plans_foreground_pillar_check'")).rows[0].d;
  for (const area of ['work', 'money', 'movement', 'family', 'faith']) assert.match(check, new RegExp(area));
  assert.doesNotMatch(check, /execution|wealth/);
});

test('the local day follows the profile timezone and falls back to UTC for an unknown zone', async () => {
  const chicago = (await admin("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d;
  assert.equal(await localToday(USER_A), chicago);
  assert.equal(await localToday(USER_B), (await admin("select (now() at time zone 'UTC')::date::text as d")).rows[0].d);
});

test('no direct writes: plans, completions and day records only move through governed functions', async () => {
  const today = await localToday(USER_A);
  await rejects(as(USER_A, `insert into public.goal_plans (user_id, goal_id, plan_key, template_key, persona, foreground_pillar, start_date, end_date, plan)
    values ($1, $2, 'x', 'x', 'generic', 'movement', $3::date, $3::date + 89, '{}')`, [USER_A, GOAL_A, today]), /permission denied/);
  await rejects(as(USER_A, 'insert into public.day_records (user_id, day, mode, verdict) values ($1, $2::date, $3, $4)', [USER_A, today, 'standard', 'full_day']), /permission denied/);
  await rejects(as(USER_A, 'update public.day_records set verdict = $1', ['full_day']), /permission denied/);
  await rejects(as(USER_A, 'delete from public.day_records'), /permission denied/);
  await rejects(as(USER_A, "insert into public.plan_action_completions (user_id, plan_id, day, action_key, instance_id, scope, role) values ($1, gen_random_uuid(), current_date, 'a', 'a', 'mvd', 'floor')", [USER_A]), /permission denied/);
});

test('plans are shape-checked, audited and one-live-per-goal; reads need owner + entitlement, export does not', async () => {
  const today = await localToday(USER_A);
  await rejects(svc('apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify({ version: 1 }), 'goals']), /loop_invalid_plan/);
  const tampered = { ...plan('lose 30 lbs', today), endDate: shift(today, 200) };
  await rejects(svc('apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify(tampered), 'goals']), /loop_invalid_plan/);
  await rejects(svc('apm_service_save_goal_plan', [USER_A, GOAL_B, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /loop_goal_not_found/);

  const first = await svc('apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'intake']);
  assert.equal(first.persona, 'weight_loss');
  assert.equal(first.foreground_pillar, 'movement');
  const second = await svc('apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']);
  const live = (await admin(`select id, status from public.goal_plans where goal_id = '${GOAL_A}' order by created_at`)).rows;
  assert.deepEqual(live.map((row) => row.status), ['superseded', 'active']);
  assert.equal(live[1].id, second.id);
  const audits = (await admin(`select event_type, metadata from public.audit_events where user_id = '${USER_A}' and object_type = 'goal_plan' order by created_at`)).rows;
  assert.deepEqual(audits.map((a) => a.event_type), ['goal_plan.created', 'goal_plan.replaced']);
  assert.equal(audits[1].metadata.replaced, first.id);

  assert.equal((await as(USER_B, 'select count(*)::int n from public.goal_plans')).rows[0].n, 0, 'another user sees nothing');
  await admin(`update public.subscription_entitlements set status = 'cancelled' where user_id = '${USER_A}'`);
  assert.equal((await as(USER_A, 'select count(*)::int n from public.goal_plans')).rows[0].n, 0, 'no entitlement, no ordinary read');
  await rejects(svc('apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /loop_entitlement_required/);
  const exported = await rpc(USER_A, 'apm_daily_loop_data_rights_export', []);
  assert.equal(exported.goalPlans.length, 2, 'export still returns every plan, superseded included');
  await admin(`update public.subscription_entitlements set status = 'active' where user_id = '${USER_A}'`);
});

test('agendas are server-derived: a client can no longer lock its own agenda (0028)', async () => {
  const today = await localToday(USER_A);
  await rejects(rpc(USER_A, 'apm_day_check_in', [today, 6, 'normal', JSON.stringify({ version: 1 })]), /permission denied/);
  await rejects(rpc(USER_A, 'apm_day_replan', [today, 'safety', null, JSON.stringify({ version: 1 })]), /permission denied/);
  await rejects(rpc(USER_A, 'apm_service_day_check_in', [USER_A, today, 6, 'normal', JSON.stringify({ version: 1 })]), /permission denied/);
  await admin(`update public.subscription_entitlements set status = 'cancelled' where user_id = '${USER_A}'`);
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 6, 'normal', JSON.stringify({ version: 1 })]), /loop_entitlement_required/);
  await admin(`update public.subscription_entitlements set status = 'active' where user_id = '${USER_A}'`);
});

test('plans and evidence are server-derived: no client plan writes, no direct evidence (0029)', async () => {
  const today = await localToday(USER_A);
  await rejects(rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /permission denied/);
  await rejects(rpc(USER_A, 'apm_create_goal', [JSON.stringify({ title: 'x y z' }), JSON.stringify(plan('x y z', today))]), /permission denied/);
  await rejects(rpc(USER_A, 'apm_service_save_goal_plan', [USER_A, GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /permission denied/);
  await rejects(asEvidence(USER_A), /permission denied/);
});

test('the opening step gates execution; only agenda items complete; completion is idempotent evidence', async () => {
  const today = await localToday(USER_A);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  const agenda = agendaFor(stored, today);
  const key = agenda.firstHour.priority.actionKey;

  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, key, null]), /loop_opening_step_required/);
  await rejects(svc('apm_service_day_check_in', [USER_A, shift(today, -1), 6, 'normal', JSON.stringify({ ...agenda, date: shift(today, -1) })]), /loop_day_not_today/);
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 11, 'normal', JSON.stringify(agenda)]), /loop_invalid_request/);
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 6, 'recovery', JSON.stringify(agenda)]), /loop_invalid_agenda/);

  // The stored plan is the source of truth: a forged agenda item never gets in.
  const forged = { ...agenda, dailyStack: [...agenda.dailyStack, { id: 'f', kind: 'plan_floor', title: 'Invented action', planId: stored.id, actionKey: 'invented', status: 'open', reasonCodes: [] }] };
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 6, 'normal', JSON.stringify(forged)]), /loop_invalid_agenda/);
  const foreignPlan = { ...agenda, dailyStack: [{ ...agenda.firstHour.priority, planId: '00000000-0000-4000-8000-00000000dead' }] };
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 6, 'normal', JSON.stringify(foreignPlan)]), /loop_invalid_agenda/);

  const checkIn = await svc('apm_service_day_check_in', [USER_A, today, 6, 'normal', JSON.stringify(agenda)]);
  assert.equal(checkIn.replayed, false);
  assert.equal(checkIn.day.agenda_status, 'locked');
  await rejects(svc('apm_service_day_check_in', [USER_A, today, 1, 'normal', JSON.stringify(agenda)]), /loop_invalid_agenda/, 'mood 1 never locks a standard agenda');
  const again = await svc('apm_service_day_check_in', [USER_A, today, 1, 'normal', JSON.stringify(agendaFor(stored, today, { mood: 1 }))]);
  assert.equal(again.replayed, true);
  assert.equal(again.day.mood, 6, 'the mood is recorded once; it is not renegotiated mid-day');

  // Phase Bridge pacing is enforced in the database (0035), not only in the app.
  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, key, null]), /loop_first_hour_not_started/, 'the First Hour starts on the user’s word');
  await rejects(rpc(USER_A, 'apm_set_day_phase', ['executing']), /loop_first_hour_not_started/, 'the stack cannot open before the First Hour');
  await rpc(USER_A, 'apm_set_day_phase', ['first_hour']);
  const stackItem = agenda.dailyStack.find((item) => item.planId && item.actionKey);
  if (stackItem) await rejects(rpc(USER_A, 'apm_complete_plan_action', [stackItem.planId, stackItem.actionKey, null]), /loop_stack_not_open/, 'the Daily Stack opens after the First Hour');
  await rpc(USER_A, 'apm_set_day_phase', ['executing']);
  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, 'not_today', null]), /loop_not_on_agenda/);
  const actionKeys = Object.keys(stored.plan.actions);
  const offAgenda = actionKeys.find((k) => k !== key && !agenda.dailyStack.some((item) => item.actionKey === k));
  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, offAgenda, null]), /loop_not_on_agenda/, 'a real plan action that is not on today’s agenda');
  const done = await rpc(USER_A, 'apm_complete_plan_action', [stored.id, key, 'Walked before work']);
  assert.equal(done.replayed, false);
  assert.equal(done.completion.role, 'foreground');
  assert.ok(done.completion.evidence_id);
  const replay = await rpc(USER_A, 'apm_complete_plan_action', [stored.id, key, null]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.completion.id, done.completion.id);
  const evidence = (await admin(`select summary, related_goal_id from public.evidence where user_id = '${USER_A}'`)).rows;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].related_goal_id, GOAL_A);
  assert.match(evidence[0].summary, /^Completed: /);
  const record = (await admin(`select completed_action_ids from public.day_records where user_id = '${USER_A}' and day = $1::date`, [today])).rows[0];
  assert.deepEqual(record.completed_action_ids, [done.completion.id]);
});

test('No Mid-Day Negotiation holds in the database: only declared external/safety/permission replans', async () => {
  const today = await localToday(USER_A);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  const agenda = agendaFor(stored, today, { state: 'recovery' });
  for (const reason of ['mood', 'discomfort', null]) {
    await rejects(svc('apm_service_day_replan', [USER_A, today, reason, null, JSON.stringify(agenda)]), /loop_no_midday_negotiation/);
  }
  const replanned = await svc('apm_service_day_replan', [USER_A, today, 'safety', 'Rolled an ankle', JSON.stringify(agenda)]);
  assert.equal(replanned.day_state, 'recovery');
  assert.equal(replanned.replans[0].reason, 'safety');
  await rejects(svc('apm_service_day_replan', [USER_B, await localToday(USER_B), 'external_change', null, JSON.stringify({ ...agenda, date: await localToday(USER_B) })]), /loop_invalid_agenda/, 'another user’s plan items are refused');
  const emptyB = { ...agenda, date: await localToday(USER_B), foregroundPriority: undefined, firstHour: { sequence: [] }, dailyStack: [] };
  await rejects(svc('apm_service_day_replan', [USER_B, await localToday(USER_B), 'external_change', null, JSON.stringify(emptyB)]), /loop_day_not_locked/);
});

test('closing the day closes the LOCAL today, audits it, and then execution stops', async () => {
  const today = await localToday(USER_A);
  // The safety replan swapped the agenda, so the earlier completion is not the whole day.
  await rejects(rpc(USER_A, 'apm_close_day', ['full_day', 'Good day']), /loop_verdict_needs_evidence/);
  const closed = await rpc(USER_A, 'apm_close_day', ['mvd', 'Good day']);
  assert.equal(closed.day, today);
  assert.equal(closed.verdict, 'mvd');
  assert.equal(closed.completed_action_ids.length, 1);
  assert.equal((await admin(`select count(*)::int n from public.audit_events where user_id = '${USER_A}' and event_type = 'day.closed'`)).rows[0].n, 1);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, 'movement_floor', null]), /loop_day_closed/);
});

test('Week 1 blocks new projects and foreground changes; after it, a goal is created with its plan', async () => {
  const todayB = await localToday(USER_B);
  await rejects(svc('apm_service_create_goal', [USER_B, JSON.stringify({ title: 'Run a 10k' }), JSON.stringify(plan('Run a 10k', todayB))]), /loop_week_one_lock/);
  const todayA = await localToday(USER_A);
  await rejects(svc('apm_service_create_goal', [USER_A, JSON.stringify({ title: 'Run a 10k', user_id: USER_B }), JSON.stringify(plan('Run a 10k', todayA))]), /loop_field_not_allowed/);
  const created = await svc('apm_service_create_goal', [USER_A, JSON.stringify({ title: 'Build a 3-month emergency fund', pillar: 'money' }), JSON.stringify(plan('Build a 3-month emergency fund', todayA))]);
  assert.equal(created.goal.priority, 2, 'a new project goes to the background');
  assert.equal(created.plan.persona, 'wealth_building');
  await admin(`update public.personal_os set foreground_goal_id = '${GOAL_A}' where user_id = '${USER_A}'`);
  const moved = await rpc(USER_A, 'apm_set_foreground_goal', [created.goal.id]);
  assert.equal(moved.changed, true);
  const audit = (await admin(`select metadata from public.audit_events where event_type = 'foreground.changed' and user_id = '${USER_A}'`)).rows[0];
  assert.equal(audit.metadata.from, GOAL_A);
});

test('gate reviews and the day-90 decision open only on time and compute the verdict server-side', async () => {
  const today = await localToday(USER_A);
  const fresh = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  await rejects(rpc(USER_A, 'apm_review_plan_gate', [fresh.id, 'foundation', true]), /loop_gate_not_reached/);
  await rejects(rpc(USER_A, 'apm_decide_goal_plan', [fresh.id, 'promote', 'Going well']), /loop_decision_not_due/);

  // A plan that started 95 days ago.
  const oldGoal = (await admin(`insert into public.goals (user_id, title, status, health, priority, provenance_kind, source_type) values ('${USER_A}', 'Pass the bar exam', 'active', 'unknown', 3, 'stated', 'manual') returning id`)).rows[0].id;
  const old = await svc('apm_service_save_goal_plan', [USER_A, oldGoal, JSON.stringify(plan('Pass the bar exam', shift(today, -95))), 'goals']);
  const reviewed = await rpc(USER_A, 'apm_review_plan_gate', [old.id, 'foundation', true]);
  assert.equal(reviewed.gate_reviews.foundation.verdict, 'park', 'no evidence in the window parks it');
  assert.equal(reviewed.gate_reviews.foundation.completedDays, 0);
  const notAligned = await rpc(USER_A, 'apm_review_plan_gate', [old.id, 'build', false]);
  assert.equal(notAligned.gate_reviews.build.verdict, 'park');
  await rejects(rpc(USER_A, 'apm_decide_goal_plan', [old.id, 'promote', 'x']), /loop_invalid_request/);
  const decided = await rpc(USER_A, 'apm_decide_goal_plan', [old.id, 'park', 'Exam moved to next year']);
  assert.equal(decided.status, 'decided');
  assert.equal(decided.decision, 'park');
  assert.equal(decided.gate_reviews.establish.recommended, 'park');
  await rejects(rpc(USER_A, 'apm_decide_goal_plan', [old.id, 'promote', 'Changed my mind']), /loop_already_decided/);
  assert.equal((await admin('select status from public.goals where id = $1', [oldGoal])).rows[0].status, 'paused', 'parking pauses the goal');
  await admin('update public.goals set status = $1 where id = $2', ['active', oldGoal]);
  await rejects(rpc(USER_A, 'apm_set_foreground_goal', [oldGoal]), /loop_goal_parked/, 'a parked plan never takes the foreground');

  for (const [completed, evidence, aligned, expected] of [[21, 21, true, 'promote'], [9, 9, true, 'maintain'], [0, 1, true, 'maintain'], [0, 0, true, 'park'], [30, 30, false, 'park']]) {
    const sql = (await admin('select private.apm_loop_gate_verdict($1, 30, $2, $3) as v', [completed, evidence, aligned])).rows[0].v;
    assert.equal(sql, planning.reviewGateVerdict({ progressScore: Math.round((completed / 30) * 100) / 10, evidenceCount: evidence, stillAligned: aligned }), 'SQL and engine agree');
    assert.equal(sql, expected);
  }
});

test('the legacy next-action completion honours the opening step once the daily loop runs', async () => {
  const insert = (userId) => admin(`insert into public.next_actions (user_id, title, status) values ('${userId}', 'Email the landlord about the lease', 'open') returning id`).then((r) => r.rows[0].id);
  const closedDayAction = await insert(USER_A);
  await rejects(rpc(USER_A, 'apm_complete_next_action', [closedDayAction]), /loop_day_closed/, 'USER_A closed today');
  const noLoopAction = await insert(USER_B);
  const done = await rpc(USER_B, 'apm_complete_next_action', [noLoopAction]);
  assert.equal(done.action.status, 'done', 'no live plan: legacy behaviour');
  await admin(`update public.personal_os set stabilization_started_at = current_date - 10 where user_id = '${USER_B}'`);
  await svc('apm_service_save_goal_plan', [USER_B, GOAL_B, JSON.stringify(plan('Pass the CPA exam', await localToday(USER_B))), 'intake']);
  await rejects(rpc(USER_B, 'apm_complete_next_action', [await insert(USER_B)]), /loop_opening_step_required/);
});

test('evidence before verdict, and the legacy path only completes what today’s agenda printed', async () => {
  const today = await localToday(USER_B);
  await rejects(rpc(USER_B, 'apm_close_day', ['full_day', null]), /loop_opening_step_required/, 'no Full Day without the check-in');
  await rejects(rpc(USER_B, 'apm_close_day', ['mvd', null]), /loop_opening_step_required/);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_B}' and status = 'active'`)).rows[0];
  const onAgenda = (await admin(`insert into public.next_actions (user_id, title, status) values ('${USER_B}', 'Book the CPA exam seat for March', 'open') returning id`)).rows[0].id;
  const offAgenda = (await admin(`insert into public.next_actions (user_id, title, status) values ('${USER_B}', 'Order the review course books', 'open') returning id`)).rows[0].id;
  const agenda = planning.composeAgenda({
    date: today, state: 'normal',
    plans: [{ record: { id: stored.id, goalId: GOAL_B, status: 'active', gateReviews: {}, startDate: stored.start_date }, plan: stored.plan }],
    goals: [{ id: GOAL_B, title: 'Pass the CPA exam', status: 'active', priority: 1 }],
    completions: [], morningSequence: [], nextActions: [{ id: onAgenda, title: 'Book the CPA exam seat for March', status: 'open' }],
  });
  await svc('apm_service_day_check_in', [USER_B, today, 7, 'normal', JSON.stringify(agenda)]);
  const onAgendaIsPriority = agenda.firstHour.priority?.nextActionId === onAgenda;
  await rejects(rpc(USER_B, 'apm_complete_next_action', [onAgenda]), /loop_first_hour_not_started/, 'the legacy path honours Phase Bridge too');
  await rpc(USER_B, 'apm_set_day_phase', ['first_hour']);
  if (!onAgendaIsPriority) await rejects(rpc(USER_B, 'apm_complete_next_action', [onAgenda]), /loop_stack_not_open/);
  await rpc(USER_B, 'apm_set_day_phase', ['executing']);
  assert.equal((await rpc(USER_B, 'apm_complete_next_action', [onAgenda])).action.status, 'done');
  await rejects(rpc(USER_B, 'apm_complete_next_action', [offAgenda]), /loop_not_on_agenda/);
  await rejects(rpc(USER_B, 'apm_close_day', ['full_day', null]), /loop_verdict_needs_evidence/, 'the plan action is still open');
  const closed = await rpc(USER_B, 'apm_close_day', ['mvd', null]);
  assert.equal(closed.verdict, 'mvd', 'after the check-in, evidence supports an MVD');
});

test('the database checks the day’s supply, the Mood Gate and Never Miss Twice, and evidence before verdict', async () => {
  const USER_C = '00000000-0000-4000-8000-0000000000c1';
  const GOAL_C = '00000000-0000-4000-8000-00000000c0c1';
  await admin(`insert into auth.users (id) values ('${USER_C}')`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  // 0044: no account gets beta by default; these users hold a paid plan.
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
  await admin(`update public.user_profiles set timezone = 'Europe/London' where user_id = '${USER_C}'`);
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER_C}', 'standard', current_date - 10)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values ('${GOAL_C}', '${USER_C}', 'lose 30 lbs', 'active', 'unknown', 1, 'stated', 'manual')`);
  const today = await localToday(USER_C);
  const stored = await svc('apm_service_save_goal_plan', [USER_C, GOAL_C, JSON.stringify(plan('lose 30 lbs', shift(today, -3))), 'intake']);
  const entry = { record: { id: stored.id, goalId: GOAL_C, status: 'active', gateReviews: {}, startDate: stored.start_date }, plan: stored.plan };
  const compose = (extra) => planning.composeAgenda({ date: today, plans: [entry], goals: [{ id: GOAL_C, title: 'lose 30 lbs', status: 'active', priority: 1 }], completions: [], morningSequence: [], ...extra });

  // Yesterday had no close and no evidence: Never Miss Twice makes today a Recovery Day.
  await rejects(svc('apm_service_day_check_in', [USER_C, today, 7, 'normal', JSON.stringify(compose({ state: 'normal' }))]), /loop_invalid_agenda/);
  // The Mood Gate: mood 2 never locks a standard agenda.
  await rejects(svc('apm_service_day_check_in', [USER_C, today, 2, 'missed_yesterday', JSON.stringify({ ...compose({ state: 'missed_yesterday' }), mode: 'standard' })]), /loop_invalid_agenda/);
  // An off-schedule action (the day-90 decision on day 4) never gets onto the agenda.
  const recovery = compose({ state: 'missed_yesterday', mood: 6 });
  const offSchedule = { ...recovery, dailyStack: [{ id: 'x', kind: 'plan_floor', title: 'Make the day-90 call', planId: stored.id, actionKey: 'day90_decision', status: 'open', reasonCodes: [] }] };
  await rejects(svc('apm_service_day_check_in', [USER_C, today, 6, 'missed_yesterday', JSON.stringify(offSchedule)]), /loop_invalid_agenda/);
  await svc('apm_service_day_check_in', [USER_C, today, 6, 'missed_yesterday', JSON.stringify(recovery)]);
  await beginDay(USER_C);

  await rejects(rpc(USER_C, 'apm_close_day', ['full_day', null]), /loop_verdict_needs_evidence/, 'no win without evidence');
  await rejects(rpc(USER_C, 'apm_complete_plan_action', [stored.id, 'day90_decision', null]), /loop_not_on_agenda/);
  await rpc(USER_C, 'apm_complete_plan_action', [stored.id, recovery.firstHour.priority.actionKey, null]);
  await rejects(rpc(USER_C, 'apm_close_day', ['full_day', null]), /loop_verdict_needs_evidence/, 'a recovery day closes as an MVD at most');
  assert.equal((await admin('select private.apm_loop_max_verdict($1, $2::date) v', [USER_C, today])).rows[0].v, 'mvd');
  assert.equal((await rpc(USER_C, 'apm_close_day', ['mvd', null])).verdict, 'mvd');
  await rejects(rpc(USER_C, 'apm_close_day', ['full_day', null]), /loop_day_closed/, 'a closed day stays closed');
  await rejects(rpc(USER_C, 'apm_close_day', ['miss', null]), /loop_day_closed/);

  const allowed = (await admin('select private.apm_loop_allowed_actions($1::jsonb, $2::date) a', [JSON.stringify(stored.plan), today])).rows[0].a;
  const engine = planning.supplyDailyActions(stored.plan, { date: today, state: 'normal' });
  for (const action of [engine.foreground, ...engine.floors]) assert.ok(allowed.includes(action.actionKey), `SQL supply includes ${action.actionKey}`);
  for (let offset = -1; offset <= 95; offset += 7) {
    const day = shift(stored.start_date, offset);
    const sqlKeys = (await admin('select private.apm_loop_allowed_actions($1::jsonb, $2::date) a', [JSON.stringify(stored.plan), day])).rows[0].a;
    for (const state of ['normal', 'recovery']) {
      const supply = planning.supplyDailyActions(stored.plan, { date: day, state });
      for (const action of [supply.foreground, ...supply.floors]) assert.ok(sqlKeys.includes(action.actionKey), `day ${offset + 1} ${state}: ${action.actionKey}`);
    }
    assert.ok(offset + 1 >= 90 || !sqlKeys.includes('day90_decision'), `day ${offset + 1} never offers the day-90 decision early`);
  }
});

test('a Full Day needs the whole locked agenda done; setup days supply only setup; parked plans are never missed', async () => {
  const USER_D = '00000000-0000-4000-8000-0000000000d1';
  const GOAL_D = '00000000-0000-4000-8000-00000000d0d1';
  await admin(`insert into auth.users (id) values ('${USER_D}')`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  // 0044: no account gets beta by default; these users hold a paid plan.
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER_D}', 'standard', current_date - 10)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values ('${GOAL_D}', '${USER_D}', 'Launch my business', 'active', 'unknown', 1, 'stated', 'manual')`);
  const today = await localToday(USER_D);
  const parentPlan = planning.generateGoalPlan('Launch my business', { roles: ['Parenting / caregiving', 'Building a business'], startDate: shift(today, -9) });
  const stored = await svc('apm_service_save_goal_plan', [USER_D, GOAL_D, JSON.stringify(parentPlan), 'intake']);
  const entry = { record: { id: stored.id, goalId: GOAL_D, status: 'active', gateReviews: {}, startDate: stored.start_date }, plan: stored.plan };
  // Yesterday was closed with evidence-free MVD? No: make yesterday a clean full day via admin so today is normal.
  await admin(`insert into public.day_records (user_id, day, mode, verdict, closed_at) values ('${USER_D}', $1::date - 1, 'standard', 'full_day', now())`, [today]);
  const agenda = planning.composeAgenda({ date: today, state: 'normal', plans: [entry], goals: [{ id: GOAL_D, title: 'Launch my business', status: 'active', priority: 1 }], completions: [], morningSequence: [] });
  assert.ok(agenda.dailyStack.length >= 1, 'a foreground action plus the family floor');
  await svc('apm_service_day_check_in', [USER_D, today, 7, 'normal', JSON.stringify(agenda)]);
  await beginDay(USER_D);
  await rpc(USER_D, 'apm_complete_plan_action', [stored.id, agenda.firstHour.priority.actionKey, null]);
  await rejects(rpc(USER_D, 'apm_close_day', ['full_day', null]), /loop_verdict_needs_evidence/, 'one of two done is not a Full Day');
  assert.equal((await admin('select private.apm_loop_max_verdict($1, $2::date) v', [USER_D, today])).rows[0].v, 'mvd');
  for (const item of agenda.dailyStack) await rpc(USER_D, 'apm_complete_plan_action', [stored.id, item.actionKey, null]);
  assert.equal((await rpc(USER_D, 'apm_close_day', ['full_day', null])).verdict, 'full_day');

  // Setup days: the SQL supply equals the engine's (setup action only, never the cadence on top).
  for (const setup of stored.plan.setup) {
    const day = shift(stored.start_date, setup.day - 1);
    const sqlKeys = (await admin('select private.apm_loop_allowed_actions($1::jsonb, $2::date) a', [JSON.stringify(stored.plan), day])).rows[0].a;
    assert.deepEqual([...sqlKeys].sort(), [...stored.plan.floors, setup.actionKey].sort(), `setup day ${setup.day}`);
  }

  // A parked plan never makes tomorrow "missed".
  await admin(`update public.goal_plans set status = 'decided', decision = 'park', decision_reason = 'Parked', decided_at = now() where id = $1`, [stored.id]);
  await admin(`update public.goals set status = 'paused' where id = $1`, [GOAL_D]);
  assert.equal((await admin('select private.apm_loop_missed_yesterday($1, $2::date + 2) m', [USER_D, today])).rows[0].m, false);
});

test('a locked agenda must carry the floors the supply requires; the day-90 decision waits for the check-in', async () => {
  const USER_E = '00000000-0000-4000-8000-0000000000e1';
  const GOAL_E = '00000000-0000-4000-8000-00000000e0e1';
  await admin(`insert into auth.users (id) values ('${USER_E}')`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  // 0044: no account gets beta by default; these users hold a paid plan.
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER_E}', 'standard', current_date - 100)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values ('${GOAL_E}', '${USER_E}', 'Launch my business', 'active', 'unknown', 1, 'stated', 'manual')`);
  const today = await localToday(USER_E);
  const stored = await svc('apm_service_save_goal_plan', [USER_E, GOAL_E, JSON.stringify(planning.generateGoalPlan('Launch my business', { roles: ['Parenting / caregiving', 'Building a business'], startDate: shift(today, -95) })), 'intake']);
  await admin(`insert into public.day_records (user_id, day, mode, verdict, closed_at) values ('${USER_E}', $1::date - 1, 'standard', 'full_day', now())`, [today]);
  await rejects(rpc(USER_E, 'apm_decide_goal_plan', [stored.id, 'promote', 'It worked']), /loop_opening_step_required/, 'no decision before the opening step');
  await rejects(rpc(USER_E, 'apm_review_plan_gate', [stored.id, 'foundation', true]), /loop_opening_step_required/, 'no gate review before the opening step');
  const entry = { record: { id: stored.id, goalId: GOAL_E, status: 'active', gateReviews: {}, startDate: stored.start_date }, plan: stored.plan };
  const agenda = planning.composeAgenda({ date: today, state: 'normal', plans: [entry], goals: [{ id: GOAL_E, title: 'Launch my business', status: 'active', priority: 1 }], completions: [], morningSequence: [] });
  assert.ok(agenda.dailyStack.some((item) => item.actionKey === 'family_floor'));
  const stripped = { ...agenda, dailyStack: agenda.dailyStack.filter((item) => item.actionKey !== 'family_floor') };
  await rejects(svc('apm_service_day_check_in', [USER_E, today, 7, 'normal', JSON.stringify(stripped)]), /loop_invalid_agenda/, 'the family floor cannot be dropped to fake a Full Day');
  const foreignPriority = { ...agenda, firstHour: { ...agenda.firstHour, priority: undefined } };
  await rejects(svc('apm_service_day_check_in', [USER_E, today, 7, 'normal', JSON.stringify(foreignPriority)]), /loop_invalid_agenda/);
  const planless = { ...agenda, foregroundPriority: undefined, firstHour: { sequence: [] }, dailyStack: [] };
  await rejects(svc('apm_service_day_check_in', [USER_E, today, 7, 'normal', JSON.stringify(planless)]), /loop_invalid_agenda/, 'a running plan cannot be left off the agenda');
  await svc('apm_service_day_check_in', [USER_E, today, 7, 'normal', JSON.stringify(agenda)]);
  await beginDay(USER_E);
  assert.equal((await rpc(USER_E, 'apm_review_plan_gate', [stored.id, 'foundation', true])).gate_reviews.foundation.verdict, 'park');
  assert.equal((await rpc(USER_E, 'apm_decide_goal_plan', [stored.id, 'promote', 'It worked'])).decision, 'promote');
});

test('next_actions are RPC-only (0035): no direct owner writes, intake still seeds, completion stays governed', async () => {
  const USER_F = '00000000-0000-4000-8000-0000000000f1';
  await admin(`insert into auth.users (id) values ('${USER_F}')`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  // 0044: no account gets beta by default; these users hold a paid plan.
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
  // Onboarding (SECURITY INVOKER) seeds its first action through the governed writer.
  await rpc(USER_F, 'apm_save_onboarding', ['Ana', ['parent'], 'Run a 10k in spring', null, null, 'body']);
  // An older client's legacy pillar key is mapped to its area (0060), never refused.
  assert.equal((await admin(`select pillar from public.goals where user_id = $1`, [USER_F])).rows[0].pillar, 'movement');
  const seeded = (await admin(`select id, status, goal_id from public.next_actions where user_id = $1`, [USER_F])).rows;
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].status, 'open');

  // Every direct write is refused — the forgery the P2 named: marking your own action done.
  await rejects(as(USER_F, `update public.next_actions set status = 'done' where id = $1`, [seeded[0].id]), /permission denied/);
  await rejects(as(USER_F, `insert into public.next_actions (user_id, goal_id, title, status) values ($1, $2, 'Forged', 'done')`, [USER_F, seeded[0].goal_id]), /permission denied/);
  await rejects(as(USER_F, `delete from public.next_actions where id = $1`, [seeded[0].id]), /permission denied/);
  const policies = (await admin(`select cmd from pg_policies where tablename = 'next_actions' order by cmd`)).rows.map((row) => row.cmd);
  assert.deepEqual(policies, ['SELECT']);
  assert.equal((await as(USER_F, 'select count(*)::int n from public.next_actions')).rows[0].n, 1, 'the owner can still read');

  // The intake replaces the open action through the same writer.
  await rpc(USER_F, 'apm_save_methodology_intake', [JSON.stringify({ primary_goal: 'Run a 10k in spring', first_next_action: 'Jog 15 minutes after work', roles: ['parent'] })]);
  const after = (await admin(`select title, status from public.next_actions where user_id = $1 order by created_at, title`, [USER_F])).rows;
  assert.ok(after.some((row) => row.title === 'Jog 15 minutes after work' && row.status === 'open'));
  assert.ok(after.every((row) => row.status !== 'done'), 'a seed is never a completion');
  // The governed completion (no daily loop yet for this user) still works.
  const done = await rpc(USER_F, 'apm_complete_next_action', [seeded[0].id]);
  assert.equal(done.action.status, 'done');
});

test('0094: the 1–10 mood is consumer health data: discarded without a live consent, required with it', async () => {
  const setup = async (n) => {
    const user = `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;
    const goal = `00000000-0000-4000-8000-0000000019${String(n).padStart(2, '0')}`;
    await admin(`insert into auth.users (id) values ('${user}')`);
    await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where plan = 'beta' and provider is null");
    await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${user}', 'standard', current_date - 10)`);
    await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values ('${goal}', '${user}', 'Launch my business', 'active', 'unknown', 1, 'stated', 'manual')`);
    const today = await localToday(user);
    const stored = await svc('apm_service_save_goal_plan', [user, goal, JSON.stringify(planning.generateGoalPlan('Launch my business', { roles: ['Building a business'], startDate: shift(today, -9) })), 'intake']);
    await admin(`insert into public.day_records (user_id, day, mode, verdict, closed_at) values ('${user}', $1::date - 1, 'standard', 'full_day', now())`, [today]);
    const entry = { record: { id: stored.id, goalId: goal, status: 'active', gateReviews: {}, startDate: stored.start_date }, plan: stored.plan };
    const agenda = (mood) => planning.composeAgenda({ date: today, state: 'normal', mood, plans: [entry], goals: [{ id: goal, title: 'Launch my business', status: 'active', priority: 1 }], completions: [], morningSequence: [] });
    return { user, today, agenda };
  };
  // Never asked, and withdrawn: a mood sent anyway is not stored, not kept in the agenda, and gates nothing.
  const never = await setup(1);
  const withdrawn = await setup(2);
  await rpc(withdrawn.user, 'apm_record_consent', ['consumer_health_data', 'granted', '2026-10-08']);
  await rpc(withdrawn.user, 'apm_record_consent', ['consumer_health_data', 'withdrawn', '2026-10-08']);
  for (const { user, today, agenda } of [never, withdrawn]) {
    const sent = { ...agenda(7), mood: 1 };
    const result = await svc('apm_service_day_check_in_v2', [user, today, 1, 'normal', JSON.stringify(sent)]);
    assert.equal(result.replayed, false);
    assert.equal(result.day.mood, null, 'the score is discarded');
    assert.ok(!('mood' in result.day.agenda), 'and not kept inside the agenda');
    const row = (await admin('select mood, agenda ? \'mood\' as has from public.day_records where user_id = $1 and day = $2::date', [user, today])).rows[0];
    assert.deepEqual(row, { mood: null, has: false });
    const audit = (await admin(`select metadata from public.audit_events where user_id = $1 and event_type = 'day.checked_in'`, [user])).rows[0].metadata;
    assert.equal(audit.mvd, false, 'a discarded score never turns the day light');
  }
  // With consent the score is required and kept, as before.
  const consented = await setup(3);
  await rpc(consented.user, 'apm_record_consent', ['consumer_health_data', 'granted', '2026-10-08']);
  await rejects(svc('apm_service_day_check_in_v2', [consented.user, consented.today, null, 'normal', JSON.stringify(consented.agenda())]), /loop_invalid_request/);
  await rejects(svc('apm_service_day_check_in_v2', [consented.user, consented.today, 11, 'normal', JSON.stringify(consented.agenda())]), /loop_invalid_request/);
  assert.equal((await svc('apm_service_day_check_in_v2', [consented.user, consented.today, 7, 'normal', JSON.stringify(consented.agenda(7))])).day.mood, 7);
  // Service role only.
  await rejects(rpc(consented.user, 'apm_service_day_check_in_v2', [consented.user, consented.today, 7, 'normal', JSON.stringify(consented.agenda(7))]), /permission denied/);
});
