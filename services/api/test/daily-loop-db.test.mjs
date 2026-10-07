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
const rpc = async (userId, fn, args) => (await as(userId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const localToday = async (userId) => (await admin('select private.apm_local_today($1)::text as d', [userId])).rows[0].d;
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
  await admin(`update public.user_profiles set timezone = 'America/Chicago' where user_id = '${USER_A}'`);
  await admin(`update public.user_profiles set timezone = 'Not/AZone' where user_id = '${USER_B}'`);
  // Installed 10 days ago: past Week 1.
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER_A}', 'standard', current_date - 10), ('${USER_B}', 'standard', current_date)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values
    ('${GOAL_A}', '${USER_A}', 'lose 30 lbs', 'active', 'unknown', 1, 'stated', 'manual'),
    ('${GOAL_B}', '${USER_B}', 'Pass the CPA exam', 'active', 'unknown', 1, 'stated', 'manual')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('the family pillar is first-class on goals, pillar settings and routines', async () => {
  await as(USER_A, "insert into public.pillar_settings (user_id, name, active, critical, minimum_floor) values ($1, 'family', true, true, 'Read one bedtime story')", [USER_A]);
  await rejects(as(USER_A, "insert into public.pillar_settings (user_id, name) values ($1, 'hobbies')", [USER_A]), /pillar_settings_name_check/);
  await admin(`insert into public.routines (user_id, title, pillar) values ('${USER_A}', 'School run', 'family')`);
});

test('the local day follows the profile timezone and falls back to UTC for an unknown zone', async () => {
  const chicago = (await admin("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d;
  assert.equal(await localToday(USER_A), chicago);
  assert.equal(await localToday(USER_B), (await admin("select (now() at time zone 'UTC')::date::text as d")).rows[0].d);
});

test('no direct writes: plans, completions and day records only move through governed functions', async () => {
  const today = await localToday(USER_A);
  await rejects(as(USER_A, `insert into public.goal_plans (user_id, goal_id, plan_key, template_key, persona, foreground_pillar, start_date, end_date, plan)
    values ($1, $2, 'x', 'x', 'generic', 'body', $3::date, $3::date + 89, '{}')`, [USER_A, GOAL_A, today]), /permission denied/);
  await rejects(as(USER_A, 'insert into public.day_records (user_id, day, mode, verdict) values ($1, $2::date, $3, $4)', [USER_A, today, 'standard', 'full_day']), /permission denied/);
  await rejects(as(USER_A, 'update public.day_records set verdict = $1', ['full_day']), /permission denied/);
  await rejects(as(USER_A, 'delete from public.day_records'), /permission denied/);
  await rejects(as(USER_A, "insert into public.plan_action_completions (user_id, plan_id, day, action_key, instance_id, scope, role) values ($1, gen_random_uuid(), current_date, 'a', 'a', 'mvd', 'floor')", [USER_A]), /permission denied/);
});

test('plans are shape-checked, audited and one-live-per-goal; reads need owner + entitlement, export does not', async () => {
  const today = await localToday(USER_A);
  await rejects(rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify({ version: 1 }), 'goals']), /loop_invalid_plan/);
  const tampered = { ...plan('lose 30 lbs', today), endDate: shift(today, 200) };
  await rejects(rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify(tampered), 'goals']), /loop_invalid_plan/);
  await rejects(rpc(USER_A, 'apm_save_goal_plan', [GOAL_B, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /loop_goal_not_found/);

  const first = await rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'intake']);
  assert.equal(first.persona, 'weight_loss');
  assert.equal(first.foreground_pillar, 'body');
  const second = await rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']);
  const live = (await admin(`select id, status from public.goal_plans where goal_id = '${GOAL_A}' order by created_at`)).rows;
  assert.deepEqual(live.map((row) => row.status), ['superseded', 'active']);
  assert.equal(live[1].id, second.id);
  const audits = (await admin(`select event_type, metadata from public.audit_events where user_id = '${USER_A}' and object_type = 'goal_plan' order by created_at`)).rows;
  assert.deepEqual(audits.map((a) => a.event_type), ['goal_plan.created', 'goal_plan.replaced']);
  assert.equal(audits[1].metadata.replaced, first.id);

  assert.equal((await as(USER_B, 'select count(*)::int n from public.goal_plans')).rows[0].n, 0, 'another user sees nothing');
  await admin(`update public.subscription_entitlements set status = 'cancelled' where user_id = '${USER_A}'`);
  assert.equal((await as(USER_A, 'select count(*)::int n from public.goal_plans')).rows[0].n, 0, 'no entitlement, no ordinary read');
  await rejects(rpc(USER_A, 'apm_save_goal_plan', [GOAL_A, JSON.stringify(plan('lose 30 lbs', today)), 'goals']), /loop_entitlement_required/);
  const exported = await rpc(USER_A, 'apm_daily_loop_data_rights_export', []);
  assert.equal(exported.goalPlans.length, 2, 'export still returns every plan, superseded included');
  await admin(`update public.subscription_entitlements set status = 'active' where user_id = '${USER_A}'`);
});

