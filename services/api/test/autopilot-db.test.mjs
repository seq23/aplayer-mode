// Executes the real Autopilot migrations (0018, 0019) in an embedded Postgres (PGlite)
// on a minimal Supabase-shaped substrate (auth.uid(), anon/authenticated roles,
// Supabase's default public-schema grants, and the 0005 tables 0018 depends on
// with their production own-row policies) and proves, as the `authenticated`
// role with a valid JWT subject, that:
//   * no client can write any Autopilot table directly;
//   * buying Autopilot alone never grants standing authority: a rule, a level-5
//     permission and an activated class are all required;
//   * claims enforce the rule (window, weekday, duration, horizon, collision,
//     recipients, daily cap), idempotency and the master pause, and audit
//     atomically;
//   * stopping authority (pause, revoke, master pause, undo) works after
//     downgrade, while ordinary reads need the entitlement and the data-rights
//     export still returns retained rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migration = (name) => readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const USER_C = '00000000-0000-4000-8000-00000000000c';

const SUBSTRATE = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
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
  create table public.permissions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    domain text not null, action_type text not null,
    autonomy_level integer not null default 0 check (autonomy_level between 0 and 5),
    constraints jsonb not null default '{}'::jsonb,
    enabled boolean not null default true,
    granted_at timestamptz, updated_at timestamptz not null default now(),
    unique(user_id, domain, action_type)
  );
  create table public.actions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    domain text not null, action_type text not null,
    status text not null default 'proposed' check (status in ('proposed','prepared','approved','executing','executed','verified','closed','failed','cancelled')),
    payload jsonb not null default '{}'::jsonb,
    reason text not null,
    permission_id uuid references public.permissions(id) on delete set null,
    idempotency_key text not null,
    requires_approval boolean not null default true,
    approved_at timestamptz, executed_at timestamptz, verified_at timestamptz, failure_code text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    unique(user_id, idempotency_key)
  );
  create table public.action_attempts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    action_id uuid not null references public.actions(id) on delete cascade,
    attempt integer not null,
    status text not null check (status in ('started','succeeded','failed')),
    provider text, external_ref text, error_code text,
    started_at timestamptz not null default now(), completed_at timestamptz,
    unique(action_id, attempt)
  );
  create table public.integration_connections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null, kind text not null,
    status text not null default 'connected'
  );
  create table public.calendar_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    provider text not null default 'device',
    external_event_id text not null default gen_random_uuid()::text,
    title text not null default '',
    starts_at timestamptz not null, ends_at timestamptz not null,
    availability text not null default 'busy',
    deleted boolean not null default false
  );
  do $$
  declare t text;
  begin
    foreach t in array array['permissions','actions','action_attempts','integration_connections','calendar_events'] loop
      execute format('alter table public.%I enable row level security', t);
      execute format('create policy %I on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t || '_own', t);
    end loop;
  end $$;
  alter table public.audit_events enable row level security;
  alter table public.subscription_entitlements enable row level security;
  create policy audit_events_select_own on public.audit_events for select to authenticated using (auth.uid() = user_id);
  create policy audit_events_insert_own on public.audit_events for insert to authenticated with check (auth.uid() = user_id);
  create policy entitlements_select_own on public.subscription_entitlements for select to authenticated using (auth.uid() = user_id);
`;

let db;
const conn = {};

async function admin(sql, params) {
  await db.exec('reset role');
  return db.query(sql, params);
}

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
const auditCount = async (eventType, userId = USER_A) => Number((await admin('select count(*)::int as n from public.audit_events where event_type = $1 and user_id = $2', [eventType, userId])).rows[0].n);
const setPlan = (userId, plan, status) => admin(
  `insert into public.subscription_entitlements (user_id, plan, status) values ($1, $2, $3)
   on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`,
  [userId, plan, status],
);
const setPermission = (userId, domain, actionType, level, enabled = true) => admin(
  `insert into public.permissions (user_id, domain, action_type, autonomy_level, enabled) values ($1, $2, $3, $4, $5)
   on conflict (user_id, domain, action_type) do update set autonomy_level = excluded.autonomy_level, enabled = excluded.enabled`,
  [userId, domain, actionType, level, enabled],
);
const activate = (cls) => admin(`update public.autopilot_action_classes set activation_status = 'active', evidence_ref = 'test-receipt', activated_at = now() where class_key = $1`, [cls]);
const deactivate = (cls) => admin(`update public.autopilot_action_classes set activation_status = 'inactive', evidence_ref = null, activated_at = null where class_key = $1`, [cls]);

const DAY = 86_400_000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

// A UTC-anchored rule so the test is independent of the host timezone: every
// weekday, 00:00–23:59, so the only window edge is midnight.
const calendarConstraints = (overrides = {}) => ({
  timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '00:00', windowEnd: '23:59',
  maxDurationMinutes: 90, maxPerDay: 2, horizonDays: 14, collision: 'never_overlap_busy', ...overrides,
});
const emailConstraints = (overrides = {}) => ({
  timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '00:00', windowEnd: '23:59',
  maxPerDay: 1, allowedRecipientDomains: ['school.example.org'], ...overrides,
});

/** A slot on day +N at HH:00 UTC lasting `minutes`. */
function slot(daysAhead, hour, minutes = 60) {
  const start = new Date(Date.now() + daysAhead * DAY);
  start.setUTCHours(hour, 0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
}

const grant = (userId, cls, constraints, expiresAt = inDays(30)) =>
  rpc(userId, 'apm_autopilot_grant_rule', '$1, $2::jsonb, $3::timestamptz', [cls, JSON.stringify(constraints), expiresAt]);
const claim = (userId, ruleId, key, payload, reason = 'Morning routine block') =>
  rpc(userId, 'apm_autopilot_claim', '$1::uuid, $2, $3::jsonb, $4', [ruleId, key, JSON.stringify(payload), reason]);

test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of ['0018_autopilot_standing_rules.sql', '0019_autopilot_draft_header_hardening.sql']) {
    await db.exec(await migration(name));
  }
  await admin(`insert into auth.users (id) values ('${USER_A}'), ('${USER_B}'), ('${USER_C}')`);
  await setPlan(USER_A, 'autopilot', 'active');
  await setPlan(USER_B, 'life_os', 'active');
  await setPlan(USER_C, 'autopilot', 'trialing');
  for (const [user, kind] of [[USER_A, 'calendar'], [USER_A, 'email'], [USER_B, 'calendar'], [USER_C, 'calendar']]) {
    conn[`${user}:${kind}`] = (await admin(`insert into public.integration_connections (user_id, provider, kind) values ($1, 'google', $2) returning id`, [user, kind])).rows[0].id;
  }
});

test.after(async () => { await db?.close(); });

test('no direct client writes to any Autopilot table; only SELECT policies exist', async () => {
  const rule = await grant(USER_A, 'calendar.create', calendarConstraints());
  await rejects(as(USER_A, `insert into public.autopilot_rules (user_id, action_class, constraints, expires_at)
    values ('${USER_A}', 'calendar.create', '{}', now() + interval '1 day')`), /permission denied/);
  await rejects(as(USER_A, `update public.autopilot_rules set status = 'active', expires_at = now() + interval '5 years' where id = $1`, [rule.id]), /permission denied/);
  await rejects(as(USER_A, `delete from public.autopilot_rules where id = $1`, [rule.id]), /permission denied/);
  await rejects(as(USER_A, `insert into public.autopilot_executions (user_id, rule_id, rule_version, action_class, idempotency_key, local_day)
    values ('${USER_A}', '${rule.id}', 1, 'calendar.create', 'forged-key-1', current_date)`), /permission denied/);
  await rejects(as(USER_A, `insert into public.autopilot_settings (user_id, paused) values ('${USER_A}', false)`), /permission denied/);
  await rejects(as(USER_A, `update public.autopilot_action_classes set activation_status = 'active', evidence_ref = 'me', activated_at = now()`), /permission denied/);
  await rejects(as(USER_A, `insert into public.autopilot_action_classes (class_key, domain, action_type, reversible, undo_method) values ('email.draft','email','email.draft',true,'delete_draft')`), /permission denied/);
  await rejects(asAnon(`select * from public.autopilot_rules`), /permission denied/);
  await rejects(asAnon(`select * from public.autopilot_action_classes`), /permission denied/);

  const policies = (await admin(`select tablename, cmd from pg_policies where tablename like 'autopilot_%' order by 1, 2`)).rows;
  assert.deepEqual(policies, [
    { tablename: 'autopilot_action_classes', cmd: 'SELECT' },
    { tablename: 'autopilot_executions', cmd: 'SELECT' },
    { tablename: 'autopilot_rules', cmd: 'SELECT' },
    { tablename: 'autopilot_settings', cmd: 'SELECT' },
  ]);
  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});

test('anon cannot execute any Autopilot RPC; definers stay out of the exposed schema with pinned search_path', async () => {
  await rejects(asAnon(`select public.apm_autopilot_grant_rule('calendar.create', '{}'::jsonb, now())`), /permission denied/);
  await rejects(asAnon(`select public.apm_autopilot_data_rights_export()`), /permission denied/);
  await rejects(asAnon(`select private.apm_autopilot_claim(gen_random_uuid(), 'k', '{}'::jsonb, 'r')`), /permission denied/);
  await rejects(as(USER_A, `select private.apm_autopilot_audit('${USER_A}', 'x', 'y', gen_random_uuid(), '{}'::jsonb)`), /permission denied/);
  await rejects(as(USER_A, `select private.apm_autopilot_check_constraints('calendar.create', '{}'::jsonb)`), /permission denied/);

  const exposedDefiners = (await admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'apm_autopilot%' and p.prosecdef`)).rows;
  assert.deepEqual(exposedDefiners, []);
  const unpinned = (await admin(`select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (p.proname like 'apm_autopilot%' or p.proname = 'apm_has_autopilot_access') and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows;
  assert.deepEqual(unpinned, []);
});

test('every supported class ships inactive; the catalogue is the whole allow-list', async () => {
  const classes = (await admin(`select class_key, activation_status, reversible from public.autopilot_action_classes order by 1`)).rows;
  assert.deepEqual(classes, [
    { class_key: 'calendar.create', activation_status: 'inactive', reversible: true },
    { class_key: 'email.draft', activation_status: 'inactive', reversible: true },
  ]);
  for (const forbidden of ['purchase.order', 'healthcare.book', 'financial.pay_bill', 'email.send', 'calendar.update']) {
    await rejects(grant(USER_A, forbidden, calendarConstraints()), /autopilot_unsupported_action_class/);
  }
});

test('only an active/trialing Autopilot entitlement can grant; rule constraints and expiry are validated', async () => {
  await rejects(grant(USER_B, 'calendar.create', calendarConstraints()), /autopilot_required/);
  await rejects(grant(null, 'calendar.create', calendarConstraints()), /autopilot_unauthenticated/);
  await rejects(grant(USER_A, 'calendar.create', { ...calendarConstraints(), extra: true }), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints({ windowStart: '09:00', windowEnd: '08:00' })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints({ maxDurationMinutes: 600 })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints({ weekdays: [1, 8] })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints({ timezone: 'Mars/Olympus' })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints({ collision: 'override' })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'email.draft', emailConstraints({ allowedRecipientDomains: [] })), /autopilot_invalid_constraints/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints(), inDays(91)), /autopilot_invalid_expiry/);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints(), inDays(-1)), /autopilot_invalid_expiry/);

  const before = await auditCount('autopilot.rule_granted');
  const rule = await grant(USER_A, 'calendar.create', calendarConstraints());
  assert.equal(rule.status, 'active');
  assert.equal(rule.version, 1);
  assert.equal(await auditCount('autopilot.rule_granted'), before + 1);
  await rejects(grant(USER_A, 'calendar.create', calendarConstraints()), /autopilot_rule_exists/);
  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});

test('buying Autopilot alone is not authority: permission 5 and an activated class are both required', async () => {
  const rule = await grant(USER_A, 'calendar.create', calendarConstraints());
  const payload = { connectionId: conn[`${USER_A}:calendar`], title: 'Run', ...slot(2, 6) };

  // Class inactive (the shipped state) -> fail closed.
  await setPermission(USER_A, 'calendar', 'calendar.create', 5);
  await rejects(claim(USER_A, rule.id, 'idem-inactive-1', payload), /autopilot_class_not_activated/);

  await activate('calendar.create');
  await setPermission(USER_A, 'calendar', 'calendar.create', 4);
  await rejects(claim(USER_A, rule.id, 'idem-perm-low-1', payload), /autopilot_permission_required/);
  await setPermission(USER_A, 'calendar', 'calendar.create', 5, false);
  await rejects(claim(USER_A, rule.id, 'idem-perm-off-1', payload), /autopilot_permission_required/);
  await setPermission(USER_A, 'calendar', 'calendar.create', 5);

  // Another user cannot run A's rule.
  await rejects(claim(USER_C, rule.id, 'idem-cross-1', payload), /autopilot_rule_not_found/);

  const claimedBefore = await auditCount('autopilot.execution_claimed');
  const result = await claim(USER_A, rule.id, 'idem-ok-0001', payload);
  assert.equal(result.replayed, false);
  assert.equal(result.execution.status, 'claimed');
  assert.equal(result.action.status, 'executing');
  assert.equal(result.action.requires_approval, false);
  assert.equal(result.action.idempotency_key, 'autopilot:idem-ok-0001');
  assert.equal(await auditCount('autopilot.execution_claimed'), claimedBefore + 1);
  const auditRow = (await admin(`select actor_type, actor_ref, metadata from public.audit_events where event_type = 'autopilot.execution_claimed' order by created_at desc limit 1`)).rows[0];
  assert.equal(auditRow.actor_type, 'system');
  assert.equal(auditRow.actor_ref, `autopilot_rule:${rule.id}`);
  assert.equal(JSON.stringify(auditRow.metadata).includes('Run'), false, 'audit metadata must not carry content');

  // Idempotent replay returns the same execution; a changed payload conflicts.
  const replay = await claim(USER_A, rule.id, 'idem-ok-0001', payload);
  assert.equal(replay.replayed, true);
  assert.equal(replay.execution.id, result.execution.id);
  await rejects(claim(USER_A, rule.id, 'idem-ok-0001', { ...payload, title: 'Other' }), /autopilot_idempotency_conflict/);
  assert.equal(Number((await admin(`select count(*)::int n from public.autopilot_executions where idempotency_key = 'idem-ok-0001'`)).rows[0].n), 1);

  // Record the verified result; a second record is a state error.
  const verified = await rpc(USER_A, 'apm_autopilot_record_result', '$1::uuid, $2, $3', [result.execution.id, 'verified', 'gcal-event-1']);
  assert.equal(verified.status, 'verified');
  const action = (await admin(`select status, verified_at from public.actions where id = $1`, [result.action.id])).rows[0];
  assert.equal(action.status, 'verified');
  assert.ok(action.verified_at);
  assert.equal(Number((await admin(`select count(*)::int n from public.action_attempts where action_id = $1 and status = 'succeeded'`, [result.action.id])).rows[0].n), 1);
  await rejects(rpc(USER_A, 'apm_autopilot_record_result', '$1::uuid, $2, $3', [result.execution.id, 'verified', 'again']), /autopilot_invalid_execution_state/);
  await rejects(rpc(USER_C, 'apm_autopilot_record_result', '$1::uuid, $2, $3', [result.execution.id, 'failed', null]), /autopilot_invalid_request/);
  await rejects(rpc(USER_C, 'apm_autopilot_record_result', '$1::uuid, $2, $3, $4', [result.execution.id, 'failed', null, 'x']), /autopilot_execution_not_found/);

  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});

test('claims must fit the rule: payload, duration, horizon, window, weekday, collision and daily cap', async () => {
  await activate('calendar.create');
  await setPermission(USER_A, 'calendar', 'calendar.create', 5);
  const weekday = new Date(Date.now() + 3 * DAY).getUTCDay() || 7;
  const rule = await grant(USER_A, 'calendar.create', calendarConstraints({ windowStart: '06:00', windowEnd: '09:00', maxPerDay: 1, horizonDays: 7 }));
  const base = { connectionId: conn[`${USER_A}:calendar`], title: 'Strength' };

  await rejects(claim(USER_A, rule.id, 'idem-bad-1', { ...base, ...slot(3, 6), provider: 'google' }), /autopilot_invalid_payload/);
  await rejects(claim(USER_A, rule.id, 'idem-bad-2', { ...base, startsAt: 'soon', endsAt: 'later' }), /autopilot_invalid_payload/);
  await rejects(claim(USER_A, rule.id, 'idem-bad-3', { ...base, ...slot(3, 6), connectionId: conn[`${USER_B}:calendar`] }), /autopilot_connection_not_found/);
  await rejects(claim(USER_A, rule.id, 'idem-bad-4', { ...base, ...slot(3, 6), connectionId: conn[`${USER_A}:email`] }), /autopilot_connection_not_found/);
  await rejects(claim(USER_A, rule.id, 'idem-long-1', { ...base, ...slot(3, 6, 120) }), /autopilot_outside_rule/);
  await rejects(claim(USER_A, rule.id, 'idem-late-1', { ...base, ...slot(3, 8, 90) }), /autopilot_outside_rule/);
  await rejects(claim(USER_A, rule.id, 'idem-early-1', { ...base, ...slot(3, 5) }), /autopilot_outside_rule/);
  await rejects(claim(USER_A, rule.id, 'idem-far-001', { ...base, ...slot(10, 6) }), /autopilot_outside_rule/);
  await rejects(claim(USER_A, rule.id, 'idem-past-01', { ...base, ...slot(-1, 6) }), /autopilot_outside_rule/);

  // Weekday rule: only the weekday of day +3.
  const weekdayRule = await rpc(USER_A, 'apm_autopilot_update_rule', '$1::uuid, $2, $3::jsonb',
    [rule.id, rule.version, JSON.stringify(calendarConstraints({ windowStart: '06:00', windowEnd: '09:00', maxPerDay: 1, horizonDays: 7, weekdays: [weekday] }))]);
  assert.equal(weekdayRule.version, rule.version + 1);
  await rejects(claim(USER_A, rule.id, 'idem-wday-01', { ...base, ...slot(4, 6) }), /autopilot_outside_rule/);
  await rejects(rpc(USER_A, 'apm_autopilot_update_rule', '$1::uuid, $2, $3::jsonb', [rule.id, rule.version, JSON.stringify(calendarConstraints())]), /autopilot_conflict/);

  // Collision with a busy event; a free event does not block.
  const busy = slot(3, 6);
  await admin(`insert into public.calendar_events (user_id, starts_at, ends_at, availability) values ($1, $2, $3, 'busy')`, [USER_A, new Date(Date.parse(busy.startsAt) + 15 * 60_000).toISOString(), busy.endsAt]);
  await admin(`insert into public.calendar_events (user_id, starts_at, ends_at, availability) values ($1, $2, $3, 'free')`, [USER_A, slot(3, 7).startsAt, slot(3, 7).endsAt]);
  await rejects(claim(USER_A, rule.id, 'idem-busy-01', { ...base, ...busy }), /autopilot_collision/);

  const ok = await claim(USER_A, rule.id, 'idem-free-01', { ...base, ...slot(3, 7) });
  assert.equal(ok.execution.status, 'claimed');
  // Daily cap of 1 on that local day (claimed counts), and the claimed block itself blocks overlap.
  await rejects(claim(USER_A, rule.id, 'idem-cap-001', { ...base, ...slot(3, 8) }), /autopilot_rate_limited/);
  // A failed attempt frees the cap.
  await rpc(USER_A, 'apm_autopilot_record_result', '$1::uuid, $2, $3, $4', [ok.execution.id, 'failed', null, 'google_calendar_action_failed:503']);
  assert.equal((await admin(`select status, failure_code from public.actions where id = $1`, [ok.action.id])).rows[0].status, 'failed');
  const retry = await claim(USER_A, rule.id, 'idem-retry-1', { ...base, ...slot(3, 8) });
  assert.equal(retry.execution.status, 'claimed');
  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});

test('email.draft: recipient domains, daily cap; send is never a standing class', async () => {
  await activate('email.draft');
  await setPermission(USER_A, 'email', 'email.draft', 5);
  await setPermission(USER_A, 'email', 'email.send', 5);
  await rejects(grant(USER_A, 'email.send', emailConstraints()), /autopilot_unsupported_action_class/);
  const rule = await grant(USER_A, 'email.draft', emailConstraints());
  const base = { connectionId: conn[`${USER_A}:email`], subject: 'Pickup', body: 'Running 10 minutes late.' };
  await rejects(claim(USER_A, rule.id, 'mail-bad-01', { ...base, to: 'teacher@elsewhere.example.com' }), /autopilot_outside_rule/);
  await rejects(claim(USER_A, rule.id, 'mail-bad-02', { ...base, to: 'a@school.example.org, b@x.com' }), /autopilot_invalid_payload/);
  await rejects(claim(USER_A, rule.id, 'mail-bad-03', { ...base, to: 'teacher@school.example.org', cc: 'x@y.z' }), /autopilot_invalid_payload/);
  await rejects(claim(USER_A, rule.id, 'mail-bad-04', { ...base, to: 'teacher@school.example.org', subject: 'Hi\r\nBcc: x@elsewhere.example.com' }), /autopilot_invalid_payload/);
  const ok = await claim(USER_A, rule.id, 'mail-ok-001', { ...base, to: 'Teacher@School.Example.Org' });
  assert.equal(ok.action.action_type, 'email.draft');
  await rejects(claim(USER_A, rule.id, 'mail-cap-01', { ...base, to: 'office@school.example.org' }), /autopilot_rate_limited/);
  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});

test('pause, master pause, expiry and revoke stop authority; stopping never needs the entitlement', async () => {
  await activate('calendar.create');
  await setPermission(USER_C, 'calendar', 'calendar.create', 5);
  const rule = await grant(USER_C, 'calendar.create', calendarConstraints());
  const payload = { connectionId: conn[`${USER_C}:calendar`], title: 'Study block', ...slot(5, 10) };

  const paused = await rpc(USER_C, 'apm_autopilot_set_rule_status', '$1::uuid, $2, $3', [rule.id, 'paused', rule.version]);
  assert.equal(paused.status, 'paused');
  await rejects(claim(USER_C, rule.id, 'pause-key-01', payload), /autopilot_rule_inactive/);
  const resumed = await rpc(USER_C, 'apm_autopilot_set_rule_status', '$1::uuid, $2, $3', [rule.id, 'active', paused.version]);

  await rpc(USER_C, 'apm_autopilot_set_master_pause', '$1', [true]);
  await rejects(claim(USER_C, rule.id, 'pause-key-02', payload), /autopilot_paused/);
  await rpc(USER_C, 'apm_autopilot_set_master_pause', '$1', [false]);
  assert.equal(await auditCount('autopilot.paused', USER_C), 1);

  // Expiry: force the rule into the past (admin only) and the claim fails closed.
  await admin(`update public.autopilot_rules set granted_at = now() - interval '10 days', expires_at = now() - interval '1 minute' where id = $1`, [rule.id]);
  await rejects(claim(USER_C, rule.id, 'expired-key1', payload), /autopilot_rule_expired/);
  await rejects(rpc(USER_C, 'apm_autopilot_set_rule_status', '$1::uuid, $2, $3', [rule.id, 'active', resumed.version]), /autopilot_rule_expired|autopilot_conflict/);
  // Renewal is an explicit re-grant of the expiry.
  const renewed = await rpc(USER_C, 'apm_autopilot_update_rule', '$1::uuid, $2, $3::jsonb, $4::timestamptz', [rule.id, resumed.version, null, inDays(20)]);
  const ok = await claim(USER_C, rule.id, 'renewed-key1', payload);
  assert.equal(ok.execution.status, 'claimed');
  await rpc(USER_C, 'apm_autopilot_record_result', '$1::uuid, $2, $3', [ok.execution.id, 'verified', 'gcal-c-1']);

  // Downgrade: claims, grants and resumes fail; reads are hidden; stopping still works.
  await setPlan(USER_C, 'autopilot', 'expired');
  await rejects(claim(USER_C, rule.id, 'downgr-key01', { ...payload, ...slot(6, 10) }), /autopilot_required/);
  await rejects(grant(USER_C, 'email.draft', emailConstraints()), /autopilot_required/);
  await rejects(rpc(USER_C, 'apm_autopilot_set_master_pause', '$1', [false]), /autopilot_required/);
  assert.equal((await as(USER_C, 'select * from public.autopilot_rules')).rows.length, 0);
  assert.equal((await as(USER_C, 'select * from public.autopilot_executions')).rows.length, 0);
  await rpc(USER_C, 'apm_autopilot_set_master_pause', '$1', [true]);
  const target = await rpc(USER_C, 'apm_autopilot_undo_target', '$1::uuid', [ok.execution.id]);
  assert.deepEqual({ undo: target.undoMethod, ref: target.externalRef, connectionId: target.connectionId }, { undo: 'delete_event', ref: 'gcal-c-1', connectionId: conn[`${USER_C}:calendar`] });
  const reverted = await rpc(USER_C, 'apm_autopilot_record_undo', '$1::uuid', [ok.execution.id]);
  assert.equal(reverted.status, 'reverted');
  assert.equal((await admin(`select status from public.actions where id = $1`, [ok.action.id])).rows[0].status, 'cancelled');
  await rejects(rpc(USER_C, 'apm_autopilot_undo_target', '$1::uuid', [ok.execution.id]), /autopilot_invalid_execution_state/);
  const revoked = await rpc(USER_C, 'apm_autopilot_revoke_rule', '$1::uuid, $2', [rule.id, 'done']);
  assert.equal(revoked.status, 'revoked');
  await rejects(rpc(USER_C, 'apm_autopilot_update_rule', '$1::uuid, $2, $3::jsonb', [rule.id, revoked.version, null]), /autopilot_required/);

  // Data-rights export still returns everything retained, owner-only.
  const exported = await rpc(USER_C, 'apm_autopilot_data_rights_export', '', []);
  assert.equal(exported.autopilot_rules.length, 1);
  assert.equal(exported.autopilot_rules[0].status, 'revoked');
  assert.equal(exported.autopilot_executions.length, 1);
  assert.equal(exported.autopilot_settings.paused, true);
  const otherExport = await rpc(USER_A, 'apm_autopilot_data_rights_export', '', []);
  assert.equal(otherExport.autopilot_rules.every((r) => r.user_id === USER_A), true);
  assert.equal(renewed.version, resumed.version + 1);

  // Re-upgrade restores reads but the revoked rule stays revoked.
  await setPlan(USER_C, 'autopilot', 'active');
  await rejects(rpc(USER_C, 'apm_autopilot_set_rule_status', '$1::uuid, $2, $3', [rule.id, 'active', revoked.version]), /autopilot_rule_revoked/);
  await rejects(claim(USER_C, rule.id, 'revoked-key1', { ...payload, ...slot(7, 10) }), /autopilot_paused|autopilot_rule_inactive/);
});

test('deactivating a class is a global kill switch for existing rules', async () => {
  await activate('calendar.create');
  await setPermission(USER_A, 'calendar', 'calendar.create', 5);
  const rule = await grant(USER_A, 'calendar.create', calendarConstraints());
  await deactivate('calendar.create');
  await rejects(claim(USER_A, rule.id, 'kill-key-001', { connectionId: conn[`${USER_A}:calendar`], title: 'x', ...slot(9, 12) }), /autopilot_class_not_activated/);
  await rpc(USER_A, 'apm_autopilot_revoke_rule', '$1::uuid', [rule.id]);
});
