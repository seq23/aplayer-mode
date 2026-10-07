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
