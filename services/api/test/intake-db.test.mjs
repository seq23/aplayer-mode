// Executes the REAL migration chain in PGlite and proves, as the `authenticated` role
// (anonymous sessions included) and the service role:
//   * 0060 migrates every stored legacy pillar key to its area without loss (settings,
//     goals, routines, plans, agendas, day reviews, OS-change records);
//   * the governed intake write: areas, critical, floors, pillar opt-out (the foreground
//     area stays), the profile (never the catch-all text), legacy payloads mapped, audited;
//   * intake_drafts: no direct writes, owner-only reads, per-question last-write-wins merge,
//     ownership of every RPC, size/shape limits; anon has no access;
//   * install idempotency (claim → in progress → done → replay; a failed start can retry);
//   * the anonymous-draft merge rule (§5 9c) and the maintenance sweep are service-only;
//   * the Founding 100 count is the server's number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = U(1); const B = U(2); const ANON = U(3); const LEGACY = U(4); const STALE = U(5); const C = U(6);

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb,
    is_anonymous boolean not null default false, last_sign_in_at timestamptz, created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
`;

let db;
async function admin(sql, params) { await db.exec('reset role'); return db.query(sql, params); }
async function asRole(role, userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ''}', true);`);
    return tx.query(sql, params);
  });
}
const call = (role, userId, fn, args = []) => asRole(role, userId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args).then((r) => r.rows[0].r);
const rpc = (userId, fn, args) => call('authenticated', userId, fn, args);
const svc = (fn, args) => call('service_role', null, fn, args);
async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
}
const draft = (answers, answeredAt, extra = {}) => JSON.stringify({ bankVersion: 2, version: 1, answers, answeredAt, cursor: 'season', updatedAt: Date.now(), ...extra });

test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const before = files.filter((name) => name < '0060');
  const after = files.filter((name) => name >= '0060');
  assert.ok(after.includes('0060_three_pillars_and_areas.sql') && after.includes('0061_intake_drafts.sql'));
  for (const name of before) await db.exec(await migration(name));
  // Legacy data written under the four-pillar model, BEFORE 0060 runs.
  await admin(`insert into auth.users (id) values ('${LEGACY}')`);
  await admin(`insert into public.pillar_settings (user_id, name, active, critical, minimum_floor) values
    ('${LEGACY}', 'execution', true, true, 'Send one decisive follow-up'),
    ('${LEGACY}', 'wealth', true, false, 'Move any amount to savings'),
    ('${LEGACY}', 'body', true, true, 'Walk 10 minutes'),
    ('${LEGACY}', 'spirit', true, false, '1 minute of prayer')`);
  await admin(`insert into public.goals (id, user_id, title, status, health, pillar, priority, provenance_kind, source_type) values
    ('${U(40)}', '${LEGACY}', 'lose 30 lbs', 'active', 'unknown', 'body', 1, 'stated', 'manual'),
    ('${U(41)}', '${LEGACY}', 'Gratitude every night', 'active', 'unknown', 'spirit', 2, 'stated', 'manual')`);
  await admin(`insert into public.routines (user_id, title, pillar) values ('${LEGACY}', 'Budget review', 'wealth')`);
  await admin(`insert into public.goal_plans (id, user_id, goal_id, plan_key, template_key, persona, foreground_pillar, start_date, end_date, plan)
    values ('${U(50)}', '${LEGACY}', '${U(40)}', 'p1', 'weight_loss', 'weight_loss', 'body', current_date, current_date + 89,
    '{"foreground": {"pillar": "body", "label": "Body"}, "actions": {"a": {"pillar": "body", "title": "Walk"}, "f": {"pillar": "family", "title": "Dinner"}}}')`);
  await admin(`insert into public.day_records (user_id, day, mode, verdict, pillar_review, agenda)
    values ('${LEGACY}', current_date - 1, 'standard', 'full_day', '[{"pillar": "execution", "score": "hit"}, {"pillar": "family", "score": "partial"}]',
    '{"firstHour": {"priority": {"pillar": "wealth", "title": "Save"}}, "dailyStack": [{"pillar": "body", "title": "Walk"}]}')`);
  await admin(`insert into public.os_change_requests (user_id, field, proposed, previous, status)
    values ('${LEGACY}', 'pillar', '{"name": "spirit", "critical": true, "minimumFloor": "Volunteer for 10 minutes"}', '{"user_id": "${LEGACY}", "name": "execution", "critical": false, "minimum_floor": null}', 'applied')`);
  for (const name of after) await db.exec(await migration(name));
  await admin(`insert into auth.users (id, is_anonymous) values ('${A}', false), ('${B}', false), ('${ANON}', true), ('${C}', false)`);
  await admin(`insert into auth.users (id, is_anonymous, last_sign_in_at, created_at) values ('${STALE}', true, now() - interval '40 days', now() - interval '40 days')`);
});

