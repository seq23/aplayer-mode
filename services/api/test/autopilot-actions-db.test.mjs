// Executes the Autopilot migrations (0018, 0019, 0033) in an embedded Postgres and
// proves the four action classes from the owner's 6 Oct 2026 ruling hold their
// guardrails in the database, as the `authenticated` role:
//   * email.send — rule-defined kinds only, allow-listed recipients, per-rule and
//     per-recipient caps, header guards, no payment data, can't undo;
//   * calendar.reschedule / calendar.decline — only flexible or criteria-matching
//     events, never protected (Deep Work / foreground / Autopilot routine) blocks,
//     decline only on a declared boundary, undo restores;
//   * appointment.book — allow-listed providers + types, fixed text, and anything
//     that needs payment STOPS as a prepared Life OS action;
//   * subscription.cancel — saves money only: fixed cancellation email to an
//     allow-listed domain, or a prepared request; never payment data.
// Every class needs a write-scoped connection, ships inactive, and lands on the
// daily done-list with Undo or a clear "can't undo".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { ALL_WRITE_SCOPES, AUTOPILOT_MIGRATIONS, SUBSTRATE } from './helpers/autopilot-substrate.mjs';

const migration = (name) => readFile(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
let db;
const conn = {};

const admin = async (sql, params) => { await db.exec('reset role'); return db.query(sql, params); };
const as = (userId, sql, params = []) => db.transaction(async (tx) => {
  await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${userId ?? ''}', true);`);
  return tx.query(sql, params);
});
const asService = (sql, params = []) => db.transaction(async (tx) => {
  await tx.exec(`set local role service_role; select set_config('request.jwt.claim.sub', '', true);`);
  return tx.query(sql, params);
});
const rejects = (promise, pattern) => assert.rejects(promise, (error) => { assert.match(String(error?.message ?? error), pattern); return true; });
const rpc = async (userId, fn, args, values) => (await as(userId, `select public.${fn}(${args}) as r`, values)).rows[0].r;
const grant = (userId, cls, constraints, days = 30) =>
  rpc(userId, 'apm_autopilot_grant_rule', '$1, $2::jsonb, $3::timestamptz', [cls, JSON.stringify(constraints), new Date(Date.now() + days * 86_400_000).toISOString()]);
const claim = (userId, ruleId, key, payload, reason = 'Standing rule run') =>
  rpc(userId, 'apm_autopilot_claim', '$1::uuid, $2, $3::jsonb, $4', [ruleId, key, JSON.stringify(payload), reason]);
const revoke = (userId, ruleId) => rpc(userId, 'apm_autopilot_revoke_rule', '$1::uuid', [ruleId]);
const record = async (userId, id, outcome, ref = null, code = null) =>
  (await asService('select public.apm_service_autopilot_record_result($1::uuid, $2::uuid, $3, $4, $5) as r', [userId, id, outcome, ref, code])).rows[0].r;
const activate = (cls) => admin(`update public.autopilot_action_classes set activation_status = 'active', evidence_ref = 'test-receipt', activated_at = now() where class_key = $1`, [cls]);
const setPermission = (userId, domain, actionType, level) => admin(
  `insert into public.permissions (user_id, domain, action_type, autonomy_level, enabled) values ($1, $2, $3, $4, true)
   on conflict (user_id, domain, action_type) do update set autonomy_level = excluded.autonomy_level, enabled = true`, [userId, domain, actionType, level]);
const setPlan = (userId, plan, status) => admin(
  `insert into public.subscription_entitlements (user_id, plan, status) values ($1, $2, $3)
   on conflict (user_id) do update set plan = excluded.plan, status = excluded.status`, [userId, plan, status]);
const count = async (sql, params) => Number((await admin(sql, params)).rows[0].n);

const DAY = 86_400_000;
const ALL_DAY = { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '00:00', windowEnd: '23:59' };
function slot(daysAhead, hour, minutes = 60) {
  const start = new Date(Date.now() + daysAhead * DAY);
  start.setUTCHours(hour, 0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() };
}
const isoDow = (date) => (date.getUTCDay() || 7);

test.before(async () => {
  db = new PGlite();
  await db.exec(SUBSTRATE);
  for (const name of AUTOPILOT_MIGRATIONS) await db.exec(await migration(name));
  await admin(`insert into auth.users (id) values ('${A}'), ('${B}')`);
  await setPlan(A, 'autopilot', 'active');
  await setPlan(B, 'autopilot', 'active');
  for (const [user, kind, scopes, key] of [
    [A, 'calendar', ALL_WRITE_SCOPES, 'cal'], [A, 'email', ALL_WRITE_SCOPES, 'mail'],
    [A, 'email', ['https://www.googleapis.com/auth/gmail.readonly'], 'mailRead'],
    [A, 'calendar', ['https://www.googleapis.com/auth/calendar.readonly'], 'calRead'],
    [B, 'email', ALL_WRITE_SCOPES, 'mailB'],
  ]) {
    conn[key] = (await admin(`insert into public.integration_connections (user_id, provider, kind, scopes) values ($1, 'google', $2, $3) returning id`, [user, kind, scopes])).rows[0].id;
  }
  for (const cls of ['calendar.create', 'email.send', 'calendar.reschedule', 'calendar.decline', 'appointment.book', 'subscription.cancel']) await activate(cls);
  await setPermission(A, 'calendar', 'calendar.create', 5);
  await setPermission(A, 'email', 'email.send', 5);
  await setPermission(A, 'calendar', 'calendar.reschedule', 5);
  await setPermission(A, 'calendar', 'calendar.decline', 5);
  await setPermission(A, 'appointment', 'appointment.book', 5);
  await setPermission(A, 'subscription', 'subscription.cancel', 5);
});

test.after(async () => { await db?.close(); });

test('a write-scoped connection is required: read-only consent never implies Autopilot writes', async () => {
  const rule = await grant(A, 'calendar.create', { ...ALL_DAY, maxDurationMinutes: 60, maxPerDay: 3, horizonDays: 14, collision: 'never_overlap_busy' });
  await rejects(claim(A, rule.id, 'scope-cal-001', { connectionId: conn.calRead, title: 'Run', ...slot(2, 6) }), /autopilot_connector_scope_missing/);
  const ok = await claim(A, rule.id, 'scope-cal-002', { connectionId: conn.cal, title: 'Run', ...slot(2, 6) });
  assert.equal(ok.action.payload.composed.title, 'Run');
  assert.equal(ok.action.payload.composed.connectionId, conn.cal);
  await record(A, ok.execution.id, 'verified', 'gcal-routine-1');
  await revoke(A, rule.id);
});

const sendRule = (overrides = {}) => ({
  ...ALL_DAY, maxPerDay: 3, maxPerRecipientPerDay: 1,
  allowedKinds: ['scheduling_reply', 'follow_up', 'confirmation', 'template'],
  allowedRecipients: ['Coach@Club.Example.com'], allowedRecipientDomains: ['school.example.org'],
  templates: [{ id: 'birthday', label: 'Birthday', subject: 'Happy birthday!', body: 'Wishing you a wonderful year ahead.' }],
  ...overrides,
});

test('email.send: rule shape is strict — kinds, recipients, templates, no payment data', async () => {
  await rejects(grant(A, 'email.send', sendRule({ allowedKinds: ['marketing'] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ allowedRecipients: [], allowedRecipientDomains: [] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ templates: [] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ allowedKinds: ['follow_up'] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ maxPerRecipientPerDay: 9 })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ allowedRecipients: ['a@b.org\r\nBcc: x@evil.example'] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ templates: [{ id: 't', label: 'x', subject: 'Hi\r\nBcc: x@evil.example', body: 'x' }] })), /autopilot_invalid_constraints/);
  await rejects(grant(A, 'email.send', sendRule({ templates: [{ id: 't', label: 'x', subject: 'Card', body: 'Use 4111 1111 1111 1111' }] })), /autopilot_payment_data_refused/);
  const rule = await grant(A, 'email.send', sendRule());
  assert.deepEqual(rule.constraints.allowedRecipients, ['coach@club.example.com']);
  await revoke(A, rule.id);
});

