// Executes the real migrations through 0020 plus 0090 (coaching route
// candidates) in an embedded Postgres (PGlite) and pins that 0090 adds ZDR
// candidates without promoting anything, and is safe to re-run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');
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
const NEW_ROUTES = ['or_gemma_4_31b_it_deepinfra', 'or_mistral_small_3_2_24b_deepinfra'];

let db;
test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(files.includes('0090_coaching_route.sql'));
  for (const name of files.filter((file) => file <= '0020_coaching_modes_and_tracks.sql')) await db.exec(await migration(name));
  await db.exec(await migration('0090_coaching_route.sql'));
});

test('0090 adds the paid ZDR coaching candidates and approves nothing', async () => {
  const rows = (await db.query('select route_id, status, cost_class, training_allowed, retention, capabilities, data_classes_allowed, approved_for_highly_sensitive, quality_score from public.model_routes order by route_id')).rows;
  assert.ok(rows.every((r) => r.status !== 'approved'), 'no route is approved by a migration');
  const added = rows.filter((r) => NEW_ROUTES.includes(r.route_id));
  assert.equal(added.length, 2);
  for (const r of added) {
    assert.equal(r.status, 'candidate');
    assert.equal(r.cost_class, 'low');
    assert.equal(r.training_allowed, false);
    assert.equal(r.retention, 'zero');
    assert.equal(r.approved_for_highly_sensitive, false);
    assert.equal(r.quality_score, 0);
    for (const cap of ['conversation', 'reasoning', 'structured_output']) assert.ok(r.capabilities.includes(cap), `${r.route_id} lacks ${cap}`);
    assert.ok(r.data_classes_allowed.includes('private_life') && !r.data_classes_allowed.includes('highly_sensitive'));
  }
  const free = rows.find((r) => r.route_id === 'or_apodex_1_1_mini_novita_free');
  assert.equal(free.status, 'candidate');
});

test('0090 records the json_schema 400 once and never changes a status on re-run', async () => {
  await db.exec("update public.model_routes set status = 'restricted' where route_id = 'or_gemma_4_31b_it_deepinfra'");
  await db.exec(await migration('0090_coaching_route.sql'));
  const notes = (await db.query("select policy_notes from public.model_routes where route_id = 'or_apodex_1_1_mini_novita_free'")).rows[0].policy_notes;
  assert.match(notes, /json_schema/);
  assert.equal(notes.split('(0090)').length - 1, 1, 'the 0090 note is appended exactly once');
  const gemma = (await db.query("select status from public.model_routes where route_id = 'or_gemma_4_31b_it_deepinfra'")).rows[0];
  assert.equal(gemma.status, 'restricted', 'a re-run never overwrites a reviewed status');
});

// The coaching promotion is written but PENDING the owner's human review
// (docs/23): it lives under docs/reference, never in migrations, and when the
// coordinator applies it, it promotes exactly the reviewed route for exactly the
// evaluated coaching capabilities, once.
const pendingPromotion = fileURLToPath(new URL('../../../docs/reference/0091_promote_coaching_route.sql', import.meta.url));

test('0091 promotion is pending: not in migrations, ready to apply, scoped and one-way', async () => {
  const files = await readdir(migrationsDir);
  assert.ok(!files.some((name) => name.startsWith('0091')), 'the promotion is not applied before sign-off');
  const sql = await readFile(pendingPromotion, 'utf8');
  assert.match(sql, /PENDING — NOT APPLIED/);

  const fresh = new PGlite();
  await fresh.exec(SUBSTRATE);
  for (const name of files.filter((file) => file.endsWith('.sql') && file <= '0020_coaching_modes_and_tracks.sql').sort()) await fresh.exec(await migration(name));
  await fresh.exec(await migration('0090_coaching_route.sql'));
  await fresh.exec(sql);
  await fresh.exec(sql);
  const rows = (await fresh.query('select route_id, status, capabilities, data_classes_allowed, approved_for_highly_sensitive, quality_score, last_eval_run_at, policy_notes from public.model_routes')).rows;
  const approved = rows.filter((r) => r.status === 'approved');
  assert.deepEqual(approved.map((r) => r.route_id), ['or_mistral_small_3_2_24b_deepinfra']);
  const [m] = approved;
  assert.deepEqual([...m.capabilities].sort(), ['conversation', 'reasoning', 'structured_output']);
  assert.ok(m.data_classes_allowed.includes('private_life') && !m.data_classes_allowed.includes('highly_sensitive'));
  assert.equal(m.approved_for_highly_sensitive, false);
  assert.ok(m.quality_score >= 75, 'meets the coaching minimumQualityScore');
  assert.ok(m.last_eval_run_at);
  assert.equal(m.policy_notes.split('(0091)').length - 1, 1, 'the 0091 note is appended exactly once');

  await fresh.exec("update public.model_routes set status = 'disabled' where route_id = 'or_mistral_small_3_2_24b_deepinfra'");
  await fresh.exec(sql);
  const after = (await fresh.query("select status from public.model_routes where route_id = 'or_mistral_small_3_2_24b_deepinfra'")).rows[0];
  assert.equal(after.status, 'disabled', 'a re-run never re-promotes a disabled route');
  await fresh.close();
});