test('0060 migrates every stored legacy pillar key to its area, without loss', async () => {
  const settings = (await admin(`select name, pillar, critical, minimum_floor from public.pillar_settings where user_id = $1 order by name`, [LEGACY])).rows;
  assert.deepEqual(settings, [
    { name: 'faith', pillar: 'spirit', critical: false, minimum_floor: '1 minute of prayer' },
    { name: 'money', pillar: 'mind', critical: false, minimum_floor: 'Move any amount to savings' },
    { name: 'movement', pillar: 'body', critical: true, minimum_floor: 'Walk 10 minutes' },
    { name: 'work', pillar: 'mind', critical: true, minimum_floor: 'Send one decisive follow-up' },
  ], 'execution→work, wealth→money, body→movement, spirit→read from the floor text (prayer → faith)');
  assert.deepEqual((await admin(`select title, pillar from public.goals where user_id = $1 order by priority`, [LEGACY])).rows.map((r) => r.pillar), ['movement', 'gratitude']);
  assert.equal((await admin(`select pillar from public.routines where user_id = $1`, [LEGACY])).rows[0].pillar, 'money');
  const planRow = (await admin(`select foreground_pillar, plan from public.goal_plans where id = $1`, [U(50)])).rows[0];
  assert.equal(planRow.foreground_pillar, 'movement');
  assert.deepEqual([planRow.plan.foreground.pillar, planRow.plan.actions.a.pillar, planRow.plan.actions.f.pillar], ['movement', 'movement', 'family']);
  assert.equal(planRow.plan.actions.a.title, 'Walk', 'nothing else in the plan changes');
  const day = (await admin(`select pillar_review, agenda from public.day_records where user_id = $1`, [LEGACY])).rows[0];
  assert.deepEqual(day.pillar_review, [{ pillar: 'work', score: 'hit' }, { pillar: 'family', score: 'partial' }]);
  assert.equal(day.agenda.firstHour.priority.pillar, 'money');
  assert.equal(day.agenda.dailyStack[0].pillar, 'movement');
  const change = (await admin(`select proposed, previous from public.os_change_requests where user_id = $1`, [LEGACY])).rows[0];
  assert.equal(change.proposed.name, 'service', 'spirit + "Volunteer" → service');
  assert.equal(change.previous.name, 'work');
  // Idempotent: re-running the mapper on area keys changes nothing.
  assert.equal((await admin(`select private.apm_legacy_area('family', null) a`)).rows[0].a, 'family');
  assert.equal((await admin(`select private.apm_legacy_area('meditation', 'pray') a`)).rows[0].a, 'meditation');
});

const INTAKE = (extra = {}) => JSON.stringify({
  display_name: '', roles: ['Founder / entrepreneur', 'Parent / caregiver'], primary_goal: 'Get 10 paying customers', pillar: 'work',
  values: [], non_negotiables: ['Family dinner'], failure_patterns: [], weekly_cadence: { heavyDays: [], lightDays: [] },
  coaching_style: { firmness: 'high_pressure' }, accountability: { dayStart: 'guided' },
  critical_pillars: ['work', 'family'], minimum_floors: { work: 'Send one decisive follow-up', family: 'One protected family touchpoint (20 min, phone away)', movement: 'Walk 10 minutes' },
  active_areas: ['work', 'money', 'mental_health', 'movement', 'meditation', 'family'], pillars_enabled: ['mind', 'body', 'spirit'],
  track_keys: ['billionaire_mindset', 'operator_discipline'], active_mode: 'standard',
  intake_profile: { bankVersion: 2, games: ['founder', 'parent'], quickStart: false, spiritPractices: ['meditation', 'family_time'] },
  ...extra,
});

