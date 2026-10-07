// Full-chain proof of migration 0043 (backend review, 7 Oct 2026): no client can write
// around a governed function. Covers forged audit rows, a direct Personal OS PATCH that
// skipped the Week-1 lock and the body referral stop, self-completed / self-deleted
// data-rights jobs, the erasure processor's DB steps, the action ledger (idempotent
// prepare, single claim, forward-only status) and the export registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

const A = U(11); const B = U(12);
let h; let outDir; let auditModule;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-write-surface-'));
  await build({ entryPoints: { audit: fileURLToPath(new URL('../src/audit.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  auditModule = await import(pathToFileURL(join(outDir, 'audit.js')).href);
  h = await realChain();
  await h.admin(`insert into auth.users (id) values ('${A}'), ('${B}')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

// Every public table a signed-in client may still write directly. Anything not on this
// list is written only through a governed function; adding a table here is a decision.
const CLIENT_WRITABLE = [
  'ai_usage_events', 'analytics_events', 'calendar_events', 'coaching_sessions', 'coaching_turns', 'commitments', 'goals',
  'household_items', 'household_members', 'households', 'integration_connections', 'message_signals', 'milestones',
  'notification_preferences', 'notifications', 'operating_modes', 'people', 'permissions', 'preferences', 'product_interests',
  'projects', 'push_subscriptions', 'roles', 'routines', 'rules', 'user_profiles',
];

test('the client write surface is exactly the allow-list; governed tables are not on it', async () => {
  const rows = (await h.admin(`select distinct c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE'))
      and exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                   and p.cmd in ('INSERT','UPDATE','DELETE','ALL') and ('authenticated' = any(p.roles) or 'public' = any(p.roles)))
    order by 1`)).rows.map((r) => r.t);
  assert.deepEqual(rows, CLIENT_WRITABLE);
  for (const governed of ['audit_events', 'personal_os', 'tracks', 'pillar_settings', 'data_rights_jobs', 'actions', 'action_attempts']) {
    assert.ok(!rows.includes(governed), `${governed} is governed`);
  }
});

test('a user cannot forge an audit row; the Worker records only allow-listed events through the service role', async () => {
  await rejects(h.as(A, "insert into public.audit_events (user_id, event_type, actor_type, actor_ref) values ($1, 'billing.refund', 'system', 'revenuecat')", [A]), /permission denied/);
  await rejects(h.as(A, "update public.audit_events set event_type = 'x' where user_id = $1", [A]), /permission denied/);
  await rejects(h.as(A, "select public.apm_service_record_audit($1, 'permission.changed', 'user', null, null, '{}')", [A]), /permission denied/);
  const record = (event, actor) => h.service("select public.apm_service_record_audit($1, $2, $3, 'personal_os', $4, '{}'::jsonb)", [A, event, actor, A]);
  // The TypeScript list and the SQL list are the same list.
  for (const event of auditModule.WORKER_AUDIT_EVENTS.user) await record(event, 'user');
  for (const event of auditModule.WORKER_AUDIT_EVENTS.system) await record(event, 'system');
  const source = (await h.admin("select prosrc from pg_proc where proname = 'apm_service_record_audit' and pronamespace = 'private'::regnamespace")).rows[0].prosrc;
  const list = (actor) => [...source.match(new RegExp(`p_actor_type = '${actor}' and p_event_type not in \\(([^)]*)\\)`))[1].matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
  assert.deepEqual(list('user'), [...auditModule.WORKER_AUDIT_EVENTS.user]);
  assert.deepEqual(list('system'), [...auditModule.WORKER_AUDIT_EVENTS.system]);
  // Nothing else, and never a billing / autopilot / connector actor.
  await rejects(record('billing.refund', 'system'), /audit_event_not_allowed/);
  await rejects(record('coaching.safety_stop', 'user'), /audit_event_not_allowed/);
  await rejects(record('permission.changed', 'connector'), /audit_event_not_allowed/);
  const row = (await h.admin("select actor_type, actor_ref from public.audit_events where user_id = $1 and event_type = 'coaching.safety_stop'", [A])).rows[0];
  assert.deepEqual(row, { actor_type: 'system', actor_ref: 'worker' });
});

const intake = (extra = {}) => JSON.stringify({
  display_name: 'Ana', roles: ['Founder'], primary_goal: 'Ship the MVP to ten users', values: [], non_negotiables: [], failure_patterns: [],
  weekly_cadence: { heavyDays: [], lightDays: [] }, coaching_style: { firmness: 'direct' }, accountability: { dayStart: 'guided' },
  critical_pillars: ['execution'], minimum_floors: { execution: '20 minutes' },
  tracks: [{ key: 'billionaire_mindset', name: 'Billionaire High Performance Coach Track' }, { key: 'home_front', name: 'Home Front Track' }],
  active_mode: 'standard', morning_sequence: ['Water'], scheduling_preference: 'strict_blocks', hard_boundaries: ['No work after 18:00'],
  scoring_config: { enabled: true, showSevenDaySnapshot: false }, ...extra,
});

test('Personal OS: a direct PATCH cannot skip the Week-1 lock or the body referral stop; the governed intake writes everything', async () => {
  await h.as(A, 'select public.apm_save_methodology_intake($1::jsonb)', [intake()]);
  const os = (await h.admin('select morning_sequence, scheduling_preference, hard_boundaries, scoring_config, stabilization_started_at::text s from public.personal_os where user_id = $1', [A])).rows[0];
  assert.deepEqual([os.morning_sequence, os.scheduling_preference, os.hard_boundaries, os.scoring_config], [['Water'], 'strict_blocks', ['No work after 18:00'], { enabled: true, showSevenDaySnapshot: false }]);
  const tracks = (await h.admin('select key, name from public.tracks where user_id = $1 order by key', [A])).rows;
  assert.deepEqual(tracks, [{ key: 'billionaire_mindset', name: 'Billionaire High Performance Coach Track' }, { key: 'home_front', name: 'Home Front Track' }]);
  assert.equal((await h.admin('select count(*)::int n from public.operating_modes where user_id = $1', [A])).rows[0].n, 6);
  assert.equal((await h.admin('select private.apm_loop_week_one_locked($1) l', [A])).rows[0].l, true);

  await h.admin("update public.personal_os set body_referral_at = now(), body_referral_source = 'diary' where user_id = $1", [A]);
  await rejects(h.as(A, "update public.personal_os set north_star = 'x', stabilization_started_at = current_date - 30, body_referral_at = null where user_id = $1", [A]), /permission denied/);
  await rejects(h.as(A, "insert into public.tracks (user_id, key, name) values ($1, 'resilience', 'r')", [A]), /permission denied/);
  await rejects(h.as(A, "delete from public.pillar_settings where user_id = $1", [A]), /permission denied/);
  // Re-running the intake never touches the governed columns.
  await h.as(A, 'select public.apm_save_methodology_intake($1::jsonb)', [intake({ stabilization_started_at: '2020-01-01', body_referral_at: null })]);
  const after = (await h.admin('select stabilization_started_at::text s, body_referral_at is not null as flagged from public.personal_os where user_id = $1', [A])).rows[0];
  assert.deepEqual(after, { s: os.s, flagged: true });
  assert.equal((await h.admin('select private.apm_loop_week_one_locked($1) l', [A])).rows[0].l, true);
  await rejects(h.as(A, 'select public.apm_save_methodology_intake($1::jsonb)', [intake({ tracks: [{ key: 'not_a_track', name: 'x' }] })]), /tracks_key_check/);
  // The mode writers still work for the owner, through the definer functions.
  await h.as(A, "select public.apm_set_operating_mode('high_pressure')");
  assert.equal((await h.admin('select active_mode from public.personal_os where user_id = $1', [A])).rows[0].active_mode, 'high_pressure');
  const definers = (await h.admin(`select proname, prosecdef, proconfig from pg_proc where pronamespace = 'private'::regnamespace
    and proname in ('apm_save_methodology_intake','apm_set_mode_state','apm_set_operating_mode') order by proname`)).rows;
  assert.deepEqual(definers.map((d) => [d.proname, d.prosecdef, d.proconfig]), [
    ['apm_save_methodology_intake', true, ['search_path=""']], ['apm_set_mode_state', true, ['search_path=""']], ['apm_set_operating_mode', true, ['search_path=""']],
  ]);
});

test('data rights: users request, never complete or erase a job; the processor erases and leaves a receipt', async () => {
  await rejects(h.as(B, "insert into public.data_rights_jobs (user_id, job_type) values ($1, 'delete')", [B]), /permission denied/);
  const job = (await h.as(B, "select public.apm_request_data_rights('delete') j")).rows[0].j;
  assert.equal(job.status, 'requested');
  assert.equal((await h.as(B, "select public.apm_request_data_rights('delete') j")).rows[0].j.id, job.id, 'one open erasure request');
  await rejects(h.as(B, "update public.data_rights_jobs set status = 'complete' where id = $1", [job.id]), /permission denied/);
  await rejects(h.as(B, 'delete from public.data_rights_jobs where id = $1', [job.id]), /permission denied/);
  assert.equal((await h.admin("select count(*)::int n from public.audit_events where user_id = $1 and event_type = 'deletion.requested'", [B])).rows[0].n, 1);
  for (const fn of ['apm_service_data_rights_claim_deletions(5)', 'apm_service_data_rights_overdue(24)']) {
    await rejects(h.as(B, `select public.${fn}`), /permission denied/);
  }

  // Overdue: the named stop counts an open request older than the window.
  await h.admin("update public.data_rights_jobs set requested_at = now() - interval '30 hours' where id = $1", [job.id]);
  assert.equal((await h.service('select public.apm_service_data_rights_overdue(24) n')).rows[0].n, 1);

  await h.admin(`insert into public.integration_connections (user_id, provider, kind, external_account_id, encrypted_credentials, credential_iv) values ('${B}', 'google', 'email', 'b@x', 'cipher', 'iv')`);
  await h.admin(`insert into public.analytics_events (user_id, event_name) values ('${B}', 'daily_plan_viewed')`);
  const claimed = (await h.service('select public.apm_service_data_rights_claim_deletions(5) c')).rows[0].c;
  assert.deepEqual(claimed.map((c) => [c.jobId, c.userId, c.connections.length]), [[job.id, B, 1]]);
  assert.deepEqual((await h.service('select public.apm_service_data_rights_claim_deletions(5) c')).rows[0].c, [], 'claimed once');
  // A failed attempt goes back to requested with its code, and is retried later.
  await h.service("select public.apm_service_data_rights_fail($1, 'google_revoke_failed:500')", [job.id]);
  assert.deepEqual((await h.admin('select status, failure_code from public.data_rights_jobs where id = $1', [job.id])).rows[0], { status: 'requested', failure_code: 'google_revoke_failed:500' });
  await h.admin("update public.data_rights_jobs set claimed_at = now() - interval '2 hours' where id = $1", [job.id]);
  assert.equal((await h.service('select public.apm_service_data_rights_claim_deletions(5) c')).rows[0].c.length, 1);

  await h.service("select public.apm_service_data_rights_purge($1, '{\"connectors\":{}}'::jsonb)", [job.id]);
  assert.equal((await h.admin('select count(*)::int n from public.analytics_events where user_id = $1', [B])).rows[0].n, 0);
  assert.equal((await h.admin('select count(*)::int n from public.integration_connections where user_id = $1 and encrypted_credentials is not null', [B])).rows[0].n, 0);
  await rejects(h.service("select public.apm_service_data_rights_finish($1, '{}'::jsonb)", [job.id]), /data_rights_identity_still_exists/);
  await h.admin('delete from auth.users where id = $1', [B]); // what the Auth admin API does
  const done = (await h.service("select public.apm_service_data_rights_finish($1, '{}'::jsonb) r", [job.id])).rows[0].r;
  assert.equal(done.status, 'complete');
  assert.equal((await h.admin('select count(*)::int n from public.data_rights_jobs where user_id = $1', [B])).rows[0].n, 0, 'cascade');
  assert.equal((await h.admin("select status from private.data_rights_erasures where job_id = $1", [job.id])).rows[0].status, 'complete', 'receipt kept');
  await rejects(h.as(A, 'select * from private.data_rights_erasures'), /permission denied/);
  await h.admin(`insert into auth.users (id) values ('${B}')`);
});

const prepare = (key, payload = { title: 'Lunch' }) => h.service(
  "select public.apm_service_action_prepare($1, 'calendar', 'calendar.create', $2::jsonb, 'Book lunch', null, $3) r", [A, JSON.stringify(payload), key]);

test('actions: prepare is idempotent and never resets; one claim wins; status never moves backwards', async () => {
  await rejects(h.as(A, "insert into public.actions (user_id, domain, action_type, reason, idempotency_key, status) values ($1, 'email', 'email.send', 'x', 'key-00000001', 'prepared')", [A]), /permission denied/);
  await rejects(h.as(A, "select public.apm_service_action_prepare($1, 'calendar', 'calendar.create', '{}'::jsonb, 'Book lunch', null, 'key-12345678')", [A]), /permission denied/);
  const first = (await prepare('key-12345678')).rows[0].r;
  assert.equal(first.replayed, false);
  const id = first.action.id;
  const claim = () => h.service('select public.apm_service_action_claim($1, $2) r', [A, id]);
  assert.equal((await claim()).rows[0].r.status, 'executing');
  await rejects(claim(), /action_invalid_state/); // the double tap
  await h.service("select public.apm_service_action_result($1, $2, 'verified', 'google', 'evt-1', null)", [A, id]);
  // A client retry of prepare after execution returns the verified row, unchanged.
  const retry = (await prepare('key-12345678')).rows[0].r;
  assert.deepEqual([retry.replayed, retry.action.id, retry.action.status], [true, id, 'verified']);
  await rejects(prepare('key-12345678', { title: 'Dinner' }), /action_idempotency_conflict/);
  await rejects(claim(), /action_invalid_state/);
  await rejects(h.admin("update public.actions set status = 'prepared' where id = $1", [id]), /action_status_backwards/);
  await rejects(h.admin("update public.actions set payload = '{}'::jsonb where id = $1", [id]), /action_frozen/);
  await rejects(prepare('autopilot:anything-1'), /action_key_reserved/);
  await rejects(h.service("select public.apm_service_action_result($1, $2, 'verified', 'google', 'evt-2', null)", [A, id]), /action_invalid_state/);
  const audits = (await h.admin("select event_type, actor_type from public.audit_events where object_id = $1 order by created_at, event_type", [id])).rows.map((r) => r.event_type);
  assert.deepEqual(audits.sort(), ['action.approved', 'action.executed', 'action.prepared']);
  // A failed execution is audited too.
  const second = (await prepare('key-87654321')).rows[0].r.action.id;
  await h.service('select public.apm_service_action_claim($1, $2)', [A, second]);
  await h.service("select public.apm_service_action_result($1, $2, 'failed', 'google', null, 'gmail_action_failed:500')", [A, second]);
  assert.equal((await h.admin("select count(*)::int n from public.audit_events where object_id = $1 and event_type = 'action.failed'", [second])).rows[0].n, 1);
});

test('export: the registry covers every table with a user column; the export carries coaching turns and redacts secrets', async () => {
  const userTables = (await h.admin(`select distinct c.table_schema || '.' || c.table_name || ':' || c.column_name as k
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema in ('public','private') and c.column_name in ('user_id','created_by','assigned_user_id')`)).rows.map((r) => r.k)
    // The erasure receipt exists only after the account is gone: there is no one to export it to.
    .filter((k) => k !== 'private.data_rights_erasures:user_id').sort();
  const registry = (await h.admin(`select table_schema || '.' || table_name || ':' || user_column as k from private.data_rights_tables`)).rows.map((r) => r.k).sort();
  assert.deepEqual(registry, userTables, 'a new user-owned table must be added to private.data_rights_tables');
  assert.ok(registry.length >= 50);

  await h.admin(`insert into public.coaching_sessions (id, user_id, mode) values ('${U(900)}', '${A}', 'standard')`).catch(async () => {
    await h.admin(`insert into public.coaching_sessions (id, user_id) values ('${U(900)}', '${A}')`);
  });
  await h.admin(`insert into public.coaching_turns (user_id, session_id, role, content) values ('${A}', '${U(900)}', 'user', 'I keep missing mornings')`);
  await h.admin(`insert into public.integration_connections (user_id, provider, kind, external_account_id, encrypted_credentials, credential_iv) values ('${A}', 'google', 'calendar', 'a@x', 'cipher', 'iv')`);
  const out = (await h.as(A, 'select public.apm_data_rights_export() e')).rows[0].e;
  assert.deepEqual(out.coaching_turns.map((t) => t.content), ['I keep missing mornings']);
  assert.equal(out.integration_connections[0].external_account_id, 'a@x');
  assert.ok(!('encrypted_credentials' in out.integration_connections[0]) && !('credential_iv' in out.integration_connections[0]));
  assert.ok(out.audit_events.length > 10, 'no 250-row cap; every audit row');
  assert.ok(out.audit_events.every((e) => e.user_id === A), 'own rows only');
  await rejects(h.asRole('anon', null, 'select public.apm_data_rights_export()'), /permission denied/);
});
