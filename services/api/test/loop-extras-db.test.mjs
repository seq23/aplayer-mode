// Executes the REAL migration chain in PGlite and proves the 0030 contract:
//   * Diary: "Logged.", no content in the audit trail, owner + entitlement reads;
//   * weekly reviews and OS changes: governed writes only; the Drafting Room drafts,
//     validates, applies from tomorrow, and Week 1 blocks applying;
//   * Phase Bridge, Return/Reset, REPRINT (service-only, scope preserved);
//   * the Body red-flag pause persists until clearance and body plans must carry it;
//   * Track floors complete only while their Track is active;
//   * the data-rights export covers the new records.
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
const USER = '00000000-0000-4000-8000-0000000002a1';
const NEWBIE = '00000000-0000-4000-8000-0000000002b1';
const GOAL = '00000000-0000-4000-8000-0000000002c1';

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

let db; let planning; let outDir;
async function admin(sql, params) { await db.exec('reset role'); return db.query(sql, params); }
async function asRole(role, userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', true);`);
    return tx.query(sql, params);
  });
}
const call = async (role, userId, fn, args) => (await asRole(role, userId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const rpc = (userId, fn, args = []) => call('authenticated', userId, fn, args);
const svc = (fn, args) => call('service_role', null, fn, args);
async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
}
const localToday = async (userId) => (await admin('select private.apm_local_today($1)::text d', [userId])).rows[0].d;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-extras-db-'));
  await build({ entryPoints: { planning: planningEntry }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  planning = await import(pathToFileURL(join(outDir, 'planning.js')).href);
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) await db.exec(await migration(name));
  await admin(`insert into auth.users (id) values ('${USER}'), ('${NEWBIE}')`);
  await admin(`insert into public.personal_os (user_id, active_mode, stabilization_started_at) values ('${USER}', 'standard', current_date - 20), ('${NEWBIE}', 'standard', current_date)`);
  await admin(`insert into public.goals (id, user_id, title, status, health, priority, provenance_kind, source_type) values ('${GOAL}', '${USER}', 'lose 30 lbs', 'active', 'unknown', 1, 'stated', 'manual')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('Diary is silent logging: "Logged.", the audit carries no content, direct writes are refused', async () => {
  const logged = await rpc(USER, 'apm_log_diary', ['breakthrough', 'Walking after lunch works for me']);
  assert.equal(logged.reply, 'Logged.');
  assert.equal(logged.entry.local_day, await localToday(USER));
  const audit = (await admin(`select metadata from public.audit_events where event_type = 'diary.logged'`)).rows[0].metadata;
  assert.deepEqual(audit, { kind: 'breakthrough' });
  await rejects(rpc(USER, 'apm_log_diary', ['rant', 'x']), /loop_invalid_request/);
  await rejects(asRole('authenticated', USER, "insert into public.diary_entries (user_id, body, local_day) values ($1, 'x', current_date)", [USER]), /permission denied/);
  assert.equal((await asRole('authenticated', NEWBIE, 'select count(*)::int n from public.diary_entries')).rows[0].n, 0);
});

test('the Drafting Room: draft → validate → apply from tomorrow; Week 1 blocks applying; discard', async () => {
  await rejects(rpc(USER, 'apm_draft_os_change', ['morning_sequence', JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']), null]), /loop_invalid_request/);
  await rejects(rpc(USER, 'apm_draft_os_change', ['track_settings', JSON.stringify({ hardStop: '6pm' }), null]), /loop_invalid_request/);
  await rejects(rpc(USER, 'apm_draft_os_change', ['track_settings', JSON.stringify({ salary: 1 }), null]), /loop_field_not_allowed/);
  await rejects(rpc(USER, 'apm_draft_os_change', ['tracks', JSON.stringify(['manifestation_mastery']), null]), /loop_invalid_request/);
  await rejects(rpc(USER, 'apm_draft_os_change', ['pillar', JSON.stringify({ name: 'family', critical: true }), null]), /loop_invalid_request/, 'four LOCKED pillars');

  const draft = await rpc(USER, 'apm_draft_os_change', ['morning_sequence', JSON.stringify(['Drink water', 'Stretch 60 seconds']), 'Simpler mornings']);
  assert.equal(draft.status, 'draft');
  assert.deepEqual((await admin(`select morning_sequence from public.personal_os where user_id = '${USER}'`)).rows[0].morning_sequence, [], 'a draft changes nothing');
  const applied = await rpc(USER, 'apm_apply_os_change', [draft.id]);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.effective_from, shift(await localToday(USER), 1));
  assert.deepEqual((await admin(`select morning_sequence from public.personal_os where user_id = '${USER}'`)).rows[0].morning_sequence, ['Drink water', 'Stretch 60 seconds']);
  await rejects(rpc(USER, 'apm_apply_os_change', [draft.id]), /loop_change_not_draft/);

  for (const [field, value, check] of [
    ['day_start', 'hard', "accountability->>'dayStart'"],
    ['coaching_reminder_days', 5, "accountability->>'coachingReminderAfterDays'"],
    ['track_settings', { hardStop: '18:00', movementFloor: 'Walk 12 minutes' }, "track_settings->>'hardStop'"],
    ['review_day', 'friday', "weekly_cadence->>'reviewDay'"],
  ]) {
    const change = await rpc(USER, 'apm_draft_os_change', [field, JSON.stringify(value), null]);
    await rpc(USER, 'apm_apply_os_change', [change.id]);
    const stored = (await admin(`select ${check} v from public.personal_os where user_id = '${USER}'`)).rows[0].v;
    assert.equal(String(stored), field === 'review_day' ? 'Friday' : String(typeof value === 'object' ? value.hardStop : value), field);
  }
  const tracks = await rpc(USER, 'apm_draft_os_change', ['tracks', JSON.stringify(['body_foundation', 'resilience']), null]);
  await rpc(USER, 'apm_apply_os_change', [tracks.id]);
  assert.deepEqual((await admin(`select key from public.tracks where user_id = '${USER}' order by key`)).rows.map((r) => r.key), ['body_foundation', 'resilience']);
  const pillar = await rpc(USER, 'apm_draft_os_change', ['pillar', JSON.stringify({ name: 'body', critical: true, minimumFloor: 'Walk 10 minutes' }), null]);
  await rpc(USER, 'apm_apply_os_change', [pillar.id]);
  assert.deepEqual((await admin(`select critical, minimum_floor from public.pillar_settings where user_id = '${USER}' and name = 'body'`)).rows[0], { critical: true, minimum_floor: 'Walk 10 minutes' });
  // 0037: the plans pick the change up on its effective date, once, through the service path.
  const pendingNow = await svc('apm_service_pending_pillar_rebuilds', [USER]);
  assert.deepEqual(pendingNow.changes, [], 'not before the effective date');
  assert.deepEqual(Object.keys(pendingNow.effective), ['body'], 'today still runs on the pre-change body pillar');
  await rejects(rpc(USER, 'apm_service_pending_pillar_rebuilds', [USER]), /permission denied/);
  await rejects(rpc(USER, 'apm_service_mark_pillar_rebuilt', [USER, pillar.id]), /permission denied/);
  assert.equal(await svc('apm_service_mark_pillar_rebuilt', [USER, pillar.id]), false, 'cannot be marked early');
  await admin(`update public.os_change_requests set effective_from = private.apm_local_today($1) where id = $2`, [USER, pillar.id]);
  const due = await svc('apm_service_pending_pillar_rebuilds', [USER]);
  assert.deepEqual(due.changes, [{ id: pillar.id, pillar: 'body' }]);
  assert.deepEqual(due.effective, {}, 'no later change: the current pillar row is the effective one');
  assert.equal(await svc('apm_service_mark_pillar_rebuilt', [USER, pillar.id]), true);
  assert.deepEqual((await svc('apm_service_pending_pillar_rebuilds', [USER])).changes, [], 'rebuilt once');

  const early = await rpc(NEWBIE, 'apm_draft_os_change', ['day_start', JSON.stringify('hard'), null]);
  await rejects(rpc(NEWBIE, 'apm_apply_os_change', [early.id]), /loop_week_one_lock/, 'Week 1: do not customise');
  const discarded = await rpc(NEWBIE, 'apm_discard_os_change', [early.id]);
  assert.equal(discarded.status, 'discarded');
  await rejects(rpc(USER, 'apm_apply_os_change', [early.id]), /loop_change_not_found/, 'another user’s change is invisible');
  const events = (await admin(`select event_type from public.audit_events where object_type = 'os_change_request' order by created_at`)).rows.map((r) => r.event_type);
  assert.ok(events.includes('os_change.drafted') && events.includes('os_change.applied') && events.includes('os_change.discarded'));
});

test('the Body red-flag pause persists until clearance; a body plan saved meanwhile must carry it', async () => {
  const today = await localToday(USER);
  // The plan started 10 days ago; a referral or clearance rebuild must not restart it (0035).
  const started = shift(today, -10);
  const original = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: started });
  const live = await svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(original), 'goals']);
  await admin(`update public.goal_plans set gate_reviews = '{"foundation": {"verdict": "maintain"}}' where id = $1`, [live.id]);
  const unpaused = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: started });
  await rpc(USER, 'apm_flag_body_referral', ['diary']);
  await rejects(svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(unpaused), 'goals']), /loop_body_referral_active/);
  const restarted = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: today, body: { referralActive: true } });
  await rejects(svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(restarted), 'referral']), /loop_plan_restart_refused/, 'a referral rebuild never restarts the 90 days');
  const paused = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: started, body: { referralActive: true } });
  const stored = await svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(paused), 'referral']);
  assert.equal(stored.plan.safety.referral, true);
  assert.deepEqual([stored.start_date, stored.end_date], [started, shift(started, 89)], 'same 90 days');
  assert.deepEqual(stored.gate_reviews, { foundation: { verdict: 'maintain' } }, 'gate reviews survive the rebuild');
  // In place (0036): the same plan row, so completions already recorded keep counting
  // for the remaining reviews and a locked agenda naming this plan stays completable.
  assert.equal(stored.id, live.id, 'a rebuild never supersedes the plan');
  assert.equal(Number((await admin(`select count(*)::int n from public.goal_plans where goal_id = $1`, [GOAL])).rows[0].n), 1, 'no superseded copy');
  assert.equal(Number((await admin(`select count(*)::int n from public.audit_events where event_type = 'goal_plan.rebuilt' and object_id = $1`, [live.id])).rows[0].n), 1);
  assert.equal((await admin('select private.apm_loop_track_floor_allowed($1, $2) a', [USER, 'track:body_floor'])).rows[0].a, false, 'no body floor while paused');
  const cleared = await rpc(USER, 'apm_record_clinician_clearance', []);
  assert.ok(cleared.clinicianClearedAt);
  await rejects(rpc(USER, 'apm_record_clinician_clearance', []), /loop_no_referral/);
  await rejects(svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: today })), 'clearance']), /loop_plan_restart_refused/);
  await rejects(svc('apm_service_save_goal_plan', [USER, '00000000-0000-4000-8000-00000000dead', JSON.stringify(unpaused), 'os_change']), /loop_plan_restart_refused|loop_goal_not_found/);
  const clearedPlan = await svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(unpaused), 'clearance']);
  assert.equal(clearedPlan.start_date, started, 'clearance keeps the 90 days too');
  assert.equal(clearedPlan.id, live.id, 'and the same plan, so its completion history stays attached');
  assert.equal((await admin('select private.apm_loop_track_floor_allowed($1, $2) a', [USER, 'track:body_floor'])).rows[0].a, true);
  assert.equal((await admin('select private.apm_loop_track_floor_allowed($1, $2) a', [USER, 'track:home_touchpoint'])).rows[0].a, false, 'Home Front is not active');
});

test('Phase Bridge, Return/Reset and REPRINT on the day record', async () => {
  const today = await localToday(USER);
  await rejects(rpc(USER, 'apm_set_day_phase', ['first_hour']), /loop_opening_step_required/);
  const back = await rpc(USER, 'apm_day_return_reset', []);
  assert.ok(back.returned_at);
  const stored = (await admin(`select * from public.goal_plans where goal_id = '${GOAL}' and status = 'active'`)).rows[0];
  const entry = { record: { id: stored.id, goalId: GOAL, status: 'active', gateReviews: stored.gate_reviews ?? {}, startDate: stored.plan.startDate }, plan: stored.plan };
  // The plan kept its original start (day 11), and nothing was done yesterday: Never Miss Twice.
  const agenda = planning.composeAgenda({ date: today, state: 'missed_yesterday', plans: [entry], goals: [{ id: GOAL, title: 'lose 30 lbs', status: 'active', priority: 1 }], completions: [], morningSequence: [] });
  await svc('apm_service_day_check_in', [USER, today, 7, 'missed_yesterday', JSON.stringify(agenda)]);
  await rejects(rpc(USER, 'apm_set_day_phase', ['executing']), /loop_first_hour_not_started/, 'the stack opens only after the First Hour begins');
  assert.equal((await rpc(USER, 'apm_set_day_phase', ['first_hour'])).phase, 'first_hour');
  assert.equal((await rpc(USER, 'apm_set_day_phase', ['executing'])).phase, 'executing');
  assert.equal((await rpc(USER, 'apm_set_day_phase', ['first_hour'])).phase, 'executing', 'the phase never moves back');

  // A same-day Drafting Room rebuild (in place, 0036) keeps the locked agenda completable.
  const rebuilt = await svc('apm_service_save_goal_plan', [USER, GOAL, JSON.stringify(stored.plan), 'os_change']);
  assert.equal(rebuilt.id, stored.id);
  const priority = agenda.firstHour.priority;
  // 0038: if the plan changed BEFORE the lock, the stored plan governs; if it was rebuilt
  // AFTER the lock, the locked agenda stands even when the plan no longer offers the item
  // (the safety net under a failed body replan).
  const lockedAt = `(select checked_in_at from public.day_records where user_id = $2 and day = private.apm_local_today($2))`;
  await admin(`update public.goal_plans set plan = plan || '{"floors": [], "gates": [], "setup": []}'::jsonb, updated_at = ${lockedAt} - interval '1 minute' where id = $1`, [stored.id, USER]);
  await rejects(rpc(USER, 'apm_complete_plan_action', [priority.planId, priority.actionKey, null]), /loop_not_on_agenda/, 'a plan changed before the lock governs');
  await admin(`update public.goal_plans set updated_at = ${lockedAt} + interval '1 minute' where id = $1`, [stored.id, USER]);
  const completed = await rpc(USER, 'apm_complete_plan_action', [priority.planId, priority.actionKey, null]);
  assert.equal(completed.replayed, false, 'today’s locked agenda still completes after the rebuild');
  await admin(`update public.goal_plans set plan = $2::jsonb, updated_at = now() where id = $1`, [stored.id, JSON.stringify(stored.plan)]);

  // 0038: the body-safety replan is mandatory — never limited, never counted.
  await svc('apm_service_day_replan', [USER, today, 'external_change', 'Meeting moved', JSON.stringify(agenda)]);
  await svc('apm_service_day_replan', [USER, today, 'external_change', 'School closed', JSON.stringify(agenda)]);
  await rejects(svc('apm_service_day_body_replan', [USER, today, 'referral', JSON.stringify(agenda)]), /loop_no_referral/, 'only a real referral may use it');
  await rejects(rpc(USER, 'apm_service_day_body_replan', [USER, today, 'referral', JSON.stringify(agenda)]), /permission denied/);
  await rpc(USER, 'apm_flag_body_referral', ['diary']);
  const mandatory = await svc('apm_service_day_body_replan', [USER, today, 'referral', JSON.stringify(agenda)]);
  assert.equal(mandatory.replans.at(-1).mandatory, true);
  await svc('apm_service_day_replan', [USER, today, 'external_change', 'Third declared change', JSON.stringify(agenda)]);
  await rejects(svc('apm_service_day_replan', [USER, today, 'external_change', 'Fourth', JSON.stringify(agenda)]), /loop_replan_limit/, 'three declared replans, the mandatory one not counted');
  await rpc(USER, 'apm_record_clinician_clearance', []);
  assert.equal((await svc('apm_service_day_body_replan', [USER, today, 'clearance', JSON.stringify(agenda)])).replans.length, 5, 'beyond the cap');

  await rejects(rpc(USER, 'apm_service_day_reprint', [USER, today, JSON.stringify(agenda)]), /permission denied/, 'REPRINT is server-derived too');
  await rejects(svc('apm_service_day_reprint', [USER, today, JSON.stringify({ ...agenda, mode: agenda.mode === 'recovery' ? 'standard' : 'recovery' })]), /loop_invalid_agenda/, 'a reprint never changes scope');
  const reprinted = await svc('apm_service_day_reprint', [USER, today, JSON.stringify(agenda)]);
  assert.equal(reprinted.reprint_count, 1);
  for (let i = 0; i < 4; i += 1) await svc('apm_service_day_reprint', [USER, today, JSON.stringify(agenda)]);
  await rejects(svc('apm_service_day_reprint', [USER, today, JSON.stringify(agenda)]), /loop_reprint_limit/);
});

test('weekly review: governed, one per week, and the export covers every new record', async () => {
  const today = await localToday(USER);
  await rejects(rpc(USER, 'apm_save_weekly_review', [shift(today, 3), JSON.stringify({}), null]), /loop_invalid_request/, 'no future week');
  const review = await rpc(USER, 'apm_save_weekly_review', [shift(today, -6), JSON.stringify({ executionScore: { counted: 5 } }), 'Move the long walk to Saturday']);
  assert.equal(review.adjustment, 'Move the long walk to Saturday');
  const again = await rpc(USER, 'apm_save_weekly_review', [shift(today, -6), JSON.stringify({ executionScore: { counted: 6 } }), null]);
  assert.equal(again.id, review.id);
  await rejects(asRole('authenticated', USER, "insert into public.weekly_reviews (user_id, week_start, summary) values ($1, current_date, '{}')", [USER]), /permission denied/);
  await admin(`update public.subscription_entitlements set status = 'cancelled' where user_id = '${USER}'`);
  const exported = await rpc(USER, 'apm_daily_loop_data_rights_export', []);
  for (const key of ['diaryEntries', 'weeklyReviews', 'osChangeRequests', 'goalPlans', 'dayRecords']) assert.ok(exported[key].length > 0, key);
  assert.ok(Array.isArray(exported.planActionCompletions));
  assert.equal(exported.diaryEntries[0].body, 'Walking after lunch works for me', 'the export is the one place diary content leaves');
  await admin(`update public.subscription_entitlements set status = 'active' where user_id = '${USER}'`);
});