test('the governed intake write: areas, critical, floors, profile; the pillar column rolls up; audited', async () => {
  await rpc(A, 'apm_save_methodology_intake', [INTAKE()]);
  const rows = (await admin(`select name, pillar, active, critical, minimum_floor from public.pillar_settings where user_id = $1 order by name`, [A])).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.pillar, r.active, r.critical]), [
    ['family', 'spirit', true, true], ['meditation', 'spirit', true, false], ['mental_health', 'mind', true, false],
    ['money', 'mind', true, false], ['movement', 'body', true, false], ['work', 'mind', true, true],
  ]);
  assert.equal(rows.find((r) => r.name === 'movement').minimum_floor, 'Walk 10 minutes');
  const os = (await admin(`select pillars_enabled, intake_profile from public.personal_os where user_id = $1`, [A])).rows[0];
  assert.deepEqual(os.pillars_enabled, ['mind', 'body', 'spirit']);
  assert.deepEqual(os.intake_profile.spiritPractices, ['meditation', 'family_time']);
  assert.equal((await admin(`select pillar from public.goals where user_id = $1 and priority = 1`, [A])).rows[0].pillar, 'work');
  assert.equal(Number((await admin(`select count(*) n from public.audit_events where user_id = $1 and event_type = 'personal_os.intake_saved'`, [A])).rows[0].n), 1);
});

test('opting out of a pillar switches its areas off; the foreground area stays on', async () => {
  await rpc(A, 'apm_save_methodology_intake', [INTAKE({ pillars_enabled: ['body', 'spirit'] })]);
  const rows = Object.fromEntries((await admin(`select name, active from public.pillar_settings where user_id = $1`, [A])).rows.map((r) => [r.name, r.active]));
  assert.equal(rows.work, true, 'her #1 goal lives in Mind: work stays on');
  assert.equal(rows.money, false);
  assert.equal(rows.mental_health, false);
  assert.equal(rows.movement, true);
  assert.deepEqual((await admin(`select pillars_enabled from public.personal_os where user_id = $1`, [A])).rows[0].pillars_enabled, ['body', 'spirit']);
  assert.equal(Number((await admin(`select count(*) n from public.audit_events where user_id = $1 and event_type = 'personal_os.reinstalled'`, [A])).rows[0].n), 1);
});

test('the intake write refuses unknown areas, a catch-all in the profile, and anonymous callers without a session', async () => {
  await rejects(rpc(A, 'apm_save_methodology_intake', [INTAKE({ active_areas: ['career'] })]), /invalid_area/);
  await rejects(rpc(A, 'apm_save_methodology_intake', [INTAKE({ critical_pillars: ['hobbies'] })]), /invalid_area/);
  await rejects(rpc(A, 'apm_save_methodology_intake', [INTAKE({ intake_profile: { catchAll: 'private worries' } })]), /invalid_payload/);
  await rejects(rpc(A, 'apm_save_methodology_intake', [INTAKE({ pillars_enabled: ['soul'] })]), /invalid_pillar/);
  await rejects(call('authenticated', null, 'apm_save_methodology_intake', [INTAKE()]), /unauthorized/);
  await rejects(call('anon', null, 'apm_save_methodology_intake', [INTAKE()]), /permission denied/);
});

test('older clients: a legacy payload (four pillar keys, no areas) still installs, mapped', async () => {
  await rpc(C, 'apm_save_methodology_intake', [JSON.stringify({ display_name: 'Ben', roles: ['Career'], primary_goal: 'Get promoted at work', pillar: 'execution', values: [], non_negotiables: [], failure_patterns: [], critical_pillars: ['execution', 'body'], minimum_floors: { body: 'Walk 10 minutes', spirit: 'Pray for 1 minute' } })]);
  const rows = (await admin(`select name, critical, minimum_floor from public.pillar_settings where user_id = $1 order by name`, [C])).rows;
  assert.deepEqual(rows.map((r) => r.name), ['faith', 'meditation', 'money', 'movement', 'work'].filter((n) => rows.some((r) => r.name === n)));
  assert.equal(rows.find((r) => r.name === 'movement').critical, true);
  assert.equal(rows.find((r) => r.name === 'work').critical, true);
  assert.equal(rows.find((r) => r.name === 'faith')?.minimum_floor, 'Pray for 1 minute', 'spirit floor text → faith');
  assert.equal((await admin(`select pillar from public.goals where user_id = $1`, [C])).rows[0].pillar, 'work');
});

