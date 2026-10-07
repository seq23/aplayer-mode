// Executes the REAL migration chain 0001 → 0019 in an embedded Postgres
// (PGlite), seeds pre-0020 data (retired Tracks, an untimed Sprint, sessions),
// applies 0020 and proves, as the `authenticated` role:
//   * retired Tracks are removed and each one is on the record as a
//     `track.retired` audit event; they can never be inserted again, while the
//     seven current Tracks can;
//   * the Mode invariants hold for every writer, not just the API: Sprint
//     ≤ 14 days with a focus, Deep Work 15 min – 4 h with one task, untimed
//     setters cannot start either, and the post-sprint recovery day cannot be
//     skipped or edited away;
//   * a mode change without timing never inherits stale timing;
//   * coaching sessions carry the state-machine phase and a stopped session is
//     never open;
//   * the coaching model route is still `candidate` (no promotion without eval).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

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

let db;
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
const setMode = (userId, args) => as(userId,
  'select public.apm_set_mode_state($1, $2::timestamptz, $3::timestamptz, $4, $5::timestamptz, $6::jsonb)',
  [args.mode, args.startedAt ?? null, args.endsAt ?? null, args.focus ?? null, args.lockedUntil ?? null, args.resume ? JSON.stringify(args.resume) : null]);
const osRow = async (userId) => (await admin('select active_mode, mode_started_at, mode_ends_at, mode_focus, recovery_locked_until, mode_resume from public.personal_os where user_id = $1', [userId])).rows[0];
const iso = (offsetHours) => new Date(Date.now() + offsetHours * 3_600_000).toISOString();

test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.includes('0020_coaching_modes_and_tracks.sql'));
  for (const name of files.filter((file) => file < '0020')) await db.exec(await migration(name));

  // Pre-0020 data, written the way 0004/0006 allowed it.
  await admin(`insert into auth.users (id) values ('${USER_A}'), ('${USER_B}')`);
  await admin(`insert into public.personal_os (user_id, active_mode) values ('${USER_A}', 'standard'), ('${USER_B}', 'sprint')`);
  await admin(`insert into public.operating_modes (user_id, key, name, active, provenance_kind) values ('${USER_B}', 'sprint', 'Sprint', true, 'stated'), ('${USER_B}', 'standard', 'Standard', false, 'stated')`);
  await admin(`insert into public.tracks (user_id, key, name) values
    ('${USER_A}', 'manifestation_mastery', 'Manifestation Mastery'),
    ('${USER_A}', 'investor_ai_leverage', 'Investor + AI Leverage'),
    ('${USER_A}', 'operator_discipline', 'Operator Discipline'),
    ('${USER_B}', 'investor_ai_leverage', 'Investor + AI Leverage'),
    ('${USER_B}', 'resilience', 'Resilience')`);
  await admin(`insert into public.coaching_sessions (user_id, mode, status, turn_count) values ('${USER_A}', 'standard', 'open', 2), ('${USER_A}', 'recovery', 'closed', 5)`);

  await db.exec(await migration('0020_coaching_modes_and_tracks.sql'));
});

test('0020 retires the two Tracks on the record and keeps every other Track', async () => {
  const keys = (await admin('select user_id, key from public.tracks order by user_id, key')).rows.map((r) => `${r.user_id.slice(-1)}:${r.key}`);
  assert.deepEqual(keys, ['a:operator_discipline', 'b:resilience']);
  const audits = (await admin("select user_id, metadata from public.audit_events where event_type = 'track.retired' order by user_id, metadata->>'key'")).rows;
  assert.deepEqual(audits.map((a) => `${a.user_id.slice(-1)}:${a.metadata.key}`), ['a:investor_ai_leverage', 'a:manifestation_mastery', 'b:investor_ai_leverage']);
  assert.ok(audits.every((a) => a.metadata.review === true && a.metadata.name), 'flagged for the user’s review with the original name');

  for (const key of ['manifestation_mastery', 'investor_ai_leverage', 'made_up']) {
    await rejects(as(USER_A, 'insert into public.tracks (user_id, key, name) values ($1, $2, $3)', [USER_A, key, key]), /tracks_key_check/);
  }
  for (const key of ['billionaire_mindset', 'strategic_patience', 'resilience', 'body_foundation', 'wealth_foundation', 'home_front']) {
    await as(USER_A, 'insert into public.tracks (user_id, key, name) values ($1, $2, $3)', [USER_A, key, key]);
  }
  assert.equal(Number((await admin(`select count(*)::int n from public.tracks where user_id = '${USER_A}'`)).rows[0].n), 7);
});

