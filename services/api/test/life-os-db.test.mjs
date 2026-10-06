// Executes the real Life OS migrations (0015, 0016, 0017) in an embedded Postgres
// (PGlite) on a minimal Supabase-shaped substrate (auth.uid(), anon/authenticated
// roles, Supabase's default public-schema grants) and proves, as the
// `authenticated` role with a forged-but-valid JWT subject, that:
//   * direct PostgREST-style INSERT/UPDATE/DELETE on Life OS tables is rejected;
//   * the governed RPCs enforce ownership, entitlement and lifecycle rules and
//     write their audit events atomically;
//   * ordinary SELECT needs the entitlement again, while the owner-only
//     data-rights export still returns retained rows after downgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = new URL('../migrations/', import.meta.url);
const migration = (name) => readFile(fileURLToPath(new URL(name, migrationsDir)), 'utf8');

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  -- Supabase grants every new public table/function to the API roles by default.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant execute on function auth.uid() to anon, authenticated;

  create schema private;
  revoke all on schema private from public;
  grant usage on schema private to authenticated;

  create table public.people (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null,
    relationship text, email text, phone text,
    provenance_kind text not null default 'stated',
    source_type text not null default 'manual',
    source_ref text,
    confidence double precision,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table public.audit_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    event_type text not null,
    actor_type text not null check (actor_type in ('user','system','connector','ai')),
    actor_ref text, object_type text, object_id text, data_class text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create table public.subscription_entitlements (
    user_id uuid primary key references auth.users(id) on delete cascade,
    plan text not null default 'beta',
    status text not null default 'active',
    updated_at timestamptz not null default now()
  );
  alter table public.people enable row level security;
  alter table public.audit_events enable row level security;
  alter table public.subscription_entitlements enable row level security;
  create policy people_own on public.people for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy audit_events_select_own on public.audit_events for select to authenticated using (auth.uid() = user_id);
  create policy audit_events_insert_own on public.audit_events for insert to authenticated with check (auth.uid() = user_id);
  create policy entitlements_select_own on public.subscription_entitlements for select to authenticated using (auth.uid() = user_id);
`;

let db;
let personA;
let personB;

async function admin(sql, params) {
  await db.exec('reset role');
  return db.query(sql, params);
}

/** Run one statement as the PostgREST `authenticated` role for `userId`, in its own transaction. */
async function as(userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${userId ?? ''}', true);`);
    return tx.query(sql, params);
  });
}

