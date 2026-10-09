// Executes the REAL migration chain in PGlite and proves the 0023 contract:
//   * the Morning Trigger functions are service-role only;
//   * candidates = users whose LOCAL wake time arrived (≤ 4 h ago), with notifications
//     and the Morning Trigger on, a registered device, an entitlement and no push yet;
//   * the morning push is claimed exactly once per user per local day;
//   * a printed agenda never overwrites a checked-in or closed day, and only references
//     the user's own plans;
//   * the end-of-day close is validated, local-day, audited and keeps the carry item.
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
const U = (n) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const [EARLY, DUE, QUIETDEV, OFF, NODEVICE, CANCELLED] = [1, 2, 3, 4, 5, 6].map(U);

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
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
const service = (sql, params) => asRole('service_role', null, sql, params);
async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
}
const candidates = async (at) => (await service('select user_id::text, local_day::text from public.apm_service_morning_candidates($1::timestamptz, 50)', [at])).rows;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-morning-db-'));
  await build({ entryPoints: { planning: planningEntry }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  planning = await import(pathToFileURL(join(outDir, 'planning.js')).href);
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) await db.exec(await migration(name));
  const users = [EARLY, DUE, QUIETDEV, OFF, NODEVICE, CANCELLED];
  await admin(`insert into auth.users (id) values ${users.map((id) => `('${id}')`).join(', ')}`);
  // 0094: these users gave the consumer health data consent, so their mood is kept.
  await admin("insert into public.consent_records (user_id, kind, decision, policy_version) select u.id, 'consumer_health_data', 'granted', '2026-10-08' from auth.users u where not exists (select 1 from public.consent_records r where r.user_id = u.id and r.kind = 'consumer_health_data')");
  await admin(`update public.user_profiles set timezone = 'America/Chicago'`);
  await admin(`insert into public.personal_os (user_id, active_mode) values ${users.map((id) => `('${id}', 'standard')`).join(', ')}`);
  await admin(`insert into public.push_subscriptions (user_id, expo_push_token) values ${users.filter((id) => id !== NODEVICE).map((id) => `('${id}', 'ExponentPushToken[${id.slice(-3)}]')`).join(', ')}`);
  await admin(`update public.notification_preferences set wake_time = '06:30' where user_id = '${DUE}'`);
  await admin(`update public.notification_preferences set wake_time = '09:00' where user_id = '${EARLY}'`);
  await admin(`update public.notification_preferences set wake_time = '06:30', quiet_hours = '{"start":"22:00","end":"07:00"}' where user_id = '${QUIETDEV}'`);
  await admin(`update public.notification_preferences set wake_time = '06:30', morning_push_enabled = false where user_id = '${OFF}'`);
  await admin(`update public.notification_preferences set wake_time = '06:30' where user_id in ('${NODEVICE}', '${CANCELLED}')`);
  // 0044: beta is no longer granted to every account; these users hold a paid plan.
  await admin(`update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active'`);
  await admin(`update public.subscription_entitlements set status = 'cancelled' where user_id = '${CANCELLED}'`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('the Morning Trigger functions are service-role only', async () => {
  for (const role of ['authenticated', 'anon']) {
    await rejects(asRole(role, DUE, 'select * from public.apm_service_morning_candidates(now(), 10)'), /permission denied/);
    await rejects(asRole(role, DUE, "select public.apm_service_claim_notification($1, 'morning:2026-10-07', 't', 'b', '/today')", [DUE]), /permission denied/);
    await rejects(asRole(role, DUE, "select public.apm_service_print_agenda($1, current_date, '{}')", [DUE]), /permission denied/);
  }
});

test('candidates: local wake time reached within 6 h, settings respected, one push per local day', async () => {
  // 07:00 in Chicago (CDT, UTC-5) on 7 Oct 2026.
  const at = '2026-10-07T12:00:00Z';
  const rows = await candidates(at);
  assert.deepEqual(rows.map((r) => r.user_id).sort(), [DUE, QUIETDEV].sort(), 'not before wake time, not when off, not without a device or entitlement');
  assert.equal(rows[0].local_day, '2026-10-07');
  assert.deepEqual((await candidates('2026-10-07T11:00:00Z')).map((r) => r.user_id), [], '06:00 local: nobody is up yet');
  assert.ok((await candidates('2026-10-07T14:15:00Z')).some((r) => r.user_id === EARLY), '09:15 local');
  assert.ok((await candidates('2026-10-07T16:45:00Z')).some((r) => r.user_id === DUE), '5 h 15 after wake: still deliverable after a 4-hour Deep Work hold');
  assert.ok(!(await candidates('2026-10-07T18:45:00Z')).some((r) => r.user_id === DUE), 'more than 6 h after wake: missed, not sent mid-afternoon');

  const first = (await service("select public.apm_service_claim_notification($1, 'morning:2026-10-07', 'Your agenda is ready', 'Open APM to start the day.', '/today') id", [DUE])).rows[0].id;
  assert.ok(first);
  const second = (await service("select public.apm_service_claim_notification($1, 'morning:2026-10-07', 'Your agenda is ready', 'Open APM to start the day.', '/today') id", [DUE])).rows[0].id;
  assert.equal(second, null, 'claimed exactly once');
  assert.ok(!(await candidates(at)).some((r) => r.user_id === DUE), 'a claimed day is no longer a candidate');
  await rejects(service("select public.apm_service_claim_notification($1, 'radar:x', 't', 'b', '/today')", [DUE]), /loop_invalid_request/);
  // A failed delivery is retried by a later tick; a sent one never is.
  const retry = (await service("select public.apm_service_claim_notification($1, 'morning:2026-10-09', 't', 'b', '/today') id", [DUE])).rows[0].id;
  await service("select public.apm_service_finish_notification($1, 'failed', 'expo_http_503')", [retry]);
  assert.ok((await candidates('2026-10-09T12:00:00Z')).some((r) => r.user_id === DUE), 'a failed push is a candidate again');
  assert.equal((await service("select public.apm_service_claim_notification($1, 'morning:2026-10-09', 't', 'b', '/today') id", [DUE])).rows[0].id, retry, 'the same row is re-claimed');
  await admin("update public.notifications set created_at = now() - interval '11 minutes' where id = $1", [retry]);
  assert.ok((await candidates('2026-10-09T12:00:00Z')).some((r) => r.user_id === DUE), 'a claim abandoned mid-send is retried');
  await service("select public.apm_service_finish_notification($1, 'sent', null)", [first]);
  const row = (await admin('select status, sent_at from public.notifications where id = $1', [first])).rows[0];
  assert.equal(row.status, 'sent');
  assert.ok(row.sent_at);
  assert.equal((await admin(`select count(*)::int n from public.audit_events where event_type = 'notification.morning_trigger' and user_id = '${DUE}' and metadata->>'status' = 'sent'`)).rows[0].n, 1);
  assert.equal((await admin(`select count(*)::int n from public.audit_events where event_type = 'notification.morning_trigger' and user_id = '${DUE}' and metadata->>'status' = 'failed'`)).rows[0].n, 1);
  // The next local day is a new day.
  assert.ok((await candidates('2026-10-08T12:00:00Z')).some((r) => r.user_id === DUE));
});

test('a printed agenda never overwrites a checked-in or closed day and only names the user’s own plans', async () => {
  const today = (await admin('select private.apm_local_today($1)::text d', [DUE])).rows[0].d;
  const goal = (await admin(`insert into public.goals (user_id, title, status, health, priority, provenance_kind, source_type) values ('${DUE}', 'lose 30 lbs', 'active', 'unknown', 1, 'stated', 'manual') returning id`)).rows[0].id;
  const plan = planning.generateGoalPlan('lose 30 lbs', { roles: [], startDate: today });
  const stored = (await service('select public.apm_service_save_goal_plan($1, $2, $3, $4) r', [DUE, goal, JSON.stringify(plan), 'intake'])).rows[0].r;
  const agenda = planning.composeAgenda({ date: today, state: 'normal', plans: [{ record: { id: stored.id, goalId: goal, status: 'active', gateReviews: {}, startDate: today }, plan }], goals: [{ id: goal, title: 'lose 30 lbs', status: 'active', priority: 1 }], completions: [], morningSequence: [] });

  await rejects(service('select public.apm_service_print_agenda($1, $2::date, $3)', [QUIETDEV, today, JSON.stringify(agenda)]), /loop_invalid_agenda/, 'another user’s plan');
  await rejects(service('select public.apm_service_print_agenda($1, ($2::date - 1), $3)', [DUE, today, JSON.stringify({ ...agenda, date: planning.calendarDateInTimezone(new Date(Date.now() - 86_400_000), 'America/Chicago') })]), /loop_day_not_today/);
  assert.equal((await service('select public.apm_service_print_agenda($1, $2::date, $3) ok', [DUE, today, JSON.stringify(agenda)])).rows[0].ok, true);
  const printed = (await admin('select agenda_status, checked_in_at from public.day_records where user_id = $1 and day = $2::date', [DUE, today])).rows[0];
  assert.equal(printed.agenda_status, 'printed');
  assert.equal(printed.checked_in_at, null, 'printing never runs the Mood Gate for the user');

  const lowMood = planning.composeAgenda({ date: today, state: 'normal', mood: 2, plans: [{ record: { id: stored.id, goalId: goal, status: 'active', gateReviews: {}, startDate: today }, plan }], goals: [{ id: goal, title: 'lose 30 lbs', status: 'active', priority: 1 }], completions: [], morningSequence: [] });
  await service('select public.apm_service_day_check_in($1, $2::date, 2, $3, $4)', [DUE, today, 'normal', JSON.stringify(lowMood)]);
  assert.equal((await service('select public.apm_service_print_agenda($1, $2::date, $3) ok', [DUE, today, JSON.stringify(agenda)])).rows[0].ok, false);
  const locked = (await admin('select agenda_status, agenda->>$3 mode from public.day_records where user_id = $1 and day = $2::date', [DUE, today, 'mode'])).rows[0];
  assert.deepEqual(locked, { agenda_status: 'locked', mode: 'recovery' }, 'the check-in agenda stands');
});

test('the end-of-day close is validated, local-day, audited, and keeps one carry item', async () => {
  const call = (args) => asRole('authenticated', DUE, 'select public.apm_close_day_review($1, $2, $3, $4, $5, $6) r', args);
  const review = JSON.stringify([{ pillar: 'movement', score: 'hit', completed: 'Walked 10 minutes' }, { pillar: 'family', score: 'partial' }]);
  await rejects(call(['full_day', 'great', review, null, null, null]), /loop_invalid_request/);
  await rejects(call(['full_day', 'full_day', JSON.stringify([{ pillar: 'hobbies', score: 'hit' }]), null, null, null]), /loop_invalid_request/);
  await rejects(call(['full_day', 'full_day', JSON.stringify([{ pillar: 'movement', score: 'hit', user_id: OFF }]), null, null, null]), /loop_field_not_allowed/);
  await rejects(call(['full_day', 'full_day', review, null, 'x', null]), /loop_invalid_request/);
  await rejects(call(['mvd', 'full_day', review, null, null, null]), /loop_verdict_needs_evidence/, 'a win needs completion evidence');
  const today = (await admin('select private.apm_local_today($1)::text d', [DUE])).rows[0].d;
  const locked = (await admin('select agenda from public.day_records where user_id = $1 and day = $2::date', [DUE, today])).rows[0].agenda;
  await rejects(asRole('authenticated', DUE, 'select public.apm_complete_plan_action($1, $2, null)', [locked.firstHour.priority.planId, locked.firstHour.priority.actionKey]), /loop_first_hour_not_started/);
  await asRole('authenticated', DUE, "select public.apm_set_day_phase('first_hour')");
  await asRole('authenticated', DUE, 'select public.apm_complete_plan_action($1, $2, null)', [locked.firstHour.priority.planId, locked.firstHour.priority.actionKey]);
  const closed = (await call(['mvd', 'full_day', review, 'Long day', 'Call the bank about the card', 'Minimum Viable Day kept the chain.'])).rows[0].r;
  assert.equal(closed.day, (await admin('select private.apm_local_today($1)::text d', [DUE])).rows[0].d);
  assert.equal(closed.verdict, 'mvd');
  assert.equal(closed.computed_verdict, 'full_day');
  assert.equal(closed.carry_forward, 'Call the bank about the card');
  assert.equal(closed.pillar_review.length, 2);
  const audit = (await admin(`select metadata from public.audit_events where event_type = 'day.closed' and user_id = '${DUE}'`)).rows.at(-1).metadata;
  assert.deepEqual({ overridden: audit.overridden, carried: audit.carried }, { overridden: true, carried: true });
  await rejects(asRole('authenticated', DUE, 'update public.day_records set carry_forward = $1', ['Do everything twice']), /permission denied/);
  await rejects(call(['miss', 'miss', review, null, null, null]), /loop_day_closed/, 'a closed day stays closed');
});

test('a late wake time never claims the next day after midnight', async () => {
  await admin(`update public.notification_preferences set wake_time = '23:00' where user_id = '${EARLY}'`);
  assert.ok((await candidates('2026-10-08T04:10:00Z')).some((r) => r.user_id === EARLY && r.local_day === '2026-10-07'), '23:10 local on the 7th');
  assert.ok(!(await candidates('2026-10-08T05:15:00Z')).some((r) => r.user_id === EARLY), '00:15 local on the 8th belongs to no wake window');
  await admin(`update public.notification_preferences set wake_time = '09:00' where user_id = '${EARLY}'`);
});

test('wake time and Morning Trigger settings are constrained', async () => {
  await rejects(admin(`update public.notification_preferences set wake_time = '7am' where user_id = '${DUE}'`), /wake_time_check/);
  await rejects(admin(`update public.notification_preferences set wake_time = '24:00' where user_id = '${DUE}'`), /wake_time_check/);
  const defaults = (await admin(`select wake_time, morning_push_enabled from public.notification_preferences where user_id = '${EARLY}'`)).rows[0];
  assert.deepEqual(defaults, { wake_time: '09:00', morning_push_enabled: true });
});