test('the opening step gates execution; only agenda items complete; completion is idempotent evidence', async () => {
  const today = await localToday(USER_A);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  const agenda = agendaFor(stored, today);
  const key = agenda.firstHour.priority.actionKey;

  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, key, null]), /loop_opening_step_required/);
  await rejects(rpc(USER_A, 'apm_day_check_in', [shift(today, -1), 6, 'normal', JSON.stringify({ ...agenda, date: shift(today, -1) })]), /loop_day_not_today/);
  await rejects(rpc(USER_A, 'apm_day_check_in', [today, 11, 'normal', JSON.stringify(agenda)]), /loop_invalid_request/);
  await rejects(rpc(USER_A, 'apm_day_check_in', [today, 6, 'recovery', JSON.stringify(agenda)]), /loop_invalid_agenda/);

  const checkIn = await rpc(USER_A, 'apm_day_check_in', [today, 6, 'normal', JSON.stringify(agenda)]);
  assert.equal(checkIn.replayed, false);
  assert.equal(checkIn.day.agenda_status, 'locked');
  const again = await rpc(USER_A, 'apm_day_check_in', [today, 1, 'normal', JSON.stringify(agenda)]);
  assert.equal(again.replayed, true);
  assert.equal(again.day.mood, 6, 'the mood is recorded once; it is not renegotiated mid-day');

  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, 'not_today', null]), /loop_not_on_agenda/);
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
    await rejects(rpc(USER_A, 'apm_day_replan', [today, reason, null, JSON.stringify(agenda)]), /loop_no_midday_negotiation/);
  }
  const replanned = await rpc(USER_A, 'apm_day_replan', [today, 'safety', 'Rolled an ankle', JSON.stringify(agenda)]);
  assert.equal(replanned.day_state, 'recovery');
  assert.equal(replanned.replans[0].reason, 'safety');
  await rejects(rpc(USER_B, 'apm_day_replan', [await localToday(USER_B), 'external_change', null, JSON.stringify({ ...agenda, date: await localToday(USER_B) })]), /loop_day_not_locked/);
});

test('closing the day closes the LOCAL today, audits it, and then execution stops', async () => {
  const today = await localToday(USER_A);
  const closed = await rpc(USER_A, 'apm_close_day', ['full_day', 'Good day']);
  assert.equal(closed.day, today);
  assert.equal(closed.verdict, 'full_day');
  assert.equal(closed.completed_action_ids.length, 1);
  assert.equal((await admin(`select count(*)::int n from public.audit_events where user_id = '${USER_A}' and event_type = 'day.closed'`)).rows[0].n, 1);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL_A}' and status = 'active'`)).rows[0];
  await rejects(rpc(USER_A, 'apm_complete_plan_action', [stored.id, 'movement_floor', null]), /loop_day_closed/);
});

test('Week 1 blocks new projects and foreground changes; after it, a goal is created with its plan', async () => {
  const todayB = await localToday(USER_B);
  await rejects(rpc(USER_B, 'apm_create_goal', [JSON.stringify({ title: 'Run a 10k' }), JSON.stringify(plan('Run a 10k', todayB))]), /loop_week_one_lock/);
  const todayA = await localToday(USER_A);
  await rejects(rpc(USER_A, 'apm_create_goal', [JSON.stringify({ title: 'Run a 10k', user_id: USER_B }), JSON.stringify(plan('Run a 10k', todayA))]), /loop_field_not_allowed/);
  const created = await rpc(USER_A, 'apm_create_goal', [JSON.stringify({ title: 'Build a 3-month emergency fund', pillar: 'wealth' }), JSON.stringify(plan('Build a 3-month emergency fund', todayA))]);
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
  const old = await rpc(USER_A, 'apm_save_goal_plan', [oldGoal, JSON.stringify(plan('Pass the bar exam', shift(today, -95))), 'goals']);
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

  for (const [completed, evidence, aligned, expected] of [[21, 21, true, 'promote'], [9, 9, true, 'maintain'], [0, 1, true, 'maintain'], [0, 0, true, 'park'], [30, 30, false, 'park']]) {
    const sql = (await admin('select private.apm_loop_gate_verdict($1, 30, $2, $3) as v', [completed, evidence, aligned])).rows[0].v;
    assert.equal(sql, planning.reviewGateVerdict({ progressScore: Math.round((completed / 30) * 100) / 10, evidenceCount: evidence, stillAligned: aligned }), 'SQL and engine agree');
    assert.equal(sql, expected);
  }
});
