// Full-chain proof of migration 0064: a client cannot write its own `permissions` rows
// around the governed function (no self-granted autonomy above the plan, no unaudited
// switch-on), and the one writer enforces ownership, shape and the plan ceiling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

const A = U(31); const B = U(32); const NONE = U(33);
let h;
const rpc = (userId, args) => h.as(userId, 'select public.apm_set_permission($1, $2, $3, $4::jsonb, $5) as r', args).then((r) => r.rows[0].r);
const setPlan = (userId, plan, status = 'active') => h.admin(
  `insert into public.subscription_entitlements (user_id, plan, status) values ($1, $2, $3) on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`, [userId, plan, status]);

test.before(async () => {
  h = await realChain();
  await h.admin(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${NONE}')`);
  await setPlan(A, 'life_os');
  await setPlan(B, 'autopilot');
  await setPlan(NONE, 'beta', 'expired');
});

test('no direct writes: insert, update and delete on permissions are refused for the owner', async () => {
  await rejects(h.as(A, `insert into public.permissions (user_id, domain, action_type, autonomy_level, enabled) values ($1, 'calendar', 'create_event', 5, true)`, [A]), /permission denied/);
  const granted = await rpc(A, ['calendar', 'create_event', 3, '{}', true]);
  await rejects(h.as(A, `update public.permissions set autonomy_level = 5 where id = $1`, [granted.id]), /permission denied/);
  await rejects(h.as(A, `delete from public.permissions where id = $1`, [granted.id]), /permission denied/);
  assert.equal((await h.as(A, 'select count(*)::int n from public.permissions')).rows[0].n, 1, 'the owner can still read');
  assert.equal((await h.as(B, 'select count(*)::int n from public.permissions')).rows[0].n, 0, 'never another user');
});

test('the governed writer: own row, plan ceiling re-checked in the database, audited', async () => {
  await rejects(rpc(A, ['calendar', 'create_event', 5, '{}', true]), /permission_above_plan_ceiling/, 'Life OS ceiling is 4');
  const four = await rpc(A, ['calendar', 'create_event', 4, '{"hours":"9-17"}', true]);
  assert.deepEqual([four.user_id, four.autonomy_level, four.enabled, four.constraints], [A, 4, true, { hours: '9-17' }]);
  assert.ok(four.granted_at);
  await rejects(rpc(B, ['purchase', 'buy', 3, '{}', true]), /permission_above_plan_ceiling/, 'Autopilot purchase ceiling is 2');
  assert.equal((await rpc(B, ['email', 'send', 5, '{}', true])).autonomy_level, 5);
  await rejects(rpc(NONE, ['calendar', 'create_event', 1, '{}', true]), /permission_above_plan_ceiling/, 'no usable plan → level 0 only');
  const off = await rpc(NONE, ['calendar', 'create_event', 3, '{}', false]);
  assert.deepEqual([off.autonomy_level, off.enabled, off.granted_at], [0, false, null], 'switching off is always allowed');
  await rejects(rpc(A, ['bank', 'wire', 1, '{}', true]), /permission_invalid_request/);
  await rejects(rpc(A, ['calendar', 'drop table', 1, '{}', true]), /permission_invalid_request/);
  await rejects(rpc(A, ['calendar', 'x', 1, '[]', true]), /permission_invalid_request/);
  await rejects(h.asRole('anon', null, `select public.apm_set_permission('calendar', 'x', 0, '{}'::jsonb, false)`), /permission denied/);
  await rejects(h.asRole('authenticated', null, `select public.apm_set_permission('calendar', 'x', 0, '{}'::jsonb, false)`), /unauthorized/);
  const audits = (await h.admin(`select metadata from public.audit_events where user_id = $1 and event_type = 'permission.changed' order by created_at`, [A])).rows;
  assert.ok(audits.length >= 2);
  assert.deepEqual(audits.at(-1).metadata, { domain: 'calendar', actionType: 'create_event', autonomyLevel: 4, ceiling: 4 });
  await rejects(h.as(A, 'select private.apm_permission_ceiling($1, $2)', [A, 'calendar']), /permission denied/);
});
