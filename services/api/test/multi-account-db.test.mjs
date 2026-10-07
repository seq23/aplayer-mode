// Multiple connected calendars and inboxes (0065; owner decision 7 Oct 2026): Autopilot
// gets work AND personal at once, every other plan gets one calendar and one inbox. Run on
// the REAL migration chain as the `authenticated` role, so the limit is proven where it
// lives: in the database, not the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { realChain, rejects, U } from './helpers/real-chain.mjs';
import { ALL_WRITE_SCOPES } from './helpers/autopilot-substrate.mjs';

const POLICY_SRC = new URL('../../../packages/policy/src/index.ts', import.meta.url);
const DAY = 86_400_000;
const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();
function slot(daysAhead, hour, minutes = 60) {
  const start = new Date(Date.now() + daysAhead * DAY);
  start.setUTCHours(hour, 0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
}
const WINDOW = { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '00:00', windowEnd: '23:59' };

let h;
const LIFE = U(201), AUTO = U(202), DOWN = U(203), ROUTE = U(204), RIGHTS = U(205), PLANS = U(206);

const setPlan = (userId, plan, status = 'active') => h.admin(
  `insert into public.subscription_entitlements (user_id, plan, status) values ($1, $2, $3)
   on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`, [userId, plan, status]);
/** What the OAuth exchange does (connectors/oauth.ts): an upsert as the user. */
const connect = async (userId, kind, account, provider = 'google') => (await h.as(userId,
  `insert into public.integration_connections (user_id, provider, kind, external_account_id, account_label, status, scopes, encrypted_credentials, credential_iv)
   values ($1, $2, $3, $4, $4, 'connected', $5, 'cipher', 'iv')
   on conflict (user_id, provider, kind, external_account_id) do update set status = 'connected', scopes = excluded.scopes,
     encrypted_credentials = excluded.encrypted_credentials, credential_iv = excluded.credential_iv, updated_at = now()
   returning *`, [userId, provider, kind, account, ALL_WRITE_SCOPES])).rows[0];
const row = async (id) => (await h.admin('select * from public.integration_connections where id = $1', [id])).rows[0];
const rpc = async (userId, fn, args, values) => (await h.as(userId, `select public.${fn}(${args}) as r`, values)).rows[0].r;
const replaceWindow = (userId, connectionId, events, provider = 'google') => {
  const from = new Date(Date.now() - DAY).toISOString(), to = inDays(30);
  return h.as(userId, 'select public.apm_replace_calendar_window($1, $2::uuid, $3::timestamptz, $4::timestamptz, $5::jsonb) n',
    [provider, connectionId, from, to, JSON.stringify(events.map((e) => ({ provider, availability: 'busy', ...e })))]);
};
const activate = (cls) => h.admin(`update public.autopilot_action_classes set activation_status = 'active', evidence_ref = 'test-receipt', activated_at = now() where class_key = $1`, [cls]);
const level5 = (userId, domain, actionType) => h.admin(
  `insert into public.permissions (user_id, domain, action_type, autonomy_level, enabled) values ($1, $2, $3, 5, true)
   on conflict (user_id, domain, action_type) do update set autonomy_level = 5, enabled = true`, [userId, domain, actionType]);
const grant = (userId, cls, constraints, connectionId = null) =>
  rpc(userId, 'apm_autopilot_grant_rule', '$1, $2::jsonb, $3::timestamptz, $4::uuid', [cls, JSON.stringify(constraints), inDays(30), connectionId]);
const claim = (userId, ruleId, key, payload) =>
  rpc(userId, 'apm_autopilot_claim', '$1::uuid, $2, $3::jsonb, $4', [ruleId, key, JSON.stringify(payload), 'Standing rule run']);

test.before(async () => {
  h = await realChain();
  await h.admin(`insert into auth.users (id) values ${[LIFE, AUTO, DOWN, ROUTE, RIGHTS, PLANS].map((u) => `('${u}')`).join(',')}`);
  await setPlan(LIFE, 'life_os');
  await setPlan(AUTO, 'autopilot');
  await setPlan(DOWN, 'autopilot', 'trialing');
  await setPlan(ROUTE, 'autopilot');
  await setPlan(RIGHTS, 'autopilot');
});
test.after(async () => { await h?.db.close(); });

test("the database's multi-account check is exactly the 'multi_account' capability in packages/policy", async () => {
  const src = await readFile(POLICY_SRC, 'utf8');
  for (const plan of ['beta', 'chief_of_staff', 'life_os', 'autopilot', 'household']) {
    const block = src.match(new RegExp(`\\n  ${plan}: \\{[\\s\\S]*?capabilities: \\[([^\\]]*)\\]`));
    assert.ok(block, `productPlanPolicies.${plan} capabilities`);
    await setPlan(PLANS, plan);
    const db = (await h.admin('select private.apm_has_multi_account_access($1) ok', [PLANS])).rows[0].ok;
    assert.equal(db, block[1].includes("'multi_account'"), `${plan}: policy and database agree`);
  }
  await setPlan(PLANS, 'autopilot', 'cancelled');
  assert.equal((await h.admin('select private.apm_has_multi_account_access($1) ok', [PLANS])).rows[0].ok, false, 'a lapsed Autopilot is not multi-account');
});

test('the database rejects a second calendar or inbox without Autopilot', async () => {
  const work = await connect(LIFE, 'calendar', 'me@work.example');
  assert.equal(work.is_primary, true, 'the first account of a kind is the primary');
  await rejects(connect(LIFE, 'calendar', 'me@home.example'), /connection_multi_account_requires_autopilot/);
  await rejects(connect(LIFE, 'calendar', 'me@outlook.example', 'microsoft'), /connection_multi_account_requires_autopilot/);
  // Calendar and inbox are separate allowances: one of each.
  const inbox = await connect(LIFE, 'email', 'me@work.example');
  assert.equal(inbox.is_primary, true);
  await rejects(connect(LIFE, 'email', 'me@home.example'), /connection_multi_account_requires_autopilot/);
  // Reconnecting the SAME account is never a second account.
  assert.equal((await connect(LIFE, 'calendar', 'me@work.example')).id, work.id);
  assert.equal(Number((await h.admin('select count(*) n from public.integration_connections where user_id = $1', [LIFE])).rows[0].n), 2);
  // A direct PATCH cannot turn an email row into a second calendar.
  await rejects(h.as(LIFE, "update public.integration_connections set kind = 'calendar' where id = $1", [inbox.id]), /connection_immutable/);
  // Autopilot: work and personal at once; the second is live but not primary.
  await connect(AUTO, 'calendar', 'me@work.example');
  const personal = await connect(AUTO, 'calendar', 'me@home.example');
  assert.equal(personal.is_primary, false);
  assert.equal(personal.paused_at, null);
});

test('a downgrade pauses the extra accounts without deleting them; disconnect always works', async () => {
  const work = await connect(DOWN, 'calendar', 'me@work.example');
  const personal = await connect(DOWN, 'calendar', 'me@home.example');
  const workMail = await connect(DOWN, 'email', 'me@work.example');
  const homeMail = await connect(DOWN, 'email', 'me@home.example');
  await rpc(DOWN, 'apm_connection_set_label', '$1::uuid, $2', [personal.id, 'Personal']);

  await setPlan(DOWN, 'life_os');
  const after = await Promise.all([work, personal, workMail, homeMail].map((c) => row(c.id)));
  assert.deepEqual(after.map((c) => [c.is_primary, c.paused_reason, c.status]),
    [[true, null, 'connected'], [false, 'plan', 'connected'], [true, null, 'connected'], [false, 'plan', 'connected']], 'primary kept, extras paused, nothing deleted');
  assert.equal(after[1].label, 'Personal', 'the label survives');
  assert.ok(after[1].encrypted_credentials, 'the paused account keeps its credentials for reactivation');
  assert.equal(Number((await h.admin("select count(*) n from public.audit_events where user_id = $1 and event_type = 'connection.paused'", [DOWN])).rows[0].n), 2);

  // Paused means no sync and no actions.
  await rejects(replaceWindow(DOWN, personal.id, [{ external_event_id: 'p1', ...{ starts_at: slot(1, 9).startsAt, ends_at: slot(1, 9).endsAt } }]), /connection_paused/);
  await rejects(h.as(DOWN, `insert into public.message_signals (user_id, connection_id, provider, external_message_id, signal_type, summary, confidence)
    values ($1, $2, 'google', 'm1', 'request', 'Reply to the school', 0.9)`, [DOWN, homeMail.id]), /connection_paused/);
  const prepared = (await h.service(`select public.apm_service_action_prepare($1, 'email', 'email.send', $2::jsonb, 'Send the reply', null, 'multi-down-1') r`,
    [DOWN, JSON.stringify({ connectionId: homeMail.id, to: 'a@school.example.org' })])).rows[0].r;
  await rejects(h.service('select public.apm_service_action_claim($1, $2)', [DOWN, prepared.action.id]), /action_connection_paused/);
  // ...while the primary keeps working.
  assert.equal((await replaceWindow(DOWN, work.id, [{ external_event_id: 'w1', starts_at: slot(1, 9).startsAt, ends_at: slot(1, 9).endsAt }])).rows[0].n, 1);

  // No un-pausing around the database: not by RPC, not by PATCH.
  await rejects(rpc(DOWN, 'apm_connection_reactivate', '$1::uuid', [personal.id]), /connection_multi_account_requires_autopilot/);
  await rejects(h.as(DOWN, 'update public.integration_connections set paused_at = null, paused_reason = null where id = $1', [personal.id]), /connection_multi_account_requires_autopilot/);
  // The user may choose which one stays live on any plan: the old primary is paused instead.
  await rpc(DOWN, 'apm_connection_set_primary', '$1::uuid', [personal.id]);
  assert.deepEqual([(await row(personal.id)).is_primary, (await row(work.id)).paused_reason], [true, 'plan']);
  await rpc(DOWN, 'apm_connection_set_primary', '$1::uuid', [work.id]);

  // Upgrade: they reactivate the extra themselves.
  await setPlan(DOWN, 'autopilot');
  await rpc(DOWN, 'apm_connection_reactivate', '$1::uuid', [personal.id]);
  assert.deepEqual([(await row(personal.id)).paused_at, (await row(personal.id)).is_primary, (await row(work.id)).is_primary], [null, false, true]);

  // Disconnect works with no entitlement at all, paused or not, and removes the account's rows.
  await setPlan(DOWN, 'chief_of_staff', 'expired');
  const gone = await rpc(DOWN, 'apm_connection_disconnect', '$1::uuid', [homeMail.id]);
  assert.equal(gone.status, 'disconnected');
  assert.ok(!('encrypted_credentials' in gone));
  assert.equal((await row(homeMail.id)).encrypted_credentials, null);
  await rpc(DOWN, 'apm_connection_disconnect', '$1::uuid', [work.id]);
  assert.equal(Number((await h.admin('select count(*) n from public.calendar_events where connection_id = $1', [work.id])).rows[0].n), 0);
  await rejects(rpc(AUTO, 'apm_connection_disconnect', '$1::uuid', [personal.id]), /connection_not_found/, 'never another user\'s account');
});

test('the Autopilot collision check spans every connected calendar (never double-book work against personal)', async () => {
  const work = await connect(AUTO, 'calendar', 'me@work.example');
  const personal = (await h.admin("select * from public.integration_connections where user_id = $1 and external_account_id = 'me@home.example'", [AUTO])).rows[0];
  await activate('calendar.create');
  await level5(AUTO, 'calendar', 'calendar.create');
  const rule = await grant(AUTO, 'calendar.create', { ...WINDOW, maxDurationMinutes: 90, maxPerDay: 3, horizonDays: 14, collision: 'never_overlap_busy' }, work.id);
  assert.equal(rule.connection_id, work.id, 'the rule names its account');
  const dentist = slot(2, 15);
  await replaceWindow(AUTO, personal.id, [{ external_event_id: 'dentist', starts_at: dentist.startsAt, ends_at: dentist.endsAt, title: 'Dentist' }]);
  // One invitation on both calendars is two rows, one per account, never one row that flips.
  const shared = slot(3, 10);
  await replaceWindow(AUTO, work.id, [{ external_event_id: 'same-invite', starts_at: shared.startsAt, ends_at: shared.endsAt }]);
  await replaceWindow(AUTO, personal.id, [
    { external_event_id: 'dentist', starts_at: dentist.startsAt, ends_at: dentist.endsAt, title: 'Dentist' },
    { external_event_id: 'same-invite', starts_at: shared.startsAt, ends_at: shared.endsAt }]);
  assert.deepEqual((await h.admin("select connection_id from public.calendar_events where external_event_id = 'same-invite' order by connection_id", [])).rows.map((r) => r.connection_id).sort(), [work.id, personal.id].sort());

  const overlap = { startsAt: new Date(Date.parse(dentist.startsAt) + 30 * 60_000).toISOString(), endsAt: new Date(Date.parse(dentist.endsAt) + 30 * 60_000).toISOString() };
  await rejects(claim(AUTO, rule.id, 'multi-collide-1', { connectionId: work.id, title: 'Focus block', ...overlap }), /autopilot_collision/);
  const free = slot(2, 18);
  const ok = await claim(AUTO, rule.id, 'multi-free-1', { connectionId: work.id, title: 'Focus block', ...free });
  assert.equal(ok.execution.connection_id, work.id);
});

test('an action routes to the labelled account it names, and undo targets that same account', async () => {
  const work = await connect(ROUTE, 'email', 'me@work.example');
  const personal = await connect(ROUTE, 'email', 'me@home.example');
  await rpc(ROUTE, 'apm_connection_set_label', '$1::uuid, $2', [work.id, 'Work']);
  await rpc(ROUTE, 'apm_connection_set_label', '$1::uuid, $2', [personal.id, 'Personal']);
  await rejects(rpc(ROUTE, 'apm_connection_set_label', '$1::uuid, $2', [personal.id, 'Bad\nlabel']), /connection_invalid_label/);
  await activate('email.draft');
  await level5(ROUTE, 'email', 'email.draft');
  const rule = await grant(ROUTE, 'email.draft', { ...WINDOW, maxPerDay: 3, allowedRecipientDomains: ['school.example.org'] }, personal.id);
  // A second rule of the same class on the OTHER account is allowed; a duplicate is not.
  const workRule = await grant(ROUTE, 'email.draft', { ...WINDOW, maxPerDay: 1, allowedRecipientDomains: ['work.example.com'] });
  assert.equal(workRule.connection_id, work.id, 'no account named = the primary');
  await rejects(grant(ROUTE, 'email.draft', { ...WINDOW, maxPerDay: 1, allowedRecipientDomains: ['x.org'] }, personal.id), /autopilot_rule_exists/);

  const draft = { to: 'teacher@school.example.org', subject: 'Pickup Friday', body: 'I will be there at 3.' };
  await rejects(claim(ROUTE, rule.id, 'multi-route-wrong', { connectionId: work.id, ...draft }), /autopilot_wrong_account/);
  const done = await claim(ROUTE, rule.id, 'multi-route-right', { connectionId: personal.id, ...draft });
  assert.equal(done.action.payload.composed.connectionId, personal.id, 'the Worker sends from the composed account');
  assert.equal(done.execution.connection_id, personal.id);
  await h.service("select public.apm_service_autopilot_record_result($1::uuid, $2::uuid, 'verified', 'draft-123', null)", [ROUTE, done.execution.id]);
  const undo = await rpc(ROUTE, 'apm_autopilot_undo_target', '$1::uuid', [done.execution.id]);
  assert.equal(undo.connectionId, personal.id, 'undo reaches the account that acted');

  // An approved (Executive Suite) action may only name the user's own account.
  await rejects(h.service(`select public.apm_service_action_prepare($1, 'email', 'email.send', $2::jsonb, 'Reply', null, 'multi-route-foreign')`,
    [ROUTE, JSON.stringify({ connectionId: (await row((await h.admin("select id from public.integration_connections where user_id = $1 limit 1", [LIFE])).rows[0].id)).id })]), /action_invalid_request/);
});

test('export and erasure cover every account, paused ones included', async () => {
  const work = await connect(RIGHTS, 'calendar', 'me@work.example');
  const personal = await connect(RIGHTS, 'calendar', 'me@home.example');
  await rpc(RIGHTS, 'apm_connection_set_label', '$1::uuid, $2', [personal.id, 'Personal']);
  await activate('calendar.create');
  await level5(RIGHTS, 'calendar', 'calendar.create');
  await grant(RIGHTS, 'calendar.create', { ...WINDOW, maxDurationMinutes: 60, maxPerDay: 1, horizonDays: 7, collision: 'never_overlap_busy' }, personal.id);
  await setPlan(RIGHTS, 'life_os');

  const out = (await h.as(RIGHTS, 'select public.apm_data_rights_export() e')).rows[0].e;
  const accounts = out.integration_connections.sort((a, b) => a.external_account_id.localeCompare(b.external_account_id));
  assert.deepEqual(accounts.map((c) => [c.external_account_id, c.label, c.is_primary, c.paused_reason]),
    [['me@home.example', 'Personal', false, 'plan'], ['me@work.example', null, true, null]]);
  assert.ok(accounts.every((c) => !('encrypted_credentials' in c) && !('credential_iv' in c)), 'secrets never exported');
  assert.deepEqual(out.autopilot_rules.map((r) => r.connection_id), [personal.id], 'the rule\'s account is in the export');

  const job = (await h.as(RIGHTS, "select public.apm_request_data_rights('delete') j")).rows[0].j;
  const claimed = (await h.service('select public.apm_service_data_rights_claim_deletions(5) c')).rows[0].c.find((c) => c.userId === RIGHTS);
  assert.deepEqual(claimed.connections.map((c) => c.id).sort(), [work.id, personal.id].sort(), 'both accounts are revoked at the provider, the paused one too');
  await h.service("select public.apm_service_data_rights_purge($1, '{}'::jsonb)", [job.id]);
  assert.equal(Number((await h.admin('select count(*) n from public.integration_connections where user_id = $1 and encrypted_credentials is not null', [RIGHTS])).rows[0].n), 0);
  await h.admin('delete from auth.users where id = $1', [RIGHTS]);
  assert.equal(Number((await h.admin('select count(*) n from public.integration_connections where user_id = $1', [RIGHTS])).rows[0].n), 0);
  assert.equal(Number((await h.admin('select count(*) n from public.autopilot_rules where user_id = $1', [RIGHTS])).rows[0].n), 0);
});
