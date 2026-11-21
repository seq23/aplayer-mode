// Migration 0066 on the REAL chain (docs/35): "Report this" on a coach reply is stored
// with an audit row by the one governed writer; nobody can report someone else's reply,
// a user's own words, or write the table directly. The review sign-in audit event is on
// the Worker allow-list (the allow-list itself is pinned in security-write-surface-db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { realChain, rejects, U } from './helpers/real-chain.mjs';

let h;
const A = U(661), B = U(662);
const S = '00000000-0000-4000-8000-0000000006c1';

test.before(async () => {
  h = await realChain();
  for (const id of [A, B]) await h.admin('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@example.com`]);
  await h.admin(`insert into public.coaching_sessions (id, user_id, mode) values ($1, $2, 'standard')`, [S, A]);
});

const turn = async (userId, role, content) => (await h.admin(
  'insert into public.coaching_turns (user_id, session_id, role, content) values ($1, $2, $3, $4) returning id', [userId, S, role, content])).rows[0].id;
const report = (userId, turnId, reason = 'harmful', note = null) => h.as(userId, 'select public.apm_report_coach_reply($1, $2, $3) as r', [turnId, reason, note]);

test('a person reports their own coach reply: stored with a snapshot and an audit row; a second tap replays', async () => {
  const reply = await turn(A, 'assistant', 'Skip sleep and push through.');
  const first = (await report(A, reply, 'harmful', 'This is unsafe advice')).rows[0].r;
  assert.equal(first.replayed, false);
  const row = (await h.admin('select user_id, turn_id, session_id, reason, note, reply_excerpt, status from public.coaching_reports where id = $1', [first.reportId])).rows[0];
  assert.deepEqual(row, { user_id: A, turn_id: reply, session_id: S, reason: 'harmful', note: 'This is unsafe advice', reply_excerpt: 'Skip sleep and push through.', status: 'open' });
  const audit = (await h.admin("select actor_type, object_type, object_id, metadata from public.audit_events where user_id = $1 and event_type = 'coaching.reply_reported'", [A])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].object_id, first.reportId);
  assert.deepEqual(Object.keys(audit[0].metadata).sort(), ['reason', 'sessionId', 'turnId'], 'ids and the reason only: never the reply text or the note');
  const again = (await report(A, reply, 'wrong')).rows[0].r;
  assert.deepEqual(again, { reportId: first.reportId, replayed: true });
  assert.equal((await h.admin('select count(*)::int as n from public.coaching_reports where user_id = $1', [A])).rows[0].n, 1);
  // She can read her own reports; B cannot.
  assert.equal((await h.as(A, 'select count(*)::int as n from public.coaching_reports')).rows[0].n, 1);
  assert.equal((await h.as(B, 'select count(*)::int as n from public.coaching_reports')).rows[0].n, 0);
});

test('nobody reports another person\'s reply, their own words, or with an invented reason; nobody writes the table', async () => {
  const reply = await turn(A, 'assistant', 'Take a walk.');
  const words = await turn(A, 'user', 'I feel off');
  await rejects(report(B, reply), /report_turn_not_found/);
  await rejects(report(A, words), /report_turn_not_found/);
  await rejects(report(A, reply, 'spam'), /report_invalid_reason/);
  await rejects(report(A, reply, 'other', 'x'.repeat(501)), /report_invalid_note/);
  await rejects(h.as(A, `insert into public.coaching_reports (user_id, reason, reply_excerpt) values ($1, 'other', 'x')`, [A]), /permission denied/);
  await rejects(h.as(A, `update public.coaching_reports set status = 'reviewed'`), /permission denied/);
  await rejects(h.asRole('anon', null, 'select public.apm_report_coach_reply($1, $2, $3)', [reply, 'harmful', null]), /permission denied/);
});

test('reports are in the data-rights registry and go when the account goes', async () => {
  const reg = (await h.admin("select 1 from private.data_rights_tables where table_schema = 'public' and table_name = 'coaching_reports' and user_column = 'user_id'")).rows;
  assert.equal(reg.length, 1);
  const SB = '00000000-0000-4000-8000-0000000006c2';
  await h.admin(`insert into public.coaching_sessions (id, user_id, mode) values ($1, $2, 'standard')`, [SB, B]);
  const reply = (await h.admin(`insert into public.coaching_turns (user_id, session_id, role, content) values ($1, $2, 'assistant', 'Hello') returning id`, [B, SB])).rows[0].id;
  await report(B, reply, 'other');
  assert.equal((await h.admin('select count(*)::int as n from public.coaching_reports where user_id = $1', [B])).rows[0].n, 1);
  await h.admin('delete from auth.users where id = $1', [B]);
  assert.equal((await h.admin('select count(*)::int as n from public.coaching_reports where user_id = $1', [B])).rows[0].n, 0);
});