async function asAnon(sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role anon; select set_config('request.jwt.claim.sub', '', true);`);
    return tx.query(sql, params);
  });
}

async function rejects(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error?.message ?? error), pattern);
    return true;
  });
}

const rpc = async (userId, fn, args, values) => (await as(userId, `select public.${fn}(${args}) as r`, values)).rows[0].r;
const createItem = (userId, item) => rpc(userId, 'apm_life_os_create_item', '$1::jsonb', [JSON.stringify(item)]);
const auditCount = async (eventType) => Number((await admin('select count(*)::int as n from public.audit_events where event_type = $1', [eventType])).rows[0].n);
const setPlan = (userId, plan, status) => admin(
  `insert into public.subscription_entitlements (user_id, plan, status) values ($1, $2, $3)
   on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`,
  [userId, plan, status],
);
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of ['0015_life_os_domains.sql', '0016_life_os_data_rights_hardening.sql', '0017_life_os_governed_writes.sql']) {
    await db.exec(await migration(name));
  }
  await admin(`insert into auth.users (id) values ('${USER_A}'), ('${USER_B}')`);
  await setPlan(USER_A, 'life_os', 'active');
  await setPlan(USER_B, 'autopilot', 'trialing');
  personA = (await admin(`insert into public.people (user_id, name) values ('${USER_A}', 'Ada') returning id`)).rows[0].id;
  personB = (await admin(`insert into public.people (user_id, name) values ('${USER_B}', 'Bo') returning id`)).rows[0].id;
});

test.after(async () => { await db?.close(); });

test('direct INSERT/UPDATE/DELETE on Life OS tables is rejected for authenticated and anon', async () => {
  await rejects(as(USER_A, `insert into public.life_admin_items (user_id, kind, title, status, recurrence)
    values ('${USER_A}', 'bill', 'forged', 'completed', '{"frequency":"monthly"}')`), /permission denied/);
  await rejects(as(USER_A, `insert into public.life_admin_items (user_id, kind, title, provenance_kind, source_type)
    values ('${USER_A}', 'bill', 'forged', 'inferred', 'gmail')`), /permission denied/);
  await rejects(as(USER_A, `insert into public.life_relationships (user_id, person_id) values ('${USER_A}', '${personA}')`), /permission denied/);

  const item = await createItem(USER_A, { kind: 'bill', title: 'Rent', due_at: future(3), recurrence: {} });
  await rejects(as(USER_A, `update public.life_admin_items set status = 'completed' where id = $1`, [item.id]), /permission denied/);
  await rejects(as(USER_A, `update public.life_admin_items set provenance_kind = 'observed' where id = $1`, [item.id]), /permission denied/);
  await rejects(as(USER_A, `delete from public.life_admin_items where id = $1`, [item.id]), /permission denied/);
  await rejects(as(USER_A, `delete from public.life_relationships`), /permission denied/);
  await rejects(asAnon(`insert into public.life_admin_items (user_id, kind, title) values ('${USER_A}', 'bill', 'x')`), /permission denied/);
  await rejects(asAnon(`select * from public.life_admin_items`), /permission denied/);

  const row = (await admin('select status, provenance_kind from public.life_admin_items where id = $1', [item.id])).rows[0];
  assert.deepEqual(row, { status: 'open', provenance_kind: 'stated' });

  const policies = (await admin(`select tablename, cmd from pg_policies where tablename in ('life_admin_items','life_relationships') order by 1, 2`)).rows;
  assert.deepEqual(policies, [
    { tablename: 'life_admin_items', cmd: 'SELECT' },
    { tablename: 'life_relationships', cmd: 'SELECT' },
  ]);
});

test('anon cannot execute any Life OS RPC; definer bodies are not in the exposed schema', async () => {
  await rejects(asAnon(`select public.apm_life_os_create_item('{"kind":"bill","title":"x"}'::jsonb)`), /permission denied/);
  await rejects(asAnon(`select public.apm_life_os_data_rights_export()`), /permission denied/);
  await rejects(asAnon(`select private.apm_life_os_create_item('{"kind":"bill","title":"x"}'::jsonb)`), /permission denied/);
  await rejects(as(USER_A, `select private.apm_life_os_audit('${USER_A}', 'x', 'y', gen_random_uuid(), '{}'::jsonb)`), /permission denied/);

  const exposedDefiners = (await admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'apm_life_os%' and p.prosecdef`)).rows;
  assert.deepEqual(exposedDefiners, []);
  const unpinned = (await admin(`select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname like 'apm_life_os%' and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows;
  assert.deepEqual(unpinned, []);
});

test('create rejects completed status, forged provenance/system fields, foreign people and bad recurrence', async () => {
  await rejects(createItem(USER_A, { kind: 'bill', title: 'x', status: 'completed', recurrence: { frequency: 'monthly', interval: 1 } }), /life_os_use_completion_route/);
  for (const field of ['provenance_kind', 'source_type', 'source_ref', 'confidence', 'completed_at', 'user_id', 'created_at', 'id']) {
    await rejects(createItem(USER_A, { kind: 'bill', title: 'x', [field]: field === 'confidence' ? 0.1 : 'observed' }), /life_os_field_not_allowed/);
  }
  await rejects(createItem(USER_A, { kind: 'bill', title: 'x', person_id: personB }), /life_os_person_not_found/);
  await rejects(createItem(USER_A, { kind: 'bill', title: 'x', recurrence: { frequency: 'hourly' } }), /life_os_invalid_recurrence/);
  await rejects(createItem(USER_A, { kind: 'bill', title: 'x', recurrence: { frequency: 'weekly', interval: 0 } }), /life_os_invalid_recurrence/);
  const due = future(5);
  await rejects(createItem(USER_A, { kind: 'bill', title: 'x', due_at: due, recurrence: { frequency: 'weekly', interval: 1, anchorDueAt: future(400) } }), /life_os_invalid_recurrence/);
  await rejects(createItem(USER_A, { kind: 'trip', title: 'x', starts_at: future(5), ends_at: future(4) }), /life_os_invalid_schedule/);

  const before = await auditCount('life_os.item_created');
  const item = await createItem(USER_A, {
    kind: 'bill', title: 'Water', due_at: due, details: { note: 'ok', lastCompletedAt: '2020-01-01T00:00:00Z' },
    recurrence: { frequency: 'monthly', interval: 1, anchorDueAt: due, timezone: 'America/Chicago' },
  });
  assert.equal(item.status, 'open');
  assert.equal(item.provenance_kind, 'stated');
  assert.equal(item.source_type, 'manual');
  assert.equal(item.confidence, 1);
  assert.equal(item.completed_at, null);
  assert.deepEqual(item.details, { note: 'ok' });
  assert.equal(await auditCount('life_os.item_created'), before + 1);
});

test('update rejects completion, system fields, stale anchors and cross-user ids; audits on success', async () => {
  const due = future(10);
  const item = await createItem(USER_A, { kind: 'subscription', title: 'Gym', due_at: due, recurrence: { frequency: 'monthly', interval: 1, anchorDueAt: due } });
  const patch = (userId, body) => rpc(userId, 'apm_life_os_update_item', '$1::uuid, $2::jsonb', [item.id, JSON.stringify(body)]);

  await rejects(patch(USER_A, { status: 'completed' }), /life_os_use_completion_route/);
  await rejects(patch(USER_A, { completed_at: new Date().toISOString() }), /life_os_field_not_allowed/);
  await rejects(patch(USER_A, { provenance_kind: 'inferred' }), /life_os_field_not_allowed/);
  await rejects(patch(USER_A, { due_at: future(20) }), /life_os_invalid_recurrence/);
  await rejects(patch(USER_B, { title: 'hijack' }), /life_os_item_not_found/);

  const before = await auditCount('life_os.item_updated');
  const moved = future(20);
  const updated = await patch(USER_A, { due_at: moved, recurrence: { frequency: 'monthly', interval: 1, anchorDueAt: moved }, details: { lastCompletedAt: 'forged' } });
  assert.equal(Date.parse(updated.due_at), Date.parse(moved));
  assert.equal(updated.details.lastCompletedAt, undefined);
  assert.equal(await auditCount('life_os.item_updated'), before + 1);
});

test('completion enforces rollover for recurring items and no rollover for one-off items', async () => {
  const complete = (userId, id, expected, next = {}, recurrence = null) => rpc(
    userId, 'apm_life_os_complete_item', '$1::uuid, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5::timestamptz, $6::jsonb',
    [id, expected, next.due ?? null, next.starts ?? null, next.ends ?? null, recurrence === null ? null : JSON.stringify(recurrence)],
  );

  const due = future(2);
  const rec = { frequency: 'weekly', interval: 1, anchorDueAt: due };
  const recurring = await createItem(USER_A, { kind: 'recurring_obligation', title: 'Bins', due_at: due, recurrence: rec });

  await rejects(complete(USER_A, recurring.id, recurring.updated_at), /life_os_invalid_completion/); // completion without rollover
  await rejects(complete(USER_A, recurring.id, recurring.updated_at, { due: due }), /life_os_invalid_completion/); // does not move forward
  await rejects(complete(USER_A, recurring.id, recurring.updated_at, { due: future(-30) }), /life_os_invalid_completion/);
  await rejects(complete(USER_A, recurring.id, recurring.updated_at, { due: future(9) }, { ...rec, frequency: 'daily' }), /life_os_invalid_recurrence/);
  await rejects(complete(USER_A, recurring.id, recurring.updated_at, { due: future(9) }, { ...rec, anchorDueAt: future(1) }), /life_os_invalid_recurrence/);
  await rejects(complete(USER_A, recurring.id, '2000-01-01T00:00:00Z', { due: future(9) }), /life_os_conflict/);
  await rejects(complete(USER_B, recurring.id, recurring.updated_at, { due: future(9) }), /life_os_item_not_found/);

  const before = await auditCount('life_os.item_completed');
  const next = future(9);
  const rolled = await complete(USER_A, recurring.id, recurring.updated_at, { due: next }, rec);
  assert.equal(rolled.status, 'open');
  assert.equal(Date.parse(rolled.due_at), Date.parse(next));
  assert.ok(rolled.completed_at);
  assert.equal(rolled.details.lastCompletedAt !== undefined, true);
  assert.equal(await auditCount('life_os.item_completed'), before + 1);
  // The same stale read cannot complete twice.
  await rejects(complete(USER_A, recurring.id, recurring.updated_at, { due: future(16) }, rec), /life_os_conflict/);

  const oneOff = await createItem(USER_A, { kind: 'appointment', title: 'Dentist', due_at: future(1) });
  await rejects(complete(USER_A, oneOff.id, oneOff.updated_at, { due: future(8) }), /life_os_invalid_completion/);
  const done = await complete(USER_A, oneOff.id, oneOff.updated_at);
  assert.equal(done.status, 'completed');

  const cancelled = await createItem(USER_A, { kind: 'bill', title: 'Old', status: 'cancelled' });
  await rejects(complete(USER_A, cancelled.id, cancelled.updated_at), /life_os_item_cancelled/);
});

test('relationships: owned person required, provenance forced, audited', async () => {
  await rejects(rpc(USER_A, 'apm_life_os_save_relationship', '$1::uuid', [personB]), /life_os_person_not_found/);
  const before = await auditCount('life_os.relationship_saved');
  const saved = await rpc(USER_A, 'apm_life_os_save_relationship', '$1::uuid, $2::date, $3::timestamptz, $4::int, $5::text', [personA, '1990-04-02', null, 30, 'call']);
  assert.equal(saved.provenance_kind, 'stated');
  assert.equal(saved.cadence_days, 30);
  assert.equal(await auditCount('life_os.relationship_saved'), before + 1);

  await rejects(rpc(USER_A, 'apm_life_os_update_relationship', '$1::uuid, $2::jsonb', [saved.id, JSON.stringify({ provenance_kind: 'inferred' })]), /life_os_field_not_allowed/);
  await rejects(rpc(USER_B, 'apm_life_os_update_relationship', '$1::uuid, $2::jsonb', [saved.id, JSON.stringify({ notes: 'x' })]), /life_os_relationship_not_found/);
  const updated = await rpc(USER_A, 'apm_life_os_update_relationship', '$1::uuid, $2::jsonb', [saved.id, JSON.stringify({ notes: 'text', cadence_days: null })]);
  assert.equal(updated.notes, 'text');
  assert.equal(updated.cadence_days, null);
});

test('after downgrade: ordinary reads and writes are denied, data-rights export still returns retained rows', async () => {
  const ownCount = async (userId) => (await as(userId, 'select count(*)::int as n from public.life_admin_items')).rows[0].n;
  assert.ok((await ownCount(USER_A)) > 0);
  assert.equal(await ownCount(USER_B), 0); // B sees none of A's rows

  await setPlan(USER_A, 'life_os', 'expired');
  try {
    assert.equal(await ownCount(USER_A), 0);
    assert.equal((await as(USER_A, 'select count(*)::int as n from public.life_relationships')).rows[0].n, 0);
    await rejects(createItem(USER_A, { kind: 'bill', title: 'after downgrade' }), /life_os_required/);

    const exported = await rpc(USER_A, 'apm_life_os_data_rights_export', '', []);
    assert.ok(exported.life_admin_items.length > 0);
    assert.ok(exported.life_relationships.length > 0);
    assert.ok(exported.life_admin_items.every((row) => row.user_id === USER_A));

    const exportedB = await rpc(USER_B, 'apm_life_os_data_rights_export', '', []);
    assert.equal(exportedB.life_admin_items.length, 0);
    await rejects(as(null, 'select public.apm_life_os_data_rights_export()'), /life_os_unauthenticated/);
  } finally {
    await setPlan(USER_A, 'life_os', 'active');
  }
});
