// Full-chain proof of migration 0045: the commitments conflict target, the one-transaction
// calendar window, device-scoped push tokens, Morning Trigger rotation and the goal source
// for the body red-flag pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

const A = U(21); const B = U(22);
let h;
test.before(async () => {
  h = await realChain();
  await h.admin(`insert into auth.users (id) values ('${A}'), ('${B}')`);
});

test('commitments: the email sync upsert target exists, so a re-sync is a no-op rather than 42P10/23505', async () => {
  const upsert = () => h.as(A, `insert into public.commitments (user_id, title, owner, status, provenance_kind, source_type, source_ref, confidence)
    values ($1, 'Send the deck', 'user', 'understood', 'inferred', 'gmail', 'msg-1', 0.9)
    on conflict (user_id, source_type, source_ref, title) do nothing returning id`, [A]);
  assert.equal((await upsert()).rows.length, 1);
  assert.equal((await upsert()).rows.length, 0, 'second sync of the same window: no error, no duplicate');
  await h.as(A, `insert into public.commitments (user_id, title, owner, status, provenance_kind, source_type, confidence) values ($1, 'Manual', 'user', 'understood', 'stated', 'manual', 1), ($1, 'Manual', 'user', 'understood', 'stated', 'manual', 1)`, [A]);
  const def = (await h.admin("select indexdef from pg_indexes where indexname = 'commitments_source_title_unique'")).rows[0].indexdef;
  assert.doesNotMatch(def, /WHERE/, 'a full index PostgREST can target');
});

const event = (id, startsAt = '2026-10-08T09:00:00Z') => ({ provider: 'device', external_event_id: id, title: 'Standup', starts_at: startsAt, ends_at: '2026-10-08T09:15:00Z', all_day: false, availability: 'busy' });
const replace = (events) => h.as(A, "select public.apm_replace_calendar_window('device', null, '2026-10-01T00:00:00Z', '2026-12-31T00:00:00Z', $1::jsonb) n", [JSON.stringify(events)]);
const count = async () => (await h.admin("select count(*)::int n from public.calendar_events where user_id = $1", [A])).rows[0].n;

test('calendar: a failed or duplicate snapshot leaves the window as it was; a good one replaces it atomically', async () => {
  assert.equal((await replace([event('e1'), event('e2')])).rows[0].n, 2);
  await rejects(replace([event('e3'), event('e3')]), /calendar_duplicate_event/);
  assert.equal(await count(), 2, 'refused before anything was deleted');
  await rejects(replace([event('e4'), event('e5', 'not-a-time')]), /invalid input syntax/);
  assert.equal(await count(), 2, 'a bad row rolls the delete back: the window is never left empty');
  assert.equal((await replace([event('e9')])).rows[0].n, 1);
  assert.deepEqual((await h.admin('select external_event_id from public.calendar_events where user_id = $1', [A])).rows.map((r) => r.external_event_id), ['e9']);
  await rejects(h.asRole('anon', null, "select public.apm_replace_calendar_window('device', null, now(), now(), '[]'::jsonb)"), /permission denied/);
});

test('push: a token follows the device to the new account; dead tokens are deactivated; clients cannot call either', async () => {
  const reg = (user, token) => h.service("select public.apm_service_register_push_token($1, $2, null, 'ios')", [user, token]);
  await reg(A, 'ExponentPushToken[shared]');
  await reg(B, 'ExponentPushToken[shared]');
  const rows = (await h.admin("select user_id::text u, active from public.push_subscriptions where expo_push_token = 'ExponentPushToken[shared]' order by user_id")).rows;
  assert.deepEqual(rows, [{ u: A, active: false }, { u: B, active: true }], "A's pushes never reach B's phone");
  assert.equal((await h.service("select public.apm_service_deactivate_push_tokens(array['ExponentPushToken[shared]']) n")).rows[0].n, 1);
  await rejects(h.as(A, "select public.apm_service_register_push_token($1, 'ExponentPushToken[x1234567]', null, null)", [A]), /permission denied/);
  await rejects(h.as(A, "select public.apm_service_deactivate_push_tokens(array['x'])"), /permission denied/);
});

test('Morning Trigger candidates rotate: a full page of held users cannot starve the users after them', async () => {
  const users = [U(31), U(32), U(33)];
  await h.admin(`insert into auth.users (id) values ${users.map((u) => `('${u}')`).join(', ')}`);
  await h.admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where user_id = any($1::uuid[])", [users]);
  await h.admin(`insert into public.personal_os (user_id, active_mode) select u, 'standard' from unnest($1::uuid[]) u`, [users]);
  await h.admin(`insert into public.push_subscriptions (user_id, expo_push_token) select u, 'ExponentPushToken[' || u || ']' from unnest($1::uuid[]) u`, [users]);
  await h.admin("update public.notification_preferences set wake_time = '06:00' where user_id = any($1::uuid[])", [users]);
  const page = async (at) => (await h.service('select user_id::text from public.apm_service_morning_candidates($1::timestamptz, 2)', [at])).rows.map((r) => r.user_id);
  // UTC users, 07:00: all three are due; the page holds two. Nobody is sent (held), so all stay due.
  const first = await page('2026-10-07T07:00:00Z');
  const second = await page('2026-10-07T07:15:00Z');
  assert.equal(first.length, 2);
  const missed = users.find((u) => !first.includes(u));
  assert.equal(second[0], missed, 'the user left out last tick is first this tick');
  const third = await page('2026-10-07T07:30:00Z');
  assert.ok(users.every((u) => [...first, ...second, ...third].includes(u)));
});

test('a goal is a body red-flag source', async () => {
  await h.admin(`insert into public.personal_os (user_id, active_mode) values ('${A}', 'standard')`);
  await h.admin("update public.subscription_entitlements set plan = 'chief_of_staff', status = 'active' where user_id = $1", [A]);
  const out = (await h.as(A, "select public.apm_flag_body_referral('goal') r")).rows[0].r;
  assert.equal(out.source, 'goal');
  await rejects(h.as(A, "select public.apm_flag_body_referral('nonsense')"), /loop_invalid_request/);
});
