// Full-chain proof of migration 0093 (owner, 8 Oct 2026): the 18+ confirmation and the
// consumer health data consent are server-stamped, append-only records that only the owner's
// governed function writes; no intake draft exists before the age confirmation; without a live
// health-data grant every health answer is stripped before it is stored (and a stored one is
// dropped on the next save after a withdrawal); a health-routine reminder needs the grant;
// signing in to an account carries the anonymous decisions; the SQL lists are the TS lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

const A = U(71); const B = U(72); const ANON = U(73); const ACCOUNT = U(74); const KEEP = U(75);
const V = '2026-10-08';
let h; let outDir; let health;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-consent-'));
  await build({ entryPoints: { health: fileURLToPath(new URL('../../../packages/planning/src/intake/healthData.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  health = await import(pathToFileURL(join(outDir, 'health.js')).href);
  h = await realChain();
  await h.admin(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${ANON}'), ('${ACCOUNT}'), ('${KEEP}')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const rpc = async (user, fn, args = []) => (await h.as(user, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const svc = async (fn, args = []) => (await h.service(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
const draft = (answers, answeredAt) => JSON.stringify({ bankVersion: 2, version: 1, answers, answeredAt, cursor: 'games', updatedAt: Date.now() });
const HEALTHY = { games: ['weight', 'founder'], foreground: 'weight', goal: 'lose_weight', goal_size: 20, move: ['walk'], weight_now: 210, clinician_flag: 'no', bed: 'yes', season: 'building' };
const TIMES = Object.fromEntries(Object.keys(HEALTHY).map((key, i) => [key, i + 1]));

test('age: only "confirmed" is accepted, stamped by the server, recorded once, audited; no client writes', async () => {
  await rejects(rpc(A, 'apm_record_consent', ['age_18_plus', 'declined', V]), /age_confirmation_required/);
  await rejects(rpc(A, 'apm_record_consent', ['age_18_plus', null, V]), /age_confirmation_required/);
  await rejects(rpc(A, 'apm_record_consent', ['age_18_plus', 'confirmed', 'yesterday']), /consent_invalid_request/);
  await rejects(h.asRole('anon', null, `select public.apm_record_consent('age_18_plus', 'confirmed', '${V}')`), /permission denied/);
  await rejects(h.as(A, `insert into public.consent_records (user_id, kind, decision, policy_version, recorded_at) values ($1, 'age_18_plus', 'confirmed', '${V}', '2000-01-01')`, [A]), /permission denied/);
  assert.equal((await rpc(A, 'apm_my_consents')).ageConfirmedAt, null);

  const first = await rpc(A, 'apm_record_consent', ['age_18_plus', 'confirmed', V]);
  assert.ok(first.ageConfirmedAt && Math.abs(Date.parse(first.ageConfirmedAt) - Date.now()) < 60_000, 'server time, now');
  const again = await rpc(A, 'apm_record_consent', ['age_18_plus', 'confirmed', V]);
  assert.equal(again.ageConfirmedAt, first.ageConfirmedAt, 'a repeat keeps the first time');
  assert.equal((await h.admin(`select count(*)::int n from public.consent_records where user_id = $1`, [A])).rows[0].n, 1);
  assert.equal((await h.admin(`select count(*)::int n from public.audit_events where user_id = $1 and event_type = 'consent.age_confirmed'`, [A])).rows[0].n, 1);
  // Owner-only reads; append-only even for the server.
  assert.equal((await h.as(B, 'select count(*)::int n from public.consent_records')).rows[0].n, 0, 'B never sees A');
  await rejects(h.as(A, `update public.consent_records set recorded_at = now() - interval '1 year'`), /permission denied/);
  await rejects(h.as(A, 'delete from public.consent_records'), /permission denied/);
  await rejects(h.admin(`update public.consent_records set recorded_at = now() - interval '1 year' where user_id = $1`, [A]), /consent_records_append_only/);
});

test('no intake draft before the 18+ confirmation', async () => {
  await rejects(rpc(B, 'apm_save_intake_draft', [draft({ season: 'building' }, { season: 1 })]), /age_confirmation_required/);
  assert.equal((await h.admin(`select count(*)::int n from public.intake_drafts where user_id = $1`, [B])).rows[0].n, 0);
  await rpc(B, 'apm_record_consent', ['age_18_plus', 'confirmed', V]);
  assert.equal((await rpc(B, 'apm_save_intake_draft', [draft({ season: 'building' }, { season: 1 })])).answers.season, 'building');
});

test('health data: nothing is stored without the grant; granted answers are kept; a withdrawal stops collection', async () => {
  // A: confirmed 18+, never asked about health data → every health item is stripped.
  const none = await rpc(A, 'apm_save_intake_draft', [draft(HEALTHY, TIMES)]);
  assert.deepEqual(none.answers, { games: ['founder'], season: 'building' });
  for (const key of ['move', 'weight_now', 'clinician_flag', 'bed', 'goal', 'goal_size', 'foreground']) assert.ok(!(key in none.answeredAt), `${key} time dropped`);

  // Declined is the same as never asked.
  let state = await rpc(A, 'apm_record_consent', ['consumer_health_data', 'declined', V]);
  assert.equal(state.healthData.decision, 'declined');
  assert.deepEqual((await rpc(A, 'apm_save_intake_draft', [draft(HEALTHY, Object.fromEntries(Object.keys(TIMES).map((k) => [k, 100])))])).answers, { games: ['founder'], season: 'building' });

  // Granted: the answers are kept.
  state = await rpc(A, 'apm_record_consent', ['consumer_health_data', 'granted', V]);
  assert.equal(state.healthData.decision, 'granted');
  assert.equal(state.healthData.policyVersion, V);
  const kept = await rpc(A, 'apm_save_intake_draft', [draft(HEALTHY, Object.fromEntries(Object.keys(TIMES).map((k) => [k, 200])))]);
  assert.deepEqual(kept.answers, HEALTHY);
  assert.equal((await rpc(A, 'apm_record_consent', ['consumer_health_data', 'granted', V])).healthData.recordedAt, state.healthData.recordedAt, 'a repeat grant is a no-op');

  // Withdrawn: the next save drops what was stored and refuses new health answers.
  state = await rpc(A, 'apm_record_consent', ['consumer_health_data', 'withdrawn', V]);
  assert.equal(state.healthData.decision, 'withdrawn');
  const after = await rpc(A, 'apm_save_intake_draft', [draft({ weigh_in: 'weekly', season: 'maintaining' }, { weigh_in: 300, season: 300 })]);
  assert.deepEqual(after.answers, { games: ['founder'], season: 'maintaining' });
  const events = (await h.admin(`select event_type from public.audit_events where user_id = $1 and event_type like 'consent.health_data_%' order by created_at`, [A])).rows.map((r) => r.event_type);
  assert.deepEqual(events, ['consent.health_data_declined', 'consent.health_data_granted', 'consent.health_data_withdrawn']);
  assert.equal((await h.admin(`select count(*)::int n from public.consent_records where user_id = $1 and kind = 'consumer_health_data'`, [A])).rows[0].n, 3, 'every decision is kept, with its time');

  // Withdrawing what was never granted records nothing; unknown decisions are refused.
  assert.equal((await rpc(B, 'apm_record_consent', ['consumer_health_data', 'withdrawn', V])).healthData, null);
  await rejects(rpc(B, 'apm_record_consent', ['consumer_health_data', 'maybe', V]), /consent_invalid_request/);
  await rejects(rpc(B, 'apm_record_consent', ['something_else', 'granted', V]), /consent_invalid_request/);
});

test('a health-routine reminder needs a live grant', async () => {
  const insert = (user) => h.admin(`insert into public.life_admin_items (user_id, kind, title) values ($1, 'health_routine', 'Vitamins')`, [user]);
  await rejects(insert(A), /health_data_consent_required/);
  await rejects(insert(B), /health_data_consent_required/);
  await rpc(B, 'apm_record_consent', ['consumer_health_data', 'granted', V]);
  await insert(B);
  await h.admin(`insert into public.life_admin_items (user_id, kind, title) values ($1, 'bill', 'Rent')`, [A]);
});

test('signing in to an account carries the anonymous decisions with their times; service role only; the account keeps its own', async () => {
  const anon = await rpc(ANON, 'apm_record_consent', ['age_18_plus', 'confirmed', V]);
  const anonHealth = await rpc(ANON, 'apm_record_consent', ['consumer_health_data', 'granted', V]);
  await rejects(rpc(ANON, 'apm_service_carry_consents', [ANON, ACCOUNT]), /permission denied/);
  await rejects(rpc(ACCOUNT, 'apm_service_carry_consents', [ANON, ACCOUNT]), /permission denied/);
  const carried = await svc('apm_service_carry_consents', [ANON, ACCOUNT]);
  assert.equal(carried.ageConfirmedAt, anon.ageConfirmedAt);
  assert.equal(carried.healthData.decision, 'granted');
  assert.equal(carried.healthData.recordedAt, anonHealth.healthData.recordedAt);
  assert.deepEqual((await h.admin(`select distinct source from public.consent_records where user_id = $1`, [ACCOUNT])).rows, [{ source: 'merge' }]);
  // An account with its own decision keeps it.
  await rpc(KEEP, 'apm_record_consent', ['age_18_plus', 'confirmed', V]);
  await rpc(KEEP, 'apm_record_consent', ['consumer_health_data', 'declined', V]);
  const kept = await svc('apm_service_carry_consents', [ANON, KEEP]);
  assert.equal(kept.healthData.decision, 'declined');
  assert.equal((await h.admin(`select count(*)::int n from public.consent_records where user_id = $1`, [KEEP])).rows[0].n, 2);
  await rejects(svc('apm_service_carry_consents', [ANON, ANON]), /consent_invalid_request/);
});

test('the SQL health lists are the TypeScript lists (packages/planning/src/intake/healthData.ts)', async () => {
  const src = async (name) => (await h.admin(`select prosrc from pg_proc where proname = $1 and pronamespace = 'private'::regnamespace`, [name])).rows[0].prosrc;
  const strip = await src('apm_strip_health_answers');
  const quoted = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(quoted(strip.match(/v - array\[([^\]]*)\]/)[1]), [...health.HEALTH_DATA_QUESTION_IDS]);
  assert.deepEqual(quoted(strip.match(/to_jsonb\(([^)]*)::text\)/)[1]), [...health.HEALTH_DATA_GAME_IDS]);
  assert.deepEqual(quoted(strip.match(/v->>'foreground' in \(([^)]*)\)/)[1]), [...health.HEALTH_DATA_GAME_IDS]);
  assert.deepEqual(quoted(strip.match(/v->>'goal' in \(([^)]*)\)/)[1]), [...health.HEALTH_DATA_GOAL_IDS]);
  const guard = await src('apm_intake_drafts_consent_guard');
  assert.deepEqual(quoted(guard.match(/k in \(([^)]*)\)/)[1]), [...health.HEALTH_DATA_QUESTION_IDS, 'goal', 'goal_size', 'foreground']);
  // The TS strip and the SQL strip agree on the same answers.
  const sql = (await h.admin('select private.apm_strip_health_answers($1::jsonb) as r', [JSON.stringify(HEALTHY)])).rows[0].r;
  assert.deepEqual(sql, health.withoutHealthAnswers(HEALTHY));
});