test('email.send: only rule-defined kinds, bound to real sources, allow-listed recipients and caps', async () => {
  const rule = await grant(A, 'email.send', sendRule({ allowedKinds: ['follow_up', 'scheduling_reply', 'template'] }));
  const owedToUser = (await admin(`insert into public.commitments (user_id, owner, status) values ($1, 'other', 'understood') returning id`, [A])).rows[0].id;
  const ownedByUser = (await admin(`insert into public.commitments (user_id, owner, status) values ($1, 'user', 'understood') returning id`, [A])).rows[0].id;
  const closed = (await admin(`insert into public.commitments (user_id, owner, status) values ($1, 'other', 'closed') returning id`, [A])).rows[0].id;
  const meeting = (await admin(`insert into public.message_signals (user_id, connection_id, signal_type, summary) values ($1, $2, 'meeting', 'Can we meet Tuesday?') returning id`, [A, conn.mail])).rows[0].id;
  const otherBox = (await admin(`insert into public.message_signals (user_id, connection_id, signal_type, summary) values ($1, $2, 'meeting', 'x') returning id`, [A, conn.mailRead])).rows[0].id;
  const base = { connectionId: conn.mail, kind: 'follow_up', to: 'office@school.example.org', subject: 'Following up', body: 'Just checking on the form.', commitmentId: owedToUser };

  await rejects(claim(A, rule.id, 'send-kind-01', { ...base, kind: 'confirmation', commitmentId: undefined, sourceSignalId: meeting }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-kind-02', { ...base, kind: 'newsletter' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'send-to-0001', { ...base, to: 'someone@elsewhere.example.com' }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-to-0002', { ...base, to: 'office@sub.school.example.org' }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-to-0003', { ...base, to: 'a@school.example.org, b@elsewhere.example.com' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'send-hdr-001', { ...base, subject: 'Hi\r\nBcc: x@elsewhere.example.com' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'send-cc-0001', { ...base, cc: 'x@elsewhere.example.com' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'send-own-001', { ...base, commitmentId: ownedByUser }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-cls-001', { ...base, commitmentId: closed }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-pay-001', { ...base, body: 'My card is 4111-1111-1111-1111' }), /autopilot_payment_data_refused/);
  await rejects(claim(A, rule.id, 'send-scp-001', { ...base, connectionId: conn.mailRead }), /autopilot_connector_scope_missing/);
  await rejects(claim(A, rule.id, 'send-box-001', { ...base, kind: 'scheduling_reply', commitmentId: undefined, sourceSignalId: otherBox }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'send-tpl-001', { connectionId: conn.mail, kind: 'template', to: 'coach@club.example.com', templateId: 'birthday', subject: 'edited' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'send-tpl-002', { connectionId: conn.mail, kind: 'template', to: 'coach@club.example.com', templateId: 'nope' }), /autopilot_outside_rule/);

  const chaser = await claim(A, rule.id, 'send-ok-0001', base);
  assert.equal(chaser.action.action_type, 'email.send');
  assert.deepEqual({ to: chaser.action.payload.composed.to, kind: chaser.action.payload.composed.kind }, { to: 'office@school.example.org', kind: 'follow_up' });
  // Per-recipient cap of 1, then the per-rule cap of 3.
  await rejects(claim(A, rule.id, 'send-rcp-001', { ...base, subject: 'Again' }), /autopilot_rate_limited/);
  const tpl = await claim(A, rule.id, 'send-ok-0002', { connectionId: conn.mail, kind: 'template', to: 'Coach@Club.Example.com', templateId: 'birthday' });
  assert.deepEqual([tpl.action.payload.composed.subject, tpl.action.payload.composed.body], ['Happy birthday!', 'Wishing you a wonderful year ahead.']);
  await claim(A, rule.id, 'send-ok-0003', { ...base, kind: 'scheduling_reply', commitmentId: undefined, sourceSignalId: meeting, to: 'front@school.example.org' });
  await rejects(claim(A, rule.id, 'send-cap-001', { ...base, to: 'desk@school.example.org' }), /autopilot_rate_limited/);
  // Replay with the same proposal returns the original; a changed one conflicts.
  assert.equal((await claim(A, rule.id, 'send-ok-0001', base)).replayed, true);
  await rejects(claim(A, rule.id, 'send-ok-0001', { ...base, body: 'changed' }), /autopilot_idempotency_conflict/);

  // A sent message cannot be undone, and says so.
  await record(A, chaser.execution.id, 'verified', 'gmail-msg-1');
  await rejects(rpc(A, 'apm_autopilot_undo_target', '$1::uuid', [chaser.execution.id]), /autopilot_cannot_undo/);
  const audit = (await admin(`select metadata from public.audit_events where event_type = 'autopilot.execution_claimed' and object_id = $1`, [chaser.execution.id])).rows[0].metadata;
  assert.equal(JSON.stringify(audit).includes('school.example.org'), false, 'audit metadata carries no recipients');
  await revoke(A, rule.id);
});

async function event(fields) {
  const row = { title: 'Weekly sync', availability: 'busy', organizer: { self: true }, attendees: [{ email: 'me@x.org', self: true }, { email: 'pat@x.org' }], ...fields };
  return (await admin(
    `insert into public.calendar_events (user_id, provider, external_event_id, connection_id, title, starts_at, ends_at, availability, organizer, attendees)
     values ($1, 'google', $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [A, row.externalId ?? `ev-${Math.random().toString(36).slice(2)}`, row.connectionId ?? conn.cal, row.title, row.startsAt, row.endsAt, row.availability, JSON.stringify(row.organizer), JSON.stringify(row.attendees)],
  )).rows[0].id;
}

test('calendar.reschedule: only flexible or criteria-matching own meetings, never protected blocks; undo restores', async () => {
  const rule = await grant(A, 'calendar.reschedule', {
    ...ALL_DAY, maxPerDay: 3, horizonDays: 14, maxShiftDays: 2, collision: 'never_overlap_busy',
    matchTitleKeywords: ['1:1'], maxAttendees: 2, protectedTitleKeywords: ['board'],
  });
  const original = slot(4, 10);
  const plain = await event({ title: 'Weekly sync', ...original, externalId: 'ev-plain' });
  const moveTo = slot(4, 14);
  await rejects(claim(A, rule.id, 'mv-elig-0001', { eventId: plain, ...moveTo }), /autopilot_outside_rule/);

  // Marking flexible needs the entitlement and makes it eligible.
  await rpc(A, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [plain, true]);
  await rejects(rpc(B, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [plain, true]), /autopilot_event_not_found/);

  const deep = await event({ title: 'Deep Work: chapter 3', ...slot(4, 6) });
  await rpc(A, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [deep, true]);
  await rejects(claim(A, rule.id, 'mv-prot-0001', { eventId: deep, ...slot(4, 16) }), /autopilot_event_protected/);
  const board = await event({ title: '1:1 board prep', ...slot(5, 10) });
  await rejects(claim(A, rule.id, 'mv-prot-0002', { eventId: board, ...slot(5, 14) }), /autopilot_event_protected/);
  const routine = await event({ title: 'Run', ...slot(2, 6), externalId: 'gcal-routine-1' });
  await rpc(A, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [routine, true]);
  await rejects(claim(A, rule.id, 'mv-prot-0003', { eventId: routine, ...slot(2, 9) }), /autopilot_event_protected/);
  const session = slot(6, 9, 180);
  await admin(`insert into public.personal_os (user_id, active_mode, mode_started_at, mode_ends_at) values ($1, 'deep_work', $2, $3)`, [A, session.startsAt, session.endsAt]);
  const inSession = await event({ title: '1:1 with Sam', ...slot(6, 10) });
  await rejects(claim(A, rule.id, 'mv-prot-0004', { eventId: inSession, ...slot(6, 15) }), /autopilot_event_protected/);
  // ...and nothing may be moved INTO a Deep Work session either.
  const criteria = await event({ title: '1:1 with Sam', ...slot(6, 14) });
  await rejects(claim(A, rule.id, 'mv-into-0001', { eventId: criteria, ...slot(6, 10) }), /autopilot_collision/);

  const theirs = await event({ title: '1:1 with Lee', ...slot(7, 10), organizer: { email: 'lee@x.org' } });
  await rejects(claim(A, rule.id, 'mv-own-00001', { eventId: theirs, ...slot(7, 14) }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'mv-dur-00001', { eventId: plain, ...slot(4, 14, 90) }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'mv-far-00001', { eventId: plain, ...slot(8, 10) }), /autopilot_outside_rule/);
  await admin(`insert into public.calendar_events (user_id, starts_at, ends_at, availability) values ($1, $2, $3, 'busy')`, [A, moveTo.startsAt, moveTo.endsAt]);
  await rejects(claim(A, rule.id, 'mv-busy-0001', { eventId: plain, ...moveTo }), /autopilot_collision/);

  const target = slot(4, 16);
  const moved = await claim(A, rule.id, 'mv-ok-000001', { eventId: plain, ...target });
  assert.equal(moved.execution.target_ref, 'ev-plain');
  assert.equal(Date.parse(moved.execution.original_starts_at), Date.parse(original.startsAt));
  assert.equal(moved.action.payload.composed.externalEventId, 'ev-plain');
  assert.equal(moved.action.payload.composed.connectionId, conn.cal);
  // One live move per event.
  await rejects(claim(A, rule.id, 'mv-twice-001', { eventId: plain, ...slot(4, 18) }), /autopilot_collision/);
  await record(A, moved.execution.id, 'verified', 'ev-plain');
  const undo = await rpc(A, 'apm_autopilot_undo_target', '$1::uuid', [moved.execution.id]);
  assert.equal(undo.undoMethod, 'restore_time');
  assert.equal(undo.externalRef, 'ev-plain');
  assert.equal(Date.parse(undo.originalStartsAt), Date.parse(original.startsAt));
  assert.equal(undo.connectionId, conn.cal);

  // Un-marking narrows authority and still works after a downgrade.
  await setPlan(A, 'autopilot', 'expired');
  await rejects(rpc(A, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [deep, true]), /autopilot_required/);
  assert.equal((await rpc(A, 'apm_autopilot_set_event_flexible', '$1::uuid, $2', [deep, false])).flexible, false);
  await setPlan(A, 'autopilot', 'active');
  await admin('delete from public.personal_os where user_id = $1', [A]);
  await revoke(A, rule.id);
});

test('calendar.decline: only invitations that break a declared boundary, with a polite note; undo re-accepts', async () => {
  const day = new Date(Date.now() + 3 * DAY);
  const rule = await grant(A, 'calendar.decline', {
    timezone: 'UTC', maxPerDay: 2, horizonDays: 14, matchTitleKeywords: ['catch-up'], maxAttendees: 10, protectedTitleKeywords: [],
    boundaries: [{ weekdays: [isoDow(day)], start: '17:00', end: '23:59' }],
  });
  const invite = { organizer: { email: 'org@x.org' }, attendees: [{ email: 'me@x.org', self: true }, { email: 'org@x.org' }] };
  const late = await event({ title: 'Team catch-up', ...slot(3, 18), ...invite });
  const midday = await event({ title: 'Team catch-up', ...slot(3, 12), ...invite });
  const mine = await event({ title: 'Team catch-up', ...slot(3, 19) });
  const focus = await event({ title: 'Focus catch-up', ...slot(3, 20), ...invite });
  await rejects(claim(A, rule.id, 'dc-bound-001', { eventId: midday }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'dc-mine-0001', { eventId: mine }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'dc-prot-0001', { eventId: focus }), /autopilot_event_protected/);
  await rejects(claim(A, rule.id, 'dc-xtra-0001', { eventId: late, note: 'rude' }), /autopilot_invalid_payload/);
  const declined = await claim(A, rule.id, 'dc-ok-000001', { eventId: late });
  assert.match(declined.action.payload.composed.note, /^Thank you for the invitation/);
  assert.equal(declined.execution.proposed_starts_at, null, 'a decline holds no calendar slot');
  await record(A, declined.execution.id, 'verified', 'ev-late');
  assert.equal((await rpc(A, 'apm_autopilot_undo_target', '$1::uuid', [declined.execution.id])).undoMethod, 'reaccept');
  await revoke(A, rule.id);
});

test('appointment.book: free bookings only; anything asking for payment stops as a prepared Life OS action', async () => {
  const rule = await grant(A, 'appointment.book', {
    ...ALL_DAY, maxPerDay: 2, horizonDays: 30,
    providers: [{ email: 'Desk@Clinic.Example.com', label: 'Riverside Clinic', category: 'medical', appointmentTypes: ['annual check-up'] }],
  });
  const base = { connectionId: conn.mail, providerEmail: 'desk@clinic.example.com', appointmentType: 'annual check-up', paymentRequired: false, ...slot(9, 9, 30) };
  await rejects(claim(A, rule.id, 'bk-prov-0001', { ...base, providerEmail: 'other@clinic.example.com' }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'bk-type-0001', { ...base, appointmentType: 'start new medication' }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'bk-text-0001', { ...base, body: 'please prescribe' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'bk-pay-type1', { ...base, paymentRequired: 'no' }), /autopilot_invalid_payload/);

  const before = await count(`select count(*)::int n from public.autopilot_executions where user_id = $1 and action_class = 'appointment.book'`, [A]);
  const stopped = await claim(A, rule.id, 'bk-stop-0001', { ...base, paymentRequired: true });
  assert.equal(stopped.stopped, 'payment_required');
  assert.equal(stopped.action.status, 'prepared');
  assert.equal(stopped.action.requires_approval, true);
  assert.equal(stopped.execution, undefined);
  assert.equal(await count(`select count(*)::int n from public.autopilot_executions where user_id = $1 and action_class = 'appointment.book'`, [A]), before, 'a stop never claims');
  assert.equal(await count(`select count(*)::int n from public.life_admin_items where user_id = $1 and kind = 'appointment' and details->>'preparedActionId' = $2`, [A, stopped.action.id]), 1);
  assert.equal(await count(`select count(*)::int n from public.audit_events where event_type = 'autopilot.execution_stopped' and object_id = $1`, [stopped.action.id]), 1);
  const again = await claim(A, rule.id, 'bk-stop-0001', { ...base, paymentRequired: true });
  assert.deepEqual([again.replayed, again.stopped, again.action.id], [true, 'payment_required', stopped.action.id]);

  const deposit = (await admin(`insert into public.message_signals (user_id, connection_id, signal_type, summary) values ($1, $2, 'meeting', 'Booking needs a $50 deposit by card') returning id`, [A, conn.mail])).rows[0].id;
  assert.equal((await claim(A, rule.id, 'bk-stop-0002', { ...base, ...slot(10, 9, 30), sourceSignalId: deposit })).stopped, 'payment_required');

  const booked = await claim(A, rule.id, 'bk-ok-000001', base);
  const composed = booked.action.payload.composed;
  assert.equal(composed.to, 'desk@clinic.example.com');
  assert.equal(composed.subject, 'Appointment request: annual check-up');
  assert.match(composed.body, /needs no payment, card or deposit/);
  await record(A, booked.execution.id, 'verified', 'gmail-msg-2');
  await rejects(rpc(A, 'apm_autopilot_undo_target', '$1::uuid', [booked.execution.id]), /autopilot_cannot_undo/);
  await revoke(A, rule.id);
});

test('subscription.cancel: saves money only — fixed email to an allowed domain or a prepared request', async () => {
  const rule = await grant(A, 'subscription.cancel', { timezone: 'UTC', maxPerDay: 2, allowedProviderDomains: ['streamco.example.com'] });
  const sub = (await admin(`insert into public.life_admin_items (user_id, kind, title) values ($1, 'subscription', 'StreamCo Premium') returning id`, [A])).rows[0].id;
  const bill = (await admin(`insert into public.life_admin_items (user_id, kind, title) values ($1, 'bill', 'Water bill') returning id`, [A])).rows[0].id;
  const base = { connectionId: conn.mail, lifeAdminItemId: sub, route: 'email', cancelEmail: 'cancel@streamco.example.com' };
  await rejects(claim(A, rule.id, 'sc-kind-0001', { ...base, lifeAdminItemId: bill }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'sc-dom-00001', { ...base, cancelEmail: 'cancel@phish.example.net' }), /autopilot_outside_rule/);
  await rejects(claim(A, rule.id, 'sc-pay-00001', { ...base, accountRef: '4111 1111 1111 1111' }), /autopilot_payment_data_refused/);
  await rejects(claim(A, rule.id, 'sc-upg-00001', { ...base, route: 'upgrade' }), /autopilot_invalid_payload/);
  await rejects(claim(A, rule.id, 'sc-body-0001', { ...base, body: 'switch me to annual' }), /autopilot_invalid_payload/);

  const web = await claim(A, rule.id, 'sc-web-00001', { connectionId: conn.mail, lifeAdminItemId: sub, route: 'web' });
  assert.equal(web.stopped, 'needs_user');
  assert.equal(web.action.status, 'prepared');

  const sent = await claim(A, rule.id, 'sc-ok-000001', { ...base, accountRef: 'member 88-12' });
  assert.equal(sent.action.payload.composed.to, 'cancel@streamco.example.com');
  assert.match(sent.action.payload.composed.body, /cancel my subscription "StreamCo Premium" \(account member 88-12\)/);
  assert.match(sent.action.payload.composed.body, /do not renew, upgrade or change the plan/);
  await rejects(claim(A, rule.id, 'sc-twice-001', base), /autopilot_collision/);
  await record(A, sent.execution.id, 'verified', 'gmail-msg-3');

  // The done-list shows what happened today, Undo where it exists, and a clear
  // "can't undo" label where it does not; stops show as "needs you".
  const today = new Date().toISOString().slice(0, 10);
  const done = await rpc(A, 'apm_autopilot_done_list', '$1::date', [today]);
  const cancel = done.find((item) => item.executionId === sent.execution.id);
  assert.deepEqual([cancel.canUndo, cancel.reversible], [false, false]);
  assert.match(cancel.undoLabel, /^Can't undo/);
  assert.match(cancel.summary, /StreamCo Premium/);
  const move = done.find((item) => item.actionClass === 'calendar.reschedule');
  assert.equal(move.canUndo, true);
  assert.ok(done.some((item) => item.kind === 'stopped' && item.status === 'needs_you' && item.stoppedReason === 'needs_user'));
  assert.ok(done.some((item) => item.kind === 'stopped' && item.stoppedReason === 'payment_required'));
  assert.deepEqual(await rpc(B, 'apm_autopilot_done_list', '$1::date', [today]), [], 'owner-only');
  await revoke(A, rule.id);
});

test('new surfaces are RPC-only, pinned, and closed to anon', async () => {
  await rejects(db.transaction(async (tx) => { await tx.exec('set local role anon'); return tx.query(`select public.apm_autopilot_done_list(current_date)`); }), /permission denied/);
  await rejects(db.transaction(async (tx) => { await tx.exec('set local role anon'); return tx.query(`select public.apm_autopilot_set_event_flexible(gen_random_uuid(), true)`); }), /permission denied/);
  await rejects(as(A, `select private.apm_autopilot_prepare_email_send($1::uuid, '{}'::jsonb, '{}'::jsonb)`, [A]), /permission denied/);
  await rejects(as(A, `select private.apm_autopilot_require_connection($1::uuid, '"x"'::jsonb, 'email.send')`, [A]), /permission denied/);
  const unpinned = (await admin(`select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like 'apm_%autopilot%' and not coalesce(p.proconfig @> array['search_path=""'], false)`)).rows;
  assert.deepEqual(unpinned, []);
  const exposed = (await admin(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'apm_%autopilot%' and p.prosecdef`)).rows;
  assert.deepEqual(exposed, []);
});