test('intake_drafts: RPC-only writes, owner-only reads, anon locked out', async () => {
  await rejects(asRole('authenticated', A, `insert into public.intake_drafts (user_id) values ($1)`, [A]), /permission denied/);
  const saved = await rpc(A, 'apm_save_intake_draft', [draft({ games: ['founder'], season: 'building' }, { games: 10, season: 11 })]);
  assert.deepEqual(saved.answers, { games: ['founder'], season: 'building' });
  await rejects(asRole('authenticated', A, `update public.intake_drafts set answers = '{}'`), /permission denied/);
  await rejects(asRole('authenticated', A, `delete from public.intake_drafts`), /permission denied/);
  assert.equal((await asRole('authenticated', A, 'select count(*)::int n from public.intake_drafts')).rows[0].n, 1);
  assert.equal((await asRole('authenticated', B, 'select count(*)::int n from public.intake_drafts')).rows[0].n, 0, 'B never sees A');
  assert.equal(await rpc(B, 'apm_get_intake_draft', []), null, 'B gets nothing back');
  assert.equal((await rpc(A, 'apm_get_intake_draft', [])).cursor, 'season');
  await rejects(call('anon', null, 'apm_get_intake_draft'), /permission denied/);
  await rejects(call('anon', null, 'apm_save_intake_draft', [draft({}, {})]), /permission denied/);
  await rejects(asRole('anon', null, 'select * from public.intake_drafts'), /permission denied/);
  assert.equal(Number((await admin(`select count(*) n from public.audit_events where user_id = $1 and event_type = 'intake_draft.created'`, [A])).rows[0].n), 1);
});

test('drafts merge per question, last write wins; older answers never overwrite newer; shape and size are checked', async () => {
  // Offline phone answered load later; a stale copy of season arrives late.
  await rpc(A, 'apm_save_intake_draft', [draft({ load: 8, season: 'recovering' }, { load: 20, season: 5 })]);
  const merged = await rpc(A, 'apm_get_intake_draft', []);
  assert.deepEqual(merged.answers, { games: ['founder'], season: 'building', load: 8 });
  // A cleared answer on the newer copy is removed.
  await rpc(A, 'apm_save_intake_draft', [draft({}, { load: 30 })]);
  assert.equal((await rpc(A, 'apm_get_intake_draft', [])).answers.load, undefined);
  await rejects(rpc(A, 'apm_save_intake_draft', [draft({ 'Bad Key': 1 }, {})]), /intake_invalid_draft/);
  await rejects(rpc(A, 'apm_save_intake_draft', [draft({}, {}, { cursor: 'x; drop' })]), /intake_invalid_draft/);
  await rejects(rpc(A, 'apm_save_intake_draft', [draft({ catchall: 'x'.repeat(70000) }, { catchall: 40 })]), /intake_invalid_draft/);
  await rejects(rpc(A, 'apm_save_intake_draft', [JSON.stringify({ answers: {} })]), /intake_invalid_draft/);
});

test('install idempotency: claim, in progress, done, replay; a failed start can be retried; per user', async () => {
  assert.equal(await rpc(A, 'apm_claim_intake_install', ['intake-v7']), 'claimed');
  assert.equal(await rpc(A, 'apm_claim_intake_install', ['intake-v7']), 'in_progress');
  assert.equal(await rpc(B, 'apm_claim_intake_install', ['intake-v7']), 'claimed', 'keys are per user');
  await rpc(A, 'apm_finish_intake_install', ['intake-v7', true, 7]);
  assert.equal(await rpc(A, 'apm_claim_intake_install', ['intake-v7']), 'replay');
  const row = (await admin(`select status, installed_version from public.intake_drafts where user_id = $1`, [A])).rows[0];
  assert.deepEqual(row, { status: 'installed', installed_version: 7 });
  await rpc(B, 'apm_finish_intake_install', ['intake-v7', false, 7]);
  assert.equal(await rpc(B, 'apm_claim_intake_install', ['intake-v7']), 'claimed', 'a failed install can be retried');
  await rejects(rpc(B, 'apm_finish_intake_install', ['never-claimed', true, 1]), /intake_install_not_claimed/);
  await rejects(rpc(A, 'apm_claim_intake_install', ['bad key!']), /intake_invalid_key/);
  await rejects(call('anon', null, 'apm_claim_intake_install', ['intake-v1']), /permission denied/);
});

