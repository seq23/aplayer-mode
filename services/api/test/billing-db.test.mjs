// Executes the REAL migration chain in PGlite and proves the 0040 billing contract:
//   * every billing function is service-role only; a client cannot write its own
//     entitlement, read the billing tables, or reserve a Founding 100 slot;
//   * the webhook writer is idempotent on the event id and ignores stale events;
//   * every handled event type moves the entitlement the documented way;
//   * a product maps to a plan only through the server catalogue (pinned to policy);
//   * Founding 100 is decided atomically: 99 -> one more, 100 -> none, never 101;
//   * buying a tier never writes a permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
const policyEntry = fileURLToPath(new URL('../../../packages/policy/src/index.ts', import.meta.url));
const migration = async (name) => (await readFile(`${migrationsDir}/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '');
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = U(1); const B = U(2); const C = U(3);

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

let db; let policy; let billing; let outDir;
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

const DAY = 86_400_000;
const T0 = Date.now();
let seq = 0;
function ev(type, user, product, extra = {}) {
  seq += 1;
  return {
    id: `evt-${seq}`, type, app_user_id: user, product_id: product, store: product.includes(':') ? 'PLAY_STORE' : product.startsWith('apm_web_') ? 'RC_BILLING' : 'APP_STORE',
    environment: 'PRODUCTION', event_timestamp_ms: T0 + seq * 1000, expiration_at_ms: T0 + 30 * DAY, ...extra,
  };
}
const apply = async (event, allowSandbox = false) => (await service('select public.apm_service_billing_apply_event($1::jsonb, $2) as r', [JSON.stringify(event), allowSandbox])).rows[0].r;
const offering = async (user) => (await service('select public.apm_service_billing_offering($1::uuid) as r', [user])).rows[0].r;
const ent = async (user) => (await admin('select plan, status, provider, store_product_id, billing_period, offer, cancel_at_period_end, billing_issue_at, pending_plan, current_period_end from public.subscription_entitlements where user_id = $1', [user])).rows[0];
const slot = async (user) => (await admin('select slot_no, status from private.billing_founding_slots where user_id = $1', [user])).rows[0];
const access = async (user) => (await admin('select private.apm_has_core_access($1) as core, private.apm_has_life_os_access($1) as life, private.apm_has_autopilot_access($1) as auto', [user])).rows[0];
const users = [];
async function newUser() {
  const id = U(1000 + users.length);
  users.push(id);
  await admin('insert into auth.users (id) values ($1)', [id]);
  return id;
}

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-billing-db-'));
  await build({ entryPoints: { policy: policyEntry, billing: fileURLToPath(new URL('../src/billing.ts', import.meta.url)) }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  policy = await import(pathToFileURL(join(outDir, 'policy.js')).href);
  billing = await import(pathToFileURL(join(outDir, 'billing.js')).href);
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort()) await db.exec(await migration(name));
  await admin(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}')`);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

test('the server catalogue is exactly BILLING_PRODUCTS from packages/policy', async () => {
  const rows = (await admin('select product_id, store, plan, billing_period, offer from private.billing_products order by product_id')).rows;
  const expected = policy.BILLING_PRODUCTS.map((p) => ({ product_id: p.productId, store: p.store, plan: p.plan, billing_period: p.period, offer: p.offer }))
    .sort((x, y) => (x.product_id < y.product_id ? -1 : 1));
  assert.deepEqual(rows, expected);
  // A founding row can only ever be Executive Roundtable (chief_of_staff) monthly.
  await rejects(admin("insert into private.billing_products values ('x', 'app_store', 'autopilot', 'monthly', 'founding')"), /check constraint/);
});

test('clients never write entitlements or reach any billing function or table', async () => {
  for (const role of ['authenticated', 'anon']) {
    await rejects(asRole(role, A, "update public.subscription_entitlements set plan = 'autopilot', status = 'active' where user_id = $1", [A]), /permission denied/);
    await rejects(asRole(role, A, "insert into public.subscription_entitlements (user_id, plan, status) values ($1, 'autopilot', 'active')", [A]), /permission denied/);
    await rejects(asRole(role, A, 'delete from public.subscription_entitlements where user_id = $1', [A]), /permission denied/);
    await rejects(asRole(role, A, 'select public.apm_service_billing_apply_event($1::jsonb, true)', [JSON.stringify(ev('INITIAL_PURCHASE', A, 'apm_autopilot_monthly'))]), /permission denied/);
    await rejects(asRole(role, A, 'select public.apm_service_billing_offering($1::uuid)', [A]), /permission denied/);
    await rejects(asRole(role, A, 'select public.apm_service_billing_expire_lapsed()'), /permission denied/);
    await rejects(asRole(role, A, 'select private.apm_billing_apply_event($1::jsonb, true)', [JSON.stringify(ev('INITIAL_PURCHASE', A, 'apm_autopilot_monthly'))]), /permission denied/);
    await rejects(asRole(role, A, 'select private.apm_billing_offering($1::uuid, now())', [A]), /permission denied/);
    await rejects(asRole(role, A, 'select private.apm_billing_claim_founding($1::uuid, now())', [A]), /permission denied/);
    await rejects(asRole(role, A, 'select * from private.billing_events'), /permission denied/);
    await rejects(asRole(role, A, 'select * from private.billing_founding_slots'), /permission denied/);
    await rejects(asRole(role, A, "insert into private.billing_founding_slots (slot_no, user_id, status) values (1, $1, 'claimed')", [A]), /permission denied/);
  }
  // A user still reads only their own entitlement row.
  const own = (await asRole('authenticated', A, 'select user_id::text from public.subscription_entitlements')).rows;
  assert.deepEqual(own.map((r) => r.user_id), [A]);
  assert.equal((await ent(A)).plan, 'beta', 'nothing changed');
  // Every SECURITY DEFINER billing function pins an empty search_path.
  const definers = (await admin(`select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like 'apm%billing%'`)).rows;
  assert.ok(definers.length >= 10);
  for (const fn of definers) assert.deepEqual(fn.proconfig, ['search_path=""'], `${fn.proname} search_path`);
  const publicDefiners = (await admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'apm%billing%' and p.prosecdef`)).rows;
  assert.deepEqual(publicDefiners, [], 'public wrappers are SECURITY INVOKER');
  // 0041: every private billing table has RLS on and an explicit deny-all policy (advisor lint 0008).
  const tables = (await admin(`select c.relname, c.relrowsecurity, (select array_agg(p.qual order by p.policyname) from pg_policies p
    where p.schemaname = 'private' and p.tablename = c.relname) as quals from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname like 'billing%' and c.relkind = 'r' order by c.relname`)).rows;
  assert.deepEqual(tables.map((t) => [t.relname, t.relrowsecurity, t.quals]), [
    ['billing_checkout_links', true, ['false']], ['billing_events', true, ['false']], ['billing_founding_lapsed', true, ['false']], ['billing_founding_slots', true, ['false']], ['billing_products', true, ['false']],
  ]);
  // 0044: the beta allowlist is server-only too.
  for (const role of ['authenticated', 'anon']) {
    await rejects(asRole(role, A, 'select * from private.beta_allowlist'), /permission denied/);
    await rejects(asRole(role, A, "select public.apm_service_beta_grant('a@x.com', now() + interval '1 day', null)"), /permission denied/);
  }
});

test('initial purchase grants the mapped plan, audited, and never a permission', async () => {
  const before = (await admin('select count(*)::int as n from public.permissions')).rows[0].n;
  const out = await apply(ev('INITIAL_PURCHASE', A, 'apm_autopilot_annual'));
  assert.equal(out.outcome, 'applied');
  const row = await ent(A);
  assert.deepEqual([row.plan, row.status, row.provider, row.store_product_id, row.billing_period, row.offer], ['autopilot', 'active', 'app_store', 'apm_autopilot_annual', 'annual', 'standard']);
  assert.deepEqual(await access(A), { core: true, life: true, auto: true });
  assert.equal((await admin('select count(*)::int as n from public.permissions')).rows[0].n, before, 'buying a tier never grants autonomy');
  const audit = (await admin("select actor_type, actor_ref, metadata from public.audit_events where user_id = $1 and event_type = 'billing.initial_purchase'", [A])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_type, 'system');
  assert.equal(audit[0].metadata.plan, 'autopilot');
});

test('idempotent on event id: a replay changes nothing and writes no second audit', async () => {
  const purchase = ev('INITIAL_PURCHASE', B, 'apm_cos:monthly');
  assert.equal((await apply(purchase)).outcome, 'applied');
  const expire = ev('EXPIRATION', B, 'apm_cos:monthly');
  assert.equal((await apply(expire)).outcome, 'applied');
  assert.equal((await ent(B)).status, 'expired');
  // Replaying the purchase must NOT resurrect the subscription.
  const replay = await apply(purchase);
  assert.deepEqual([replay.outcome, replay.replayed], ['applied', true]);
  assert.equal((await ent(B)).status, 'expired');
  // Concurrent duplicate deliveries apply once.
  const renew = ev('RENEWAL', B, 'apm_cos:monthly');
  const results = await Promise.all([apply(renew), apply(renew), apply(renew)]);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  const audits = (await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type = 'billing.renewal'", [B])).rows[0].n;
  assert.equal(audits, 1);
  assert.equal((await ent(B)).status, 'active');
});

test('stale (out-of-order) events never overwrite newer state', async () => {
  const u = await newUser();
  const early = ev('INITIAL_PURCHASE', u, 'apm_cos_monthly');
  const cancel = ev('CANCELLATION', u, 'apm_cos_monthly', { cancel_reason: 'UNSUBSCRIBE' });
  const expiration = ev('EXPIRATION', u, 'apm_cos_monthly');
  const renewal = ev('RENEWAL', u, 'apm_cos_monthly');
  // Delivered: purchase, renewal (newest), then the older cancellation and expiration.
  await apply(early);
  await apply(renewal);
  assert.equal((await apply(cancel)).outcome, 'stale');
  assert.equal((await apply(expiration)).outcome, 'stale');
  const row = await ent(u);
  assert.deepEqual([row.status, row.cancel_at_period_end], ['active', false]);
});

test('every event type moves the entitlement as documented', async () => {
  const u = await newUser();
  await apply(ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'));
  assert.deepEqual(await access(u), { core: true, life: false, auto: false });

  // RENEWAL extends the period.
  const renewedUntil = T0 + 61 * DAY;
  await apply(ev('RENEWAL', u, 'apm_cos_monthly', { expiration_at_ms: renewedUntil }));
  assert.equal(new Date((await ent(u)).current_period_end).getTime(), renewedUntil);

  // PRODUCT_CHANGE upgrade: the higher tier starts now.
  await apply(ev('PRODUCT_CHANGE', u, 'apm_cos_monthly', { new_product_id: 'apm_lifeos_monthly' }));
  let row = await ent(u);
  assert.deepEqual([row.plan, row.store_product_id, row.pending_plan], ['life_os', 'apm_lifeos_monthly', null]);
  assert.deepEqual(await access(u), { core: true, life: true, auto: false });

  // PRODUCT_CHANGE downgrade: stays on the paid tier until the renewal carries the new product.
  await apply(ev('PRODUCT_CHANGE', u, 'apm_lifeos_monthly', { new_product_id: 'apm_cos_annual' }));
  row = await ent(u);
  assert.deepEqual([row.plan, row.pending_plan], ['life_os', 'chief_of_staff']);
  await apply(ev('RENEWAL', u, 'apm_cos_annual', { expiration_at_ms: T0 + 400 * DAY }));
  row = await ent(u);
  assert.deepEqual([row.plan, row.billing_period, row.pending_plan], ['chief_of_staff', 'annual', null]);

  // An unknown new product is ignored, never guessed.
  assert.equal((await apply(ev('PRODUCT_CHANGE', u, 'apm_cos_annual', { new_product_id: 'apm_bogus' }))).outcome, 'ignored_unknown_product');
  assert.equal((await ent(u)).plan, 'chief_of_staff');

  // CANCELLATION (auto-renew off): access continues to period end.
  await apply(ev('CANCELLATION', u, 'apm_cos_annual', { cancel_reason: 'UNSUBSCRIBE', expiration_at_ms: T0 + 400 * DAY }));
  row = await ent(u);
  assert.deepEqual([row.status, row.cancel_at_period_end], ['active', true]);
  assert.equal((await access(u)).core, true);
  await apply(ev('UNCANCELLATION', u, 'apm_cos_annual', { expiration_at_ms: T0 + 400 * DAY }));
  assert.equal((await ent(u)).cancel_at_period_end, false);

  // BILLING_ISSUE with a grace period: access until grace ends; without one: on hold.
  await apply(ev('BILLING_ISSUE', u, 'apm_cos_annual', { expiration_at_ms: T0 + 16 * DAY }));
  row = await ent(u);
  assert.equal(row.status, 'active');
  assert.ok(row.billing_issue_at);
  await apply(ev('BILLING_ISSUE', u, 'apm_cos_annual', { expiration_at_ms: T0 - DAY }));
  assert.equal((await ent(u)).status, 'past_due');
  assert.equal((await access(u)).core, false, 'on hold means no access');
  // A successful retry renews and clears the issue.
  await apply(ev('RENEWAL', u, 'apm_cos_annual', { expiration_at_ms: T0 + 365 * DAY }));
  row = await ent(u);
  assert.deepEqual([row.status, row.billing_issue_at], ['active', null]);

  // EXPIRATION ends access.
  await apply(ev('EXPIRATION', u, 'apm_cos_annual'));
  assert.equal((await ent(u)).status, 'expired');
  assert.deepEqual(await access(u), { core: false, life: false, auto: false });

  // REFUND (both spellings) ends access immediately.
  await apply(ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'));
  await apply(ev('CANCELLATION', u, 'apm_autopilot_monthly', { cancel_reason: 'CUSTOMER_SUPPORT' }));
  row = await ent(u);
  assert.equal(row.status, 'expired');
  assert.ok(new Date(row.current_period_end).getTime() <= Date.now());
  assert.equal((await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type = 'billing.refund'", [u])).rows[0].n, 1);
  await apply(ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'));
  await apply(ev('REFUND', u, 'apm_autopilot_monthly'));
  assert.equal((await ent(u)).status, 'expired');
  await apply(ev('REFUND_REVERSED', u, 'apm_autopilot_monthly'));
  assert.equal((await ent(u)).status, 'active');
});

test('events about a product the user is no longer on change nothing', async () => {
  const u = await newUser();
  await apply(ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'));
  await apply(ev('PRODUCT_CHANGE', u, 'apm_cos_monthly', { new_product_id: 'apm_lifeos_monthly' }));
  // Late events for the product they crossgraded away from are final no-ops.
  for (const type of ['EXPIRATION', 'CANCELLATION', 'BILLING_ISSUE', 'REFUND']) {
    assert.equal((await apply(ev(type, u, 'apm_cos_monthly'))).outcome, 'ignored_other_product', type);
  }
  // A terminal event for a product never applied to them is kept (deferred), not dropped,
  // and changes nothing now.
  for (const type of ['EXPIRATION', 'CANCELLATION', 'REFUND']) {
    assert.equal((await apply(ev(type, u, 'apm_autopilot_monthly'))).outcome, 'deferred', type);
  }
  assert.equal((await apply(ev('BILLING_ISSUE', u, 'apm_autopilot_monthly'))).outcome, 'ignored_other_product');
  const row = await ent(u);
  assert.deepEqual([row.plan, row.status, row.cancel_at_period_end], ['life_os', 'active', false]);
});

test('a refund delivered before its purchase still ends access when the purchase lands (and on redelivery)', async () => {
  const u = await newUser();
  const purchase = ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly');
  const refund = ev('CANCELLATION', u, 'apm_autopilot_monthly', { cancel_reason: 'CUSTOMER_SUPPORT' }); // t + 1s
  assert.equal((await apply(refund)).outcome, 'deferred');
  const out = await apply(purchase);
  assert.deepEqual([out.outcome, out.status], ['applied', 'expired']);
  assert.deepEqual(await access(u), { core: false, life: false, auto: false });
  assert.equal((await apply(refund)).outcome, 'applied_deferred', 'redelivery returns the resolved outcome');
  assert.equal((await ent(u)).status, 'expired');
  assert.equal((await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type = 'billing.refund' and metadata->>'deferred' = 'true'", [u])).rows[0].n, 1);
  // An auto-renew-off cancellation that came first only sets cancel-at-period-end.
  const v = await newUser();
  const p2 = ev('INITIAL_PURCHASE', v, 'apm_cos_monthly');
  await apply(ev('CANCELLATION', v, 'apm_cos_monthly', { cancel_reason: 'UNSUBSCRIBE' }));
  await apply(p2);
  assert.deepEqual([(await ent(v)).status, (await ent(v)).cancel_at_period_end], ['active', true]);
  // A deferred refund OLDER than the grant (e.g. a refunded earlier purchase) does not end a newer one.
  const w = await newUser();
  const oldRefund = ev('REFUND', w, 'apm_cos_monthly');
  await apply(oldRefund);
  await apply(ev('INITIAL_PURCHASE', w, 'apm_cos_monthly'));
  assert.equal((await ent(w)).status, 'active');
});

test('beta is an explicit allowlist with an end date, and never outranks a paid or lapsed state', async () => {
  const never = U(5001); const tester = U(5002); const payer = U(5003);
  await service("select public.apm_service_beta_grant('tester@example.com', now() + interval '30 days', 'invited')");
  await rejects(service("select public.apm_service_beta_grant('x@example.com', now() + interval '400 days', null)"), /billing_invalid_request/);
  await rejects(service("select public.apm_service_beta_grant('x@example.com', null, null)"), /billing_invalid_request/);
  await admin("insert into auth.users (id, email) values ($1, 'never@example.com'), ($2, 'Tester@Example.com'), ($3, 'payer@example.com')", [never, tester, payer]);
  // A fresh, never-paid, non-allowlisted account has no access.
  assert.deepEqual([(await ent(never)).plan, (await ent(never)).status], ['beta', 'expired']);
  assert.equal((await access(never)).core, false);
  // An allowlisted account has beta access until its end date.
  assert.equal((await access(tester)).core, true);
  assert.ok(new Date((await ent(tester)).current_period_end) > new Date());
  await admin("update public.subscription_entitlements set current_period_end = now() - interval '1 minute' where user_id = $1", [tester]);
  assert.equal((await access(tester)).core, false, 'the end date is enforced at the access check, not only by the sweep');
  await service('select public.apm_service_billing_expire_lapsed()');
  assert.equal((await ent(tester)).status, 'expired');
  // Paid, then lapsed: the lapsed state governs, an allowlist entry never restores beta.
  await apply(ev('INITIAL_PURCHASE', payer, 'apm_cos_monthly'));
  await apply(ev('EXPIRATION', payer, 'apm_cos_monthly'));
  await service("select public.apm_service_beta_grant('payer@example.com', now() + interval '30 days', 'should not apply')");
  const row = await ent(payer);
  assert.deepEqual([row.plan, row.status], ['chief_of_staff', 'expired']);
  assert.equal((await access(payer)).core, false);
  // The never-paid user gets nothing the lapsed payer lacks.
  assert.equal((await access(never)).core, (await access(payer)).core);
});

test('never trusts identity, product, store or environment it cannot verify', async () => {
  const u = await newUser();
  const cases = [
    [ev('INITIAL_PURCHASE', '$RCAnonymousID:abc', 'apm_autopilot_monthly'), 'ignored_unknown_user'],
    [ev('INITIAL_PURCHASE', U(999999), 'apm_autopilot_monthly'), 'ignored_unknown_user'],
    [ev('INITIAL_PURCHASE', u, 'apm_autopilot_lifetime'), 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'), store: 'PLAY_STORE' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'), store: 'STRIPE' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'), store: 'PROMOTIONAL' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', u, 'apm_autopilot_monthly'), environment: 'SANDBOX' }, 'ignored_environment'],
    [ev('TEST', u, 'apm_autopilot_monthly'), 'ignored_test'],
    [ev('TRANSFER', u, 'apm_autopilot_monthly'), 'ignored_unhandled_type'],
    [ev('NON_RENEWING_PURCHASE', u, 'apm_autopilot_monthly'), 'ignored_unhandled_type'],
  ];
  for (const [event, outcome] of cases) assert.equal((await apply(event)).outcome, outcome, JSON.stringify(event));
  assert.equal((await ent(u)).plan, 'beta');
  assert.equal((await ent(u)).provider, null);
  // Sandbox is accepted only when the Worker says so (staging).
  assert.equal((await apply({ ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), environment: 'SANDBOX' }, true)).outcome, 'applied');

  // Malformed events are refused outright (the Worker answers 400 / RevenueCat retries).
  const bad = [
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), entitlement_ids: ['autopilot'] },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), id: '' },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), type: 'initial; drop' },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), event_timestamp_ms: '1' },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), event_timestamp_ms: null },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), product_id: { x: 1 } },
    { ...ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'), expiration_at_ms: null },
  ];
  for (const event of bad) await rejects(apply(event), /billing_invalid_event/);
});

test('0092 web channel: RevenueCat Web Billing (RC_BILLING / STRIPE) grants the mapped plan; channels never cross', async () => {
  // Before 0092 this exact event was dropped as ignored_unknown_product.
  const u = await newUser();
  const out = await apply(ev('INITIAL_PURCHASE', u, 'apm_web_lifeos_annual'));
  assert.equal(out.outcome, 'applied');
  assert.deepEqual([(await ent(u)).plan, (await ent(u)).status, (await ent(u)).provider, (await ent(u)).billing_period, (await ent(u)).store_product_id],
    ['life_os', 'active', 'web', 'annual', 'apm_web_lifeos_annual']);
  assert.equal((await access(u)).life, true);
  // Stripe Billing integration events map to the same channel.
  const s = await newUser();
  assert.equal((await apply({ ...ev('INITIAL_PURCHASE', s, 'apm_web_autopilot_monthly'), store: 'STRIPE' })).outcome, 'applied');
  assert.equal((await ent(s)).provider, 'web');
  // Upgrade on the web channel stays on the web channel.
  assert.equal((await apply({ ...ev('PRODUCT_CHANGE', u, 'apm_web_lifeos_annual'), new_product_id: 'apm_web_autopilot_annual' })).outcome, 'applied');
  assert.equal((await ent(u)).plan, 'autopilot');
  // Channels never cross: a web store with a store product, a store with a web product, a web product to a store product.
  const x = await newUser();
  for (const [event, outcome] of [
    [{ ...ev('INITIAL_PURCHASE', x, 'apm_autopilot_monthly'), store: 'RC_BILLING' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', x, 'apm_web_autopilot_monthly'), store: 'APP_STORE' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', x, 'apm_web_autopilot_monthly'), store: 'PLAY_STORE' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', x, 'apm_web_autopilot_monthly'), store: 'PADDLE' }, 'ignored_unknown_product'],
    [{ ...ev('INITIAL_PURCHASE', x, 'apm_web_autopilot_monthly'), environment: 'SANDBOX' }, 'ignored_environment'],
  ]) assert.equal((await apply(event)).outcome, outcome, JSON.stringify(event));
  assert.deepEqual([(await ent(x)).plan, (await ent(x)).provider], ['beta', null]);
  assert.equal((await apply({ ...ev('PRODUCT_CHANGE', s, 'apm_web_autopilot_monthly'), new_product_id: 'apm_autopilot_annual' })).outcome, 'ignored_unknown_product');
  // Founding 100 on the web: the founding web product claims a slot like the store ones.
  const f = await newUser();
  assert.equal((await apply(ev('INITIAL_PURCHASE', f, 'apm_web_cos_monthly_founding'))).outcome, 'applied');
  assert.deepEqual([(await ent(f)).offer, (await slot(f))?.status], ['founding', 'claimed']);
  // The sweep covers web entitlements.
  await admin("update public.subscription_entitlements set current_period_end = now() - interval '2 days' where user_id = $1", [s]);
  await service('select public.apm_service_billing_expire_lapsed()');
  assert.equal((await ent(s)).status, 'expired');
  // A client can never write the web provider either.
  await rejects(asRole('authenticated', x, "update public.subscription_entitlements set provider = 'web', plan = 'autopilot', status = 'active' where user_id = $1", [x]), /permission denied/);
  await rejects(admin("update public.subscription_entitlements set provider = 'stripe' where user_id = $1", [x]), /check constraint/);
});

test('Founding 100: only paid founding subscriptions hold a slot — 99 gives one, 100 gives none, never 101', async () => {
  await admin('delete from private.billing_founding_slots');
  const claimedSlots = async () => (await admin('select count(*)::int as n from private.billing_founding_slots')).rows[0].n;
  const founders = [];
  for (let i = 0; i < 99; i += 1) founders.push(await newUser());
  await admin(`insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at)
    select row_number() over (), u, 'claimed', now() from unnest($1::uuid[]) u`, [founders]);
  // Viewing the paywall reserves nothing: any number of views hold no slot.
  const viewers = [];
  for (let i = 0; i < 5; i += 1) { const v = await newUser(); viewers.push(v); assert.equal((await offering(v)).offering, 'founding'); }
  assert.equal(await claimedSlots(), 99);
  // The public count (GET /v1/billing/founding, the join button and aplayermode.com) reads this.
  const spotsLeft = async () => (await service('select public.apm_service_billing_founding_spots_left() as n')).rows[0].n;
  assert.equal(await spotsLeft(), 1, 'under 100: places remain');
  assert.equal((await offering(viewers[0])).reservedUntil, null);

  // Two buyers race for the last slot: exactly one gets the lock; the other keeps access at standard.
  const [x, y] = viewers;
  await Promise.all([apply(ev('INITIAL_PURCHASE', x, 'apm_cos_monthly_founding')), apply(ev('INITIAL_PURCHASE', y, 'apm_cos:founding-monthly'))]);
  const offers = [(await ent(x)).offer, (await ent(y)).offer].sort();
  assert.deepEqual(offers, ['founding', 'standard']);
  assert.equal(await claimedSlots(), 100);
  const loser = (await ent(x)).offer === 'founding' ? y : x;
  assert.deepEqual([(await ent(loser)).plan, (await ent(loser)).status], ['chief_of_staff', 'active']);
  assert.equal((await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type = 'billing.founding_without_slot'", [loser])).rows[0].n, 1);
  // At 100 nobody new is offered it, and the public count says none are left.
  assert.equal((await offering(viewers[2])).offering, 'default');
  assert.equal(await spotsLeft(), 0, 'at 100: none left');
  assert.equal((await admin('select max(slot_no)::int as m from private.billing_founding_slots')).rows[0].m, 100);
  await rejects(admin("insert into private.billing_founding_slots (slot_no, user_id, status) values (101, $1, 'claimed')", [viewers[3]]), /check constraint/);
  await rejects(admin("insert into private.billing_founding_slots (slot_no, user_id, status) values (50, $1, 'reserved')", [viewers[3]]), /check constraint|duplicate key/);
  // Over 100: a founding purchase with no place left claims nothing; the count stays 0, never negative.
  const overflow = await newUser();
  await apply(ev('INITIAL_PURCHASE', overflow, 'apm_web_cos_monthly_founding'));
  assert.equal((await ent(overflow)).offer, 'standard');
  assert.equal(await slot(overflow), undefined);
  assert.equal(await claimedSlots(), 100);
  assert.equal(await spotsLeft(), 0, 'over 100: still none, never negative');

  // A lapse frees the slot for someone else and the lapsed founder never gets it back.
  const lapsed = founders[0];
  await admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active', provider = 'app_store', store_product_id = 'apm_cos_monthly_founding', offer = 'founding' where user_id = $1", [lapsed]);
  await apply(ev('EXPIRATION', lapsed, 'apm_cos_monthly_founding'));
  assert.equal(await slot(lapsed), undefined);
  assert.equal(await claimedSlots(), 99);
  assert.equal((await offering(lapsed)).offering, 'default');
  await apply(ev('INITIAL_PURCHASE', lapsed, 'apm_cos_monthly_founding'));
  assert.equal((await ent(lapsed)).offer, 'standard', 're-subscribing never restores the lock');
  const next = viewers[3];
  assert.equal((await offering(next)).offering, 'founding', 'the freed slot is offered again');
  await apply(ev('INITIAL_PURCHASE', next, 'apm_cos_monthly_founding'));
  assert.equal((await slot(next)).status, 'claimed');

  // A former subscriber is never offered founding and never takes a slot, even when one is free.
  await admin('delete from private.billing_founding_slots where user_id = $1', [next]);
  const former = await newUser();
  await apply(ev('INITIAL_PURCHASE', former, 'apm_cos_annual'));
  await apply(ev('PRODUCT_CHANGE', former, 'apm_cos_annual', { new_product_id: 'apm_cos_monthly_founding' }));
  await apply(ev('RENEWAL', former, 'apm_cos_monthly_founding'));
  assert.equal(await slot(former), undefined);
  assert.equal((await offering(former)).offering, 'default');
  // Moving off the founding product lapses the lock.
  const mover = viewers[4];
  await apply(ev('INITIAL_PURCHASE', mover, 'apm_cos_monthly_founding'));
  assert.equal((await slot(mover)).status, 'claimed');
  await apply(ev('PRODUCT_CHANGE', mover, 'apm_cos_monthly_founding', { new_product_id: 'apm_autopilot_monthly' }));
  assert.equal(await slot(mover), undefined);
  assert.deepEqual([(await ent(mover)).plan, (await ent(mover)).offer], ['autopilot', 'standard']);
});

test('the sweep expires store entitlements past period end + 1 day, and a late renewal restores them', async () => {
  const u = await newUser();
  await apply(ev('INITIAL_PURCHASE', u, 'apm_cos_monthly'));
  await admin("update public.subscription_entitlements set current_period_end = now() - interval '2 days' where user_id = $1", [u]);
  const fresh = await newUser();
  await apply(ev('INITIAL_PURCHASE', fresh, 'apm_cos_monthly'));
  await admin("update public.subscription_entitlements set current_period_end = now() - interval '2 hours' where user_id = $1", [fresh]);
  const swept = (await service('select public.apm_service_billing_expire_lapsed() as n')).rows[0].n;
  assert.ok(swept >= 1);
  assert.equal((await ent(u)).status, 'expired');
  assert.equal((await ent(fresh)).status, 'active', 'inside the one-day slack');
  // C was never allowlisted: no beta access to sweep (0044); store rows are swept as before.
  assert.deepEqual([(await ent(C)).plan, (await ent(C)).status], ['beta', 'expired']);
  await apply(ev('RENEWAL', u, 'apm_cos_monthly'));
  assert.equal((await ent(u)).status, 'active');
});

test('reconcile (8 Oct 2026): RevenueCat\'s own record grants through the webhook writer; idempotent with the webhook; lapsed never grants', async () => {
  const now = Date.now();
  const sub = (user, overrides = {}) => ({ id: `subRc${user.slice(-6)}`, customer_id: user, product_id: 'prod55a7776fc5', store: 'rc_billing', environment: 'production',
    status: 'active', gives_access: true, auto_renewal_status: 'will_renew', current_period_starts_at: now - 60_000, current_period_ends_at: now + 30 * DAY, ...overrides });
  const reconcile = async (user, subs, allowSandbox = false) => {
    const out = [];
    for (const event of billing.reconcileEventsFor(user, subs, now)) out.push(await apply(event, allowSandbox));
    return out;
  };
  // The webhook never arrived: reconcile alone turns the paid plan on.
  const u = await newUser();
  assert.equal((await ent(u))?.plan ?? 'beta', 'beta');
  assert.deepEqual((await reconcile(u, [sub(u)])).map((r) => r.outcome), ['applied']);
  assert.deepEqual([(await ent(u)).plan, (await ent(u)).status, (await ent(u)).provider, (await ent(u)).store_product_id], ['chief_of_staff', 'active', 'web', 'apm_web_cos_monthly']);
  assert.equal((await access(u)).core, true);
  // Reconciling again is a replay: no second write, no second audit.
  const audits = async () => Number((await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type like 'billing.%'", [u])).rows[0].n);
  const before = await audits();
  assert.deepEqual((await reconcile(u, [sub(u)])).map((r) => [r.outcome, r.replayed]), [['applied', true]]);
  assert.equal(await audits(), before);
  // The webhook then arrives (late): same state, nothing doubled, and a later cancellation still lands.
  const purchase = { id: 'evt-late-initial', type: 'INITIAL_PURCHASE', app_user_id: u, product_id: 'apm_web_cos_monthly', store: 'RC_BILLING', environment: 'PRODUCTION', event_timestamp_ms: now - 59_000, expiration_at_ms: now + 30 * DAY };
  assert.equal((await apply(purchase)).outcome, 'applied');
  assert.equal((await apply(purchase)).replayed, true);
  assert.deepEqual([(await ent(u)).plan, (await ent(u)).status], ['chief_of_staff', 'active']);
  assert.equal((await apply({ ...purchase, id: 'evt-late-cancel', type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', event_timestamp_ms: now - 1_000 })).outcome, 'applied');
  assert.equal((await ent(u)).cancel_at_period_end, true);
  // A sandbox purchase from a user who is NOT on the tester allowlist stays refused (the Worker passes false).
  const s = await newUser();
  assert.deepEqual((await reconcile(s, [sub(s, { environment: 'sandbox' })], false)).map((r) => r.outcome), ['ignored_environment']);
  assert.equal((await ent(s))?.plan ?? 'beta', 'beta');
  assert.equal((await access(s)).core, false);
  // ...and a listed tester's sandbox purchase is honoured.
  const t = await newUser();
  assert.deepEqual((await reconcile(t, [sub(t, { environment: 'sandbox' })], true)).map((r) => r.outcome), ['applied']);
  assert.equal((await ent(t)).plan, 'chief_of_staff');
  // Lapsed (no access now, or the period is over): no event, no access.
  const l = await newUser();
  for (const lapsed of [sub(l, { gives_access: false, status: 'expired' }), sub(l, { current_period_ends_at: now - 1 })]) {
    assert.deepEqual(await reconcile(l, [lapsed]), []);
  }
  assert.equal((await ent(l))?.plan ?? 'beta', 'beta');
  assert.equal((await access(l)).core, false);
  // Auto-renew off at reconcile time: access to period end, flagged to stop.
  const c = await newUser();
  assert.deepEqual((await reconcile(c, [sub(c, { auto_renewal_status: 'will_not_renew' })])).map((r) => r.outcome), ['applied', 'applied']);
  assert.deepEqual([(await ent(c)).status, (await ent(c)).cancel_at_period_end], ['active', true]);
});

test('0096 checkout links: a pay-first checkout attaches to an EXISTING account only with its email, once, and the writer follows it', async () => {
  const owner = await newUser();
  await admin("update auth.users set email = 'Buyer@Example.com' where id = $1", [owner]);
  const other = await newUser();
  await admin("update auth.users set email = 'other@example.com' where id = $1", [other]);
  const checkout = U(9601);
  const link = async (c, u, e) => (await service('select public.apm_service_billing_link_checkout($1::uuid, $2::uuid, $3) as r', [c, u, e])).rows[0].r;
  const ownerOf = async (c) => (await service('select public.apm_service_billing_checkout_owner($1::uuid)::text as r', [c])).rows[0].r;
  const idsOf = async (u) => (await service('select public.apm_service_billing_checkout_ids($1::uuid) as r', [u])).rows[0].r;
  // Before any link: the webhook for the checkout id is ignored_unknown_user (nothing granted).
  assert.equal((await apply(ev('INITIAL_PURCHASE', checkout, 'apm_web_cos_monthly'))).outcome, 'ignored_unknown_user');
  assert.equal((await ent(owner))?.plan ?? 'beta', 'beta');
  // The email must be the account's own (the code-proven session's): a wrong one links nothing.
  assert.deepEqual(await link(checkout, owner, 'someone@else.com'), { linked: false, reason: 'email_mismatch' });
  assert.equal(await ownerOf(checkout), null);
  // A checkout id that is itself an account is never linked; a self-link is invalid.
  assert.deepEqual(await link(other, owner, 'buyer@example.com'), { linked: false, reason: 'already_claimed' });
  await rejects(link(owner, owner, 'buyer@example.com'), /billing_invalid_request/);
  // The link (case-insensitive email), then a replay by the same account.
  assert.deepEqual(await link(checkout, owner, ' buyer@EXAMPLE.com '), { linked: true, replayed: false });
  assert.deepEqual(await link(checkout, owner, 'buyer@example.com'), { linked: true, replayed: true });
  // A second claim by another account never moves it.
  await admin("update auth.users set email = 'buyer@example.com' where id = $1", [other]);
  assert.deepEqual(await link(checkout, other, 'buyer@example.com'), { linked: false, reason: 'already_claimed' });
  assert.equal(await ownerOf(checkout), owner);
  assert.deepEqual(await idsOf(owner), [checkout]);
  assert.deepEqual(await idsOf(other), []);
  // The writer follows the link: grant, renewal, cancellation all land on the existing account.
  assert.equal((await apply(ev('INITIAL_PURCHASE', checkout, 'apm_web_cos_monthly_founding'))).outcome, 'applied');
  assert.deepEqual([(await ent(owner)).plan, (await ent(owner)).status, (await ent(owner)).provider], ['chief_of_staff', 'active', 'web']);
  assert.equal((await apply(ev('CANCELLATION', checkout, 'apm_web_cos_monthly_founding', { cancel_reason: 'UNSUBSCRIBE' }))).outcome, 'applied');
  assert.equal((await ent(owner)).cancel_at_period_end, true);
  assert.equal((await admin('select user_id::text from private.billing_events where app_user_id = $1 and outcome = $2 limit 1', [checkout, 'applied'])).rows[0].user_id, owner);
  // Even if an account with id = checkout id appeared later, the link wins: one payment, one account.
  await admin('insert into auth.users (id, email) values ($1, $2)', [checkout, 'late@example.com']);
  const renewal = ev('RENEWAL', checkout, 'apm_web_cos_monthly_founding');
  assert.equal((await apply(renewal)).outcome, 'applied');
  assert.equal((await admin('select user_id::text from private.billing_events where event_id = $1', [renewal.id])).rows[0].user_id, owner);
  assert.notEqual((await ent(checkout))?.plan, 'chief_of_staff', 'the late account got nothing');
  assert.equal((await ent(owner)).cancel_at_period_end, false, 'the renewal landed on the owner');
  // Audited; and no client can link, read the links, or ask who owns a checkout.
  assert.equal((await admin("select count(*)::int as n from public.audit_events where user_id = $1 and event_type = 'billing.checkout_linked'", [owner])).rows[0].n, 1);
  for (const role of ['authenticated', 'anon']) {
    await rejects(asRole(role, owner, 'select public.apm_service_billing_link_checkout($1::uuid, $2::uuid, $3)', [U(9602), owner, 'buyer@example.com']), /permission denied/);
    await rejects(asRole(role, owner, 'select public.apm_service_billing_checkout_ids($1::uuid)', [owner]), /permission denied/);
    await rejects(asRole(role, owner, 'select public.apm_service_billing_checkout_owner($1::uuid)', [checkout]), /permission denied/);
    await rejects(asRole(role, owner, 'select * from private.billing_checkout_links'), /permission denied/);
  }
});

test('0097: a paid, unclaimed pay-first founding checkout holds a place, so the founding price is never sold past 100', async () => {
  await admin('delete from private.billing_founding_slots');
  const spotsLeft = async () => (await service('select public.apm_service_billing_founding_spots_left() as n')).rows[0].n;
  const founders = [];
  for (let i = 0; i < 98; i += 1) founders.push(await newUser());
  await admin(`insert into private.billing_founding_slots (slot_no, user_id, status, claimed_at)
    select row_number() over (), u, 'claimed', now() from unnest($1::uuid[]) u`, [founders]);
  const viewer = await newUser();
  assert.equal(await spotsLeft(), 2, 'under 100: 98 claimed, none pending');
  // Two buyers pay before any account exists (ignored_unknown_user): both places are now taken.
  const [p1, p2] = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of [p1, p2]) assert.equal((await apply(ev('INITIAL_PURCHASE', id, 'apm_web_cos_monthly_founding'))).outcome, 'ignored_unknown_user');
  assert.equal(await spotsLeft(), 0, 'at 100: 98 claimed + 2 paid and waiting');
  assert.equal((await offering(viewer)).offering, 'default', 'nobody new is offered the founding price');
  // None of these hold a place: a standard product, a sandbox payment, an expired one, a malformed id.
  await apply(ev('INITIAL_PURCHASE', crypto.randomUUID(), 'apm_web_cos_monthly'));
  await apply(ev('INITIAL_PURCHASE', crypto.randomUUID(), 'apm_web_cos_monthly_founding', { environment: 'SANDBOX' }));
  await apply(ev('INITIAL_PURCHASE', crypto.randomUUID(), 'apm_web_cos_monthly_founding', { expiration_at_ms: T0 - DAY }));
  await apply(ev('INITIAL_PURCHASE', 'not-a-uuid', 'apm_web_cos_monthly_founding'));
  assert.equal((await service('select private.apm_billing_founding_pending(now()) as n')).rows[0].n, 2);
  // A repeat event for the same checkout is still one place.
  await apply(ev('RENEWAL', p1, 'apm_web_cos_monthly_founding'));
  assert.equal(await spotsLeft(), 0);
  // Claimed: the account now exists with the checkout id, the purchase applies and takes a real slot.
  await admin('insert into auth.users (id) values ($1)', [p1]);
  await apply(ev('INITIAL_PURCHASE', p1, 'apm_web_cos_monthly_founding'));
  assert.equal((await ent(p1)).offer, 'founding');
  assert.equal((await admin('select count(*)::int as n from private.billing_founding_slots')).rows[0].n, 99);
  assert.equal(await spotsLeft(), 0, '99 claimed + 1 still waiting');
  // Over 100: the waiting buyer still gets the last slot when they claim; nobody else can.
  assert.equal((await offering(viewer)).offering, 'default');
  // Attached to an existing account instead (0096): it stops counting as waiting.
  const owner = await newUser();
  await admin('insert into private.billing_checkout_links (checkout_id, user_id) values ($1, $2)', [p2, owner]);
  assert.equal(await spotsLeft(), 1, 'linked checkouts are counted through their account, not as waiting');
  // Closed to every client role.
  await rejects(asRole('anon', null, 'select private.apm_billing_founding_pending(now())'), /permission denied/);
  await rejects(asRole('authenticated', viewer, 'select private.apm_billing_founding_taken(now())'), /permission denied/);
});