test('Personal OS intake works again: operating_modes accepts the system provenance every writer uses', async () => {
  // Before 0020 the column default ('system') violated its own check, so the
  // 0004 intake RPC and the API's operating_modes upsert could never succeed.
  await admin(`insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000cc')`);
  await as('00000000-0000-4000-8000-0000000000cc', "select public.apm_save_methodology_intake($1::jsonb)", [JSON.stringify({
    display_name: 'Casey', roles: ['Studying / learning'], primary_goal: 'Pass the bar exam', track_keys: ['operator_discipline'], active_mode: 'standard',
    values: [], non_negotiables: [], failure_patterns: [], critical_pillars: [], minimum_floors: {}, weekly_cadence: { heavyDays: [], lightDays: [] },
    coaching_style: { firmness: 'direct' }, accountability: { dayStart: 'guided' },
  })]);
  const modes = (await admin("select key, provenance_kind from public.operating_modes where user_id = '00000000-0000-4000-8000-0000000000cc' order by key")).rows;
  assert.ok(modes.length >= 4 && modes.every((m) => m.provenance_kind === 'system'));
  await rejects(as('00000000-0000-4000-8000-0000000000cc', "select public.apm_save_methodology_intake($1::jsonb)", [JSON.stringify({ display_name: 'Casey', roles: [], primary_goal: 'x', track_keys: ['manifestation_mastery'] })]), /tracks_key_check/);
});