test('anonymous sessions use the same RPCs; the merge into an account follows §5 9c; service role only', async () => {
  await rpc(ANON, 'apm_save_intake_draft', [draft({ games: ['weight'], goal: 'lose_weight' }, { games: 1, goal: 2 })]);
  await rejects(rpc(ANON, 'apm_service_merge_anonymous_draft', [ANON, B]), /permission denied/);
  await rejects(rpc(B, 'apm_service_merge_anonymous_draft', [ANON, B]), /permission denied/);
  // B has no installed OS → the anonymous draft becomes B's draft.
  await admin(`delete from public.intake_drafts where user_id = $1`, [B]);
  assert.deepEqual(await svc('apm_service_merge_anonymous_draft', [ANON, B]), { outcome: 'draft' });
  const b = await rpc(B, 'apm_get_intake_draft', []);
  assert.deepEqual(b.answers, { games: ['weight'], goal: 'lose_weight' });
  assert.equal(b.status, 'open');
  assert.equal(await rpc(ANON, 'apm_get_intake_draft', []), null, 'the anonymous copy is gone');
  // A (installed OS) keeps its OS; new answers wait as an Edit-my-OS draft.
  await rpc(ANON, 'apm_save_intake_draft', [draft({ season: 'launching' }, { season: 99999999999 })]);
  assert.deepEqual(await svc('apm_service_merge_anonymous_draft', [ANON, A]), { outcome: 'pending_edit' });
  const a = await rpc(A, 'apm_get_intake_draft', []);
  assert.equal(a.status, 'pending_edit');
  assert.equal(a.answers.season, 'launching');
  assert.equal(Number((await admin(`select count(*) n from public.audit_events where user_id = $1 and event_type = 'intake_draft.merged'`, [A])).rows[0].n), 1);
  assert.deepEqual(await svc('apm_service_merge_anonymous_draft', [ANON, A]), { outcome: 'nothing_to_merge' });
});

test('maintenance (service only): installed drafts after 30 days; idle anonymous users listed for deletion', async () => {
  await admin(`update public.intake_drafts set status = 'installed', installed_at = now() - interval '31 days' where user_id = $1`, [B]);
  await rejects(rpc(A, 'apm_service_intake_maintenance', []), /permission denied/);
  const result = await svc('apm_service_intake_maintenance', []);
  assert.equal(result.deletedDrafts, 1);
  assert.deepEqual(result.staleAnonymous, [STALE], 'only the idle anonymous user; never a real account or an active anonymous one');
});

test('Founding 100: spots left is the server count of claimed slots (0044: viewing reserves nothing), service role only', async () => {
  assert.equal(await svc('apm_service_billing_founding_spots_left', []), 100);
  await admin(`insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at) values (1, $1, 'claimed', now()), (2, $2, 'claimed', now())`, [A, B]);
  assert.equal(await svc('apm_service_billing_founding_spots_left', []), 98);
  await rejects(rpc(A, 'apm_service_billing_founding_spots_left', []), /permission denied/);
});
test('answers given after install update the profile only from Day 8 (Week-1 rules); never free text', async () => {
  // C installed (legacy test above) today: Week 1 holds the update.
  await admin(`update public.personal_os set stabilization_started_at = private.apm_local_today($1) where user_id = $1`, [C]);
  await rejects(rpc(C, 'apm_update_intake_profile', [JSON.stringify({ bankVersion: 2, games: ['operator'], deferredQuestionIds: [] })]), /loop_week_one_lock/);
  await admin(`update public.personal_os set stabilization_started_at = private.apm_local_today($1) - 8 where user_id = $1`, [C]);
  assert.deepEqual(await rpc(C, 'apm_update_intake_profile', [JSON.stringify({ bankVersion: 2, games: ['operator'], deferredQuestionIds: ['heavy'] })]), { updated: true });
  assert.deepEqual((await admin(`select intake_profile from public.personal_os where user_id = $1`, [C])).rows[0].intake_profile.games, ['operator']);
  await rejects(rpc(C, 'apm_update_intake_profile', [JSON.stringify({ catchAll: 'private' })]), /invalid_payload/);
  await rejects(rpc(STALE, 'apm_update_intake_profile', [JSON.stringify({ bankVersion: 2 })]), /personal_os_missing/, 'only her own OS, and only once installed');
  await rejects(call('anon', null, 'apm_update_intake_profile', [JSON.stringify({ bankVersion: 2 })]), /permission denied/);
  assert.equal(Number((await admin(`select count(*) n from public.audit_events where user_id = $1 and event_type = 'personal_os.profile_updated'`, [C])).rows[0].n), 1);
});