test('the review sign-in audit event is accepted for a user actor and nothing wider', async () => {
  await h.service("select public.apm_service_record_audit($1::uuid, 'auth.review_login', 'user', 'auth_user', $2, '{}'::jsonb)", [A, A]);
  await rejects(h.service("select public.apm_service_record_audit($1, 'auth.review_login', 'system', null, null, '{}'::jsonb)", [A]), /audit_event_not_allowed/);
});

// 0099: "Report this" on plan items and Radar items. Stored as kind + id + reason, never text.
const reportItem = (userId, kind, ref, reason = 'wrong') => h.as(userId, 'select public.apm_report_content($1, $2, $3) as r', [kind, ref, reason]);
test('a person reports a plan item or a Radar item: ids and reason only, audited, one per item; bad input and direct writes refused', async () => {
  const first = (await reportItem(A, 'plan_item', 'plan:abc:walk', 'harmful')).rows[0].r;
  assert.equal(first.replayed, false);
  assert.equal((await reportItem(A, 'plan_item', 'plan:abc:walk', 'other')).rows[0].r.reportId, first.reportId, 'a second tap replays the first');
  await reportItem(A, 'radar_item', 'calendar:evt@google.com');
  const row = (await h.admin('select * from public.content_reports where id = $1', [first.reportId])).rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['created_at', 'id', 'kind', 'reason', 'ref', 'status', 'user_id'], 'no column can hold the item text');
  assert.equal(row.reason, 'harmful');
  const audit = (await h.admin("select object_id, metadata from public.audit_events where user_id = $1 and event_type = 'content.reported'", [A])).rows;
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.find((a) => a.object_id === first.reportId).metadata, { kind: 'plan_item', ref: 'plan:abc:walk', reason: 'harmful' });
  assert.equal((await h.as(B, 'select count(*)::int as n from public.content_reports')).rows[0].n, 0, 'another person sees none of them');
  await rejects(reportItem(A, 'goal', 'x'), /report_invalid_kind/);
  await rejects(reportItem(A, 'plan_item', 'x', 'spam'), /report_invalid_reason/);
  await rejects(reportItem(A, 'plan_item', ''), /report_invalid_ref/);
  await rejects(reportItem(A, 'plan_item', 'x'.repeat(201)), /report_invalid_ref/);
  await rejects(h.as(A, `insert into public.content_reports (user_id, kind, ref, reason) values ($1, 'plan_item', 'y', 'other')`, [A]), /permission denied/);
  await rejects(h.asRole('anon', null, 'select public.apm_report_content($1, $2, $3)', ['plan_item', 'x', 'other']), /permission denied/);
});

test('0105: only the allowlisted review address gets Autopilot and sample Life-areas items; a store plan is never overwritten; clients cannot call it', async () => {
  const R = U(663), S2 = U(664);
  await h.admin("insert into auth.users (id, email) values ($1, 'appreview@aplayermode.com'), ($2, 'someone@example.com')", [R, S2]);
  const prepare = (id) => h.admin('select public.apm_service_review_account_prepare($1) as r', [id]);
  const out = (await prepare(R)).rows[0].r;
  assert.equal(out.plan, 'autopilot');
  const ent = (await h.admin('select plan, status, provider, current_period_end from public.subscription_entitlements where user_id = $1', [R])).rows[0];
  assert.deepEqual([ent.plan, ent.status, ent.provider], ['autopilot', 'active', null]);
  assert.ok(ent.current_period_end > new Date(), 'bounded by the allowlist end date');
  assert.equal((await h.admin('select private.apm_has_core_access($1) as ok', [R])).rows[0].ok, true);
  const items = (await h.admin("select kind, title, details from public.life_admin_items where user_id = $1 order by kind", [R])).rows;
  assert.deepEqual(items.map((i) => i.kind), ['appointment', 'bill', 'shopping']);
  assert.ok(items.every((i) => i.title.endsWith('(sample)') && i.details.sample === true), 'every sample is labelled');
  assert.equal(items.find((i) => i.kind === 'shopping').details.flexibleSchedule, true, 'a hard day can move it');
  // A second sign-in re-times the samples instead of duplicating them.
  await prepare(R);
  assert.equal((await h.admin('select count(*)::int as n from public.life_admin_items where user_id = $1', [R])).rows[0].n, 3);
  // Nobody else, and no autonomy: no permission is switched on.
  await rejects(prepare(S2), /review_account_only/);
  assert.equal((await h.admin('select count(*)::int as n from public.permissions where user_id = $1 and enabled', [R])).rows[0].n, 0);
  await rejects(h.as(R, 'select public.apm_service_review_account_prepare($1)', [R]), /permission denied/);
  // A store subscription always governs.
  await h.admin("update public.subscription_entitlements set plan = 'chief_of_staff', provider = 'app_store' where user_id = $1", [R]);
  await prepare(R);
  assert.deepEqual((await h.admin('select plan, provider from public.subscription_entitlements where user_id = $1', [R])).rows[0], { plan: 'chief_of_staff', provider: 'app_store' });
});