test('0020 returns untimed Sprint / Deep Work rows to Standard, on the record', async () => {
  const row = await osRow(USER_B);
  assert.equal(row.active_mode, 'standard');
  const modesB = (await admin(`select key, active from public.operating_modes where user_id = '${USER_B}' order by key`)).rows;
  assert.deepEqual(modesB, [{ key: 'sprint', active: false }, { key: 'standard', active: true }]);
  const audit = (await admin(`select metadata from public.audit_events where event_type = 'operating_mode.reset' and user_id = '${USER_B}'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].metadata.from, 'sprint');
});

test('Sprint and Deep Work invariants hold for every writer', async () => {
  await rejects(setMode(USER_A, { mode: 'sprint', startedAt: iso(0), endsAt: iso(15 * 24), focus: 'Chapter 3' }), /personal_os_mode_timing_check/);
  await rejects(setMode(USER_A, { mode: 'sprint', startedAt: iso(0), endsAt: iso(48) }), /personal_os_mode_timing_check/);
  await rejects(setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(5), focus: 'Draft' }), /personal_os_mode_timing_check/);
  await rejects(setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(0.1), focus: 'Draft' }), /personal_os_mode_timing_check/);
  await rejects(setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(1) }), /personal_os_mode_timing_check/);
  await rejects(setMode(USER_A, { mode: 'executive_review', startedAt: iso(0), resume: { mode: 'deep_work' } }), /mode_resume_check|check constraint/);
  await rejects(as(USER_A, "select public.apm_set_operating_mode('sprint')"), /mode_requires_duration/);
  await rejects(as(USER_A, "select public.apm_set_operating_mode('deep_work')"), /mode_requires_duration/);
  await rejects(as(USER_A, "update public.personal_os set active_mode = 'sprint' where user_id = $1", [USER_A]), /personal_os_mode_timing_check/);

  await setMode(USER_A, { mode: 'sprint', startedAt: iso(0), endsAt: iso(14 * 24), focus: 'Chapter 3' });
  assert.equal((await osRow(USER_A)).active_mode, 'sprint');
  const active = (await admin(`select key from public.operating_modes where user_id = '${USER_A}' and active`)).rows;
  assert.ok(active.every((r) => r.key === 'sprint'));
  await setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(4), focus: 'Draft the methods section', resume: { mode: 'sprint', endsAt: iso(14 * 24), focus: 'Chapter 3' } });
  assert.equal((await osRow(USER_A)).mode_resume.mode, 'sprint');
});

test('A mode change without timing never inherits the old timing', async () => {
  await setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(1), focus: 'Draft the abstract', resume: { mode: 'high_pressure' } });
  await as(USER_A, "select public.apm_set_operating_mode('high_pressure')");
  const row = await osRow(USER_A);
  assert.equal(row.active_mode, 'high_pressure');
  assert.equal(row.mode_ends_at, null); assert.equal(row.mode_focus, null); assert.equal(row.mode_resume, null);
  // The 0004 intake RPC path (direct upsert of active_mode) behaves the same way.
  await setMode(USER_A, { mode: 'deep_work', startedAt: iso(0), endsAt: iso(2), focus: 'Draft the abstract' });
  await as(USER_A, "update public.personal_os set active_mode = 'standard' where user_id = $1", [USER_A]);
  assert.equal((await osRow(USER_A)).mode_ends_at, null);
});

test('The post-sprint recovery day cannot be skipped, shortened or edited away', async () => {
  const lockedUntil = iso(30);
  await setMode(USER_A, { mode: 'recovery', startedAt: iso(0), endsAt: lockedUntil, lockedUntil, resume: { mode: 'standard' } });
  await rejects(setMode(USER_A, { mode: 'standard' }), /recovery_day_required/);
  await rejects(as(USER_A, "select public.apm_set_operating_mode('high_pressure')"), /recovery_day_required/);
  await rejects(as(USER_A, 'update public.personal_os set recovery_locked_until = null where user_id = $1', [USER_A]), /recovery_day_required/);
  await rejects(as(USER_A, "update public.personal_os set recovery_locked_until = now() where user_id = $1", [USER_A]), /recovery_day_required/);
  assert.equal((await osRow(USER_A)).active_mode, 'recovery');
  // Unrelated edits during the recovery day still work.
  await as(USER_A, "update public.personal_os set north_star = 'Finish strong' where user_id = $1", [USER_A]);

  // Once the day has passed, the API's reconcile can resume Standard.
  // Simulate the clock passing the lock (the guard refuses even the owner role while it is active).
  await rejects(admin(`update public.personal_os set recovery_locked_until = now() - interval '1 minute' where user_id = '${USER_A}'`), /recovery_day_required/);
  await admin('alter table public.personal_os disable trigger personal_os_mode_guard');
  await admin(`update public.personal_os set recovery_locked_until = now() - interval '1 minute', mode_ends_at = now() - interval '1 minute', mode_started_at = now() - interval '2 days' where user_id = '${USER_A}'`);
  await admin('alter table public.personal_os enable trigger personal_os_mode_guard');
  await setMode(USER_A, { mode: 'standard' });
  const row = await osRow(USER_A);
  assert.equal(row.active_mode, 'standard');
  assert.equal(row.recovery_locked_until, null);
});

test('Mode RPCs are own-row only and not callable anonymously', async () => {
  await setMode(USER_B, { mode: 'high_pressure', startedAt: iso(0) });
  assert.equal((await osRow(USER_A)).active_mode, 'standard', 'user B cannot touch user A');
  const grants = (await admin("select grantee from information_schema.routine_privileges where routine_name = 'apm_set_mode_state' and privilege_type = 'EXECUTE'")).rows.map((r) => r.grantee);
  assert.ok(grants.includes('authenticated'));
  assert.ok(!grants.includes('anon') && !grants.includes('PUBLIC'));
});

test('Coaching sessions carry the state-machine phase; a stopped session is never open', async () => {
  const rows = (await admin(`select status, phase, questions_asked, engine from public.coaching_sessions where user_id = '${USER_A}' order by turn_count`)).rows;
  assert.deepEqual(rows, [{ status: 'open', phase: 'exploring', questions_asked: 0, engine: 'scripted' }, { status: 'closed', phase: 'closed', questions_asked: 0, engine: 'scripted' }]);
  await rejects(as(USER_A, "insert into public.coaching_sessions (user_id, mode, status, phase) values ($1, 'standard', 'open', 'safety_stop')", [USER_A]), /coaching_sessions_phase_status_check/);
  await rejects(as(USER_A, "insert into public.coaching_sessions (user_id, mode) values ($1, 'chaos')", [USER_A]), /coaching_sessions_mode_check/);
  await rejects(as(USER_A, "insert into public.coaching_sessions (user_id, mode, deeper_rounds) values ($1, 'standard', 3)", [USER_A]), /check/);
  await as(USER_A, "insert into public.coaching_sessions (user_id, mode, status, phase) values ($1, 'standard', 'closed', 'safety_stop')", [USER_A]);
});

test('The coaching model route stays candidate: 0020 prepares, never promotes', async () => {
  const routes = (await admin('select route_id, status, policy_notes from public.model_routes order by route_id')).rows;
  assert.ok(routes.length >= 3);
  assert.ok(routes.every((r) => r.status !== 'approved'), 'no route is approved by a migration');
  const coachingRoute = routes.find((r) => r.route_id === 'or_apodex_1_1_mini_novita_free');
  assert.equal(coachingRoute.status, 'candidate');
  assert.match(coachingRoute.policy_notes, /coaching_v1/);
  assert.match(coachingRoute.policy_notes, /human review/);
});
