import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { realChain, rejects, U } from './helpers/real-chain.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: { contents: "export * from './src/proposalProducers'; export * from './src/crypto'; export { buildRadarItems } from '@apm/radar'; export { generateGoalPlan } from '@apm/planning';", resolveDir: root },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const { approveSuiteProposal, buildRadarItems, encryptConnectorCredential, generateGoalPlan, prepareSuiteProposals, runSuiteProposals } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const userId = U(520), otherId = U(521), emailId = U(522), calendarId = U(523);
const signalId = U(524), commitmentId = U(525), flexId = U(526), focusId = U(527), blockerId = U(530);
const now = new Date();
const at = (hour, minute = 0, offset = 1) => {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + offset);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};
const env = {
  SUPABASE_URL: 'https://phase-one.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test', CONNECTOR_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  GLOBAL_ACTION_EXECUTION: 'true', ACTION_EMAIL_EXECUTION: 'true', ACTION_CALENDAR_EXECUTION: 'true', ACTION_LIFE_GRAPH_EXECUTION: 'true',
};
const input = { env, userId, accessToken: 'user-jwt' };
const permissions = [
  { id: U(528), userId, domain: 'email', actionType: 'send', enabled: true, autonomyLevel: 4 },
  { id: U(536), userId, domain: 'life_graph', actionType: 'plan_logistics', enabled: true, autonomyLevel: 4 },
  { id: U(529), userId, domain: 'calendar', actionType: 'event_write', enabled: true, autonomyLevel: 4 },
];
const entitlement = { userId, plan: 'life_os', status: 'active' };
const connection = (id, kind, provider, ...scopes) => ({
  id, userId, kind, provider, scopes, status: 'connected', accountLabel: 'player@example.com', label: kind === 'email' ? 'Inbox' : 'Work calendar',
});
const connections = [
  connection(emailId, 'email', 'microsoft', 'Mail.Read', 'Mail.Send'),
  connection(calendarId, 'calendar', 'google', 'https://www.googleapis.com/auth/calendar.events'),
];
const event = (id, title, startsAt, endsAt) => ({
  id, title, userId, connectionId: calendarId, provider: 'google', externalEventId: id,
  startsAt, endsAt, allDay: false, availability: 'busy', recurrence: {}, organizer: { self: true },
  attendees: [], sourceVersion: '"v1"', deleted: false,
});
const calendarEvents = [
  event(flexId, 'Equipment inventory', at(10), at(10, 30)),
  event(focusId, 'Focus time', at(9, 30), at(11)),
  event(blockerId, 'School pickup', at(11), at(11, 30)),
];
const messageSignals = [{
  id: signalId, userId, provider: 'microsoft', connectionId: emailId, externalMessageId: 'incoming-1',
  externalThreadId: 'thread-1', signalType: 'request', summary: 'Review the rehearsal schedule.',
  confidence: 0.9, relatedCommitmentId: commitmentId, observedAt: now.toISOString(),
}];
const commitments = [{
  id: commitmentId, userId, owner: 'user', status: 'understood', title: 'Review the rehearsal schedule',
  provenance: { kind: 'inferred', sourceType: 'outlook', sourceRef: 'incoming-1' },
}];
const graph = (overrides = {}) => ({
  identity: { userId, timezone: 'UTC' }, goals: [], projects: [], nextActions: [], lifeAdminItems: [], lifeRelationships: [],
  calendarEvents, connections, permissions, entitlement, messageSignals, commitments, actions: [], dayRecords: [], goalPlans: [], planCompletions: [], tracks: [], roles: [], pillarSettings: [],
  ...overrides,
});
let h, encrypted, calls, latest, calendarVersion, currentEvents, unavailable;
const rpc = async (name, args = []) => (await h.service(
  `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as result`, args,
)).rows[0].result;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const writes = () => calls.filter((call) => !call.url.includes('supabase.co') && call.method !== 'GET');
const mapAction = (row) => ({
  ...row, userId, actionType: row.action_type, idempotencyKey: row.idempotency_key, requiresApproval: row.requires_approval,
});
const find = async (kind) => mapAction((await h.admin("select * from public.actions where payload->>'suiteProposal' = $1 order by created_at desc limit 1", [kind])).rows[0]);

test.before(async () => {
  h = await realChain();
  encrypted = await encryptConnectorCredential(env, { accessToken: 'fake-connector-token' });
  await h.admin('insert into auth.users (id) values ($1), ($2)', [userId, otherId]);
  await h.admin("insert into public.subscription_entitlements (user_id, plan, status) values ($1, 'life_os', 'active') on conflict (user_id) do update set plan = excluded.plan, status = excluded.status", [userId]);
  for (const permission of permissions) await h.admin(
    'insert into public.permissions (id,user_id,domain,action_type,autonomy_level,enabled) values ($1,$2,$3,$4,4,true)',
    [permission.id, userId, permission.domain, permission.actionType],
  );
  for (const c of connections) await h.as(userId,
    'insert into public.integration_connections(id,user_id,provider,kind,external_account_id,status,scopes) values($1,$2,$3,$4,$5,$6,$7)',
    [c.id, userId, c.provider, c.kind, c.accountLabel, c.status, c.scopes],
  );
  for (const e of calendarEvents) {
    await h.admin(`insert into public.calendar_events (id,user_id,connection_id,provider,external_event_id,title,starts_at,ends_at,organizer,source_version)
      values ($1,$2,$3,'google',$1::uuid::text,$4,$5,$6,'{"self":true}',$7)`, [e.id, userId, calendarId, e.title, e.startsAt, e.endsAt, e.sourceVersion]);
  }
  for (const id of [flexId, focusId]) await h.as(userId, 'select public.apm_autopilot_set_event_flexible($1,true)', [id]);
});
test.afterEach(async () => {
  if (h) await h.admin('delete from public.life_admin_items where user_id = $1', [userId]);
});
test.after(async () => h?.db.close());
test.beforeEach((t) => {
  calls = [];
  unavailable = undefined;
  latest = 'incoming-1';
  calendarVersion = '"v1"';
  currentEvents = calendarEvents;
  t.mock.method(globalThis, 'fetch', async (raw, options = {}) => {
    const url = new URL(raw);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const method = options.method ?? 'GET';
    calls.push({ url: url.href, method, body, headers: new Headers(options.headers) });
    if (url.origin === env.SUPABASE_URL) {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').at(-1);
        const args = {
          apm_service_action_prepare: ['user_id', 'domain', 'action_type', 'payload', 'reason', 'permission_id', 'idempotency_key'],
          apm_service_action_claim: ['user_id', 'action_id'],
          apm_service_action_result: ['user_id', 'action_id', 'outcome', 'provider', 'external_ref', 'failure_code'],
          apm_service_suite_flexible_events: ['user_id', 'eligible_only'],
          apm_service_suite_proposal_candidates: ['slot'],
          apm_service_apply_suite_life_graph: ['user_id', 'action_id'],
        }[name];
        if (name === unavailable) return json({ message: 'unavailable' }, 503);
        if (!args) throw new Error(`Unexpected RPC ${name}`);
        assert.equal(new Headers(options.headers).get('apikey'), env.SUPABASE_SECRET_KEY);
        try { return json(await rpc(name, args.map((arg) => body[`p_${arg}`]))); }
        catch (e) { return json({ message: e.message }, 400); }
      }
      const c = connections.find((entry) => url.searchParams.get('id') === `eq.${entry.id}`);
      if (c) return json([{ id: c.id, kind: c.kind, provider: c.provider, encrypted_credentials: encrypted.ciphertext, credential_iv: encrypted.iv }]);
    }
    if (url.hostname === 'graph.microsoft.com' && url.pathname === '/v1.0/me/messages') {
      assert.equal(url.searchParams.get('$filter'), "conversationId eq 'thread-1'");
      const message = {
        id: 'incoming-1', conversationId: 'thread-1', subject: 'Rehearsal schedule', isDraft: false,
        sentDateTime: '2026-11-20T08:00:00Z', from: { emailAddress: { address: 'jordan@example.com' } },
      };
      return json({ value: latest === message.id ? [message] : [
        message, { id: latest, conversationId: 'thread-1', sentDateTime: '2026-11-20T09:00:00Z' },
      ] });
    }
    if (url.hostname === 'graph.microsoft.com' && url.pathname === '/v1.0/me/messages/incoming-1/reply') return new Response(null, { status: 202 });
    if (url.hostname === 'www.googleapis.com' && method === 'POST') return json({ id: 'created-goal-block', ...body });
    if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/events')) return json({
      items: currentEvents.map((e) => ({
        id: e.externalEventId, summary: e.title, start: { dateTime: e.startsAt }, end: { dateTime: e.endsAt },
        organizer: e.organizer, attendees: e.attendees, etag: e.id === flexId ? calendarVersion : e.sourceVersion,
      })),
    });
    if (url.hostname === 'www.googleapis.com' && method === 'PATCH') return json({ id: flexId, ...body });
    throw new Error(`Unexpected request ${method} ${url.href}`);
  });
});

test('both producers prepare from Radar; retries and no tap perform no provider writes', async () => {
  const current = graph();
  const radar = buildRadarItems(current, { now });
  assert.ok(radar.some((item) => item.relatedCommitmentId === commitmentId && item.reasonCodes.includes('email.reply_owed')));
  assert.ok(radar.some((item) => item.reasonCodes.includes('calendar.busy_overlap')));
  assert.deepEqual(await prepareSuiteProposals(env, current, now), { prepared: 2, stops: [] });
  assert.equal((await prepareSuiteProposals(env, current, now)).prepared, 0, 'replayed against the real action ledger');
  const reply = await find('reply');
  const move = await find('calendar_fix');
  assert.equal(reply.status, 'prepared');
  assert.equal(reply.requiresApproval, true);
  assert.equal(reply.payload.to, 'jordan@example.com');
  assert.equal(reply.payload.threadId, 'thread-1');
  assert.equal(move.payload.externalEventId, flexId);
  assert.equal(move.payload.startsAt, at(11, 30));
  assert.equal(move.payload.endsAt, at(12));
  assert.equal(writes().length, 0);
});

test('Roundtable, lapsed plans, disabled permissions, and missing write-scoped connectors stop before execution', async () => {
  for (const ent of [{ ...entitlement, plan: 'chief_of_staff' }, { ...entitlement, status: 'expired' }, undefined]) {
    assert.equal((await prepareSuiteProposals(env, graph({ entitlement: ent }), now)).prepared, 0);
  }
  assert.equal((await prepareSuiteProposals(env, graph({ permissions: [] }), now)).prepared, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await prepareSuiteProposals(env, graph({ connections: [] }), now), {
    prepared: 0, stops: ['EMAIL_CONNECTOR_MISSING_OR_READ_ONLY', 'CALENDAR_CONNECTOR_MISSING_OR_READ_ONLY'],
  });
  const googleMail = connection(emailId, 'email', 'google', 'https://www.googleapis.com/auth/gmail.send');
  assert.deepEqual(await prepareSuiteProposals(env, graph({ connections: [googleMail] }), now), {
    prepared: 0, stops: ['EMAIL_CONNECTOR_MISSING_OR_READ_ONLY', 'CALENDAR_CONNECTOR_MISSING_OR_READ_ONLY'],
  });
  assert.equal(calls.length, 0);
  await assert.rejects(async () => approveSuiteProposal(await find('reply'), graph({ entitlement: { ...entitlement, plan: 'chief_of_staff' } }), input, now), /not_authorized/);
  await assert.rejects(async () => approveSuiteProposal(await find('reply'), graph({ permissions: permissions.filter((entry) => entry.domain !== 'email') }), input, now), /not_authorized/);
  assert.equal(writes().length, 0);
});

test('approval sends the reviewed reply once to the original thread and reports by action ID', async () => {
  const action = await find('reply');
  await h.as(userId, "select public.apm_report_content('action_proposal',$1,'wrong')", [action.id]);
  await rejects(h.as(otherId, "select public.apm_report_content('action_proposal',$1,'wrong')", [action.id]), /report_invalid_ref/);
  const result = await approveSuiteProposal(action, graph(), input, now);
  assert.equal(result.status, 'verified');
  await assert.rejects(approveSuiteProposal(action, graph(), input, now), /Supabase request failed/);
  const [send] = writes();
  assert.equal(writes().length, 1);
  assert.equal(send.url, 'https://graph.microsoft.com/v1.0/me/messages/incoming-1/reply');
  assert.deepEqual(send.body, { comment: action.payload.body });
});

test('approval moves only the named flexible block and records its provider receipt', async () => {
  const action = await find('calendar_fix');
  const result = await approveSuiteProposal(action, graph(), input, now);
  assert.equal(result.status, 'verified');
  assert.equal(writes().length, 1);
  const [write] = writes();
  assert.ok(write.url.includes(flexId) && !write.url.includes(focusId));
  assert.equal(write.headers.get('if-match'), '"v1"');
  assert.deepEqual(write.body, { start: { dateTime: at(11, 30) }, end: { dateTime: at(12) } });
  const [receipt] = (await h.admin('select provider, external_ref from public.action_attempts where action_id=$1', [action.id])).rows;
  assert.deepEqual(receipt, { provider: 'google', external_ref: flexId });
});

test('reject is owner-scoped and irreversible; a stale calendar or answered thread makes no new proposal', async () => {
  const action = await find('reply');
  const linked = graph({
    calendarEvents: [],
    commitments: commitments.map((item) => ({ ...item, provenance: { ...item.provenance, sourceRef: 'incoming-2' } })),
    messageSignals: messageSignals.map((item) => ({ ...item, externalMessageId: 'incoming-2' })),
  });
  latest = 'answered';
  assert.equal((await prepareSuiteProposals(env, linked, now)).prepared, 0);
  const copy = (await rpc('apm_service_action_prepare', [userId, 'email', 'email.send', action.payload, 'Reply to a message', null, 'suite:reply:reject-test'])).action;
  await rejects(rpc('apm_service_reject_suite_proposal', [otherId, copy.id]), /action_invalid_state/);
  await rpc('apm_service_reject_suite_proposal', [userId, copy.id]);
  await rejects(rpc('apm_service_action_claim', [userId, copy.id]), /action_invalid_state/);
  const pending = (await rpc('apm_service_action_prepare', [userId, 'email', 'email.send', action.payload, 'Reply to a message', null, 'suite:reply:stale-test'])).action;
  await assert.rejects(approveSuiteProposal(mapAction(pending), graph(), input, now), /action_proposal_stale/);
  assert.equal(writes().length, 0);
});

test('a changed event or a newly occupied slot cannot be moved after the tap', async () => {
  const action = await find('calendar_fix');
  const prepareCopy = async (suffix) => mapAction((await rpc('apm_service_action_prepare', [
    userId, 'calendar', 'calendar.reschedule', action.payload, 'Resolve a clash', null, `suite:calendar_fix:${suffix}`,
  ])).action);
  calendarVersion = '"v2"';
  await assert.rejects(approveSuiteProposal(await prepareCopy('new-version'), graph(), input, now), /action_proposal_stale/);
  calendarVersion = '"v1"';
  currentEvents = [...calendarEvents, event(U(531), 'Another commitment', at(11, 45), at(12, 30))];
  await assert.rejects(approveSuiteProposal(await prepareCopy('new-blocker'), graph(), input, now), /action_proposal_stale/);
  assert.equal(writes().length, 0);
});

test('crowded days have a Radar flag and produce a concrete move to a lighter day', async () => {
  const action = await find('calendar_fix');
  const end = at(16, 30);
  const crowded = [
    { ...calendarEvents[0], startsAt: at(16), endsAt: end },
    event(U(534), 'Team workshop', at(8), at(11)),
    event(U(535), 'Production window', at(11), at(15)),
  ];
  const current = graph({ calendarEvents: crowded, messageSignals: [], actions: [{ ...action, status: 'verified' }] });
  assert.ok(buildRadarItems(current, { now }).some((item) => item.reasonCodes.includes('calendar.overload')));
  assert.equal((await prepareSuiteProposals(env, current, now)).prepared, 1);
  const move = await find('calendar_fix');
  assert.equal(move.payload.originalEndsAt, end);
  assert.ok(move.payload.startsAt.slice(0, 10) > end.slice(0, 10));
  assert.equal(writes().length, 0);
});

test('the existing quarter-hour cron assigns each eligible user to one daily slot and emits an output with a named stop', async () => {
  const slot = (await h.admin('select mod(mod(hashtext($1),96)+96,96) as slot', [userId])).rows[0].slot;
  assert.deepEqual(await rpc('apm_service_suite_proposal_candidates', [slot]), [userId]);
  assert.deepEqual(await rpc('apm_service_suite_proposal_candidates', [(slot + 1) % 96]), []);
  const tick = new Date(now);
  tick.setUTCHours(0, ((slot + 1) % 96) * 15, 0, 0);
  assert.match(await runSuiteProposals(env, tick), /^OUTPUT 0 .*NO_ELIGIBLE_PROPOSALS/);
  assert.match(await runSuiteProposals({}, tick), /^OUTPUT 0 .*SUITE_PROPOSALS_NO_SERVICE_CREDENTIAL/);
});

const phaseTime = new Date(at(8));
const phaseDay = phaseTime.toISOString().slice(0, 10);
const priorDay = at(0, 0, 0).slice(0, 10);
const prepPlans = (state) => prepareSuiteProposals(env, state, phaseTime, undefined, true);
const nextActionCount = async () => (await h.admin('select count(*)::int as count from public.next_actions where user_id = $1', [userId])).rows[0].count;

async function makeGoal(offset, seed, title) {
  const goal = { id: U(seed), userId, title, priority: 1, status: 'active' };
  const plan = generateGoalPlan(title, { startDate: at(0, 0, offset).slice(0, 10) });
  const record = { id: U(seed + 1), userId, goalId: goal.id, startDate: plan.startDate, endDate: plan.endDate, status: 'active', plan };
  await h.admin("insert into public.goals(id,user_id,title,status,health,provenance_kind,source_type) values($1,$2,$3,'active','on_track','stated','manual')", [goal.id, userId, title]);
  await h.admin("insert into public.goal_plans(id,user_id,goal_id,plan_key,template_key,persona,foreground_pillar,start_date,end_date,plan) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [record.id, userId, goal.id, plan.id, plan.provenance.templateKey, plan.persona.key, plan.foreground.pillar, plan.startDate, plan.endDate, plan]);
  return graph({ goals: [goal], goalPlans: [record], dayRecords: [{ day: priorDay, verdict: 'full_day', replans: [] }, { day: phaseDay, checkedInAt: phaseTime.toISOString(), replans: [] }] });
}

test('a saved setup step prepares a checklist without a connector and adds it just once after approval', async () => {
  const state = await makeGoal(1, 540, 'Release a short film');
  const local = { ...state, connections: [], calendarEvents: [] };
  assert.equal((await prepPlans({ ...local, entitlement: { ...entitlement, plan: 'chief_of_staff' } })).prepared, 0);
  assert.equal((await prepPlans(local)).prepared, 1);
  assert.equal((await prepPlans(local)).prepared, 0);
  const action = await find('goal_checklist');
  assert.equal(action.payload.goalId, state.goals[0].id);
  assert.equal(action.requiresApproval, true);
  assert.equal(await nextActionCount(), 0);
  await rejects(h.as(userId, 'select public.apm_service_apply_suite_life_graph($1,$2)', [userId, action.id]), /permission denied/);
  await rejects(rpc('apm_service_apply_suite_life_graph', [otherId, action.id]), /action_invalid_state/);
  unavailable = 'apm_service_apply_suite_life_graph';
  await assert.rejects(approveSuiteProposal(action, local, input, phaseTime));
  assert.equal(await nextActionCount(), 0);
  unavailable = undefined;
  const outcomes = await Promise.allSettled([
    approveSuiteProposal(action, local, input, phaseTime), approveSuiteProposal(action, local, input, phaseTime),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal((await find('goal_checklist')).status, 'verified');
  assert.deepEqual((await h.admin('select title, goal_id from public.next_actions where id = $1', [action.id])).rows,
    [{ title: action.payload.title, goal_id: state.goals[0].id }]);
  assert.equal(writes().length, 0);
});

test('a normal foreground step reserves real time after the tap, with a connector stop and live collision guard', async () => {
  const state = await makeGoal(-8, 542, 'Pass the architecture exam');
  assert.deepEqual(await prepPlans({ ...state, connections: [] }), { prepared: 0, stops: ['GOAL_CALENDAR_CONNECTOR_MISSING_OR_READ_ONLY'] });
  assert.equal((await prepPlans(state)).prepared, 1);
  const action = await find('goal_calendar');
  assert.equal(action.payload.goalId, state.goals[0].id);
  assert.equal(writes().length, 0);
  const copy = mapAction((await rpc('apm_service_action_prepare', [
    userId, action.domain, action.actionType, action.payload, 'Block time', null, 'suite:goal_calendar:collision',
  ])).action);
  currentEvents = [...calendarEvents, event(U(545), 'New meeting', action.payload.startsAt, action.payload.endsAt)];
  await assert.rejects(approveSuiteProposal(copy, state, input, phaseTime), /action_proposal_stale/);
  assert.equal(writes().length, 0);
  currentEvents = calendarEvents;
  assert.equal((await approveSuiteProposal(action, state, input, phaseTime)).status, 'verified');
  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].body, {
    summary: action.payload.title, start: { dateTime: action.payload.startsAt }, end: { dateTime: action.payload.endsAt },
  });
});

const adminItem = async (number, kind, start, options = {}) => {
  const id = U(number);
  const { endsAt, dueAt, importance = 2, flexible = true } = options;
  const details = { flexibleSchedule: flexible };
  const [row] = (await h.admin(`insert into public.life_admin_items
    (id,user_id,kind,title,starts_at,ends_at,due_at,importance,details) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
    returning updated_at`, [id, userId, kind, `Task ${number}`, start, endsAt ?? null, dueAt ?? null, importance, details])).rows;
  return { id, userId, kind, title: `Task ${number}`, startsAt: start, endsAt, dueAt, importance, status: 'open',
    details, recurrence: {}, updatedAt: row.updated_at.toISOString(), provenance: { kind: 'stated', sourceType: 'manual' } };
};
const savedStart = async (id) => (await h.admin('select starts_at from public.life_admin_items where id=$1', [id])).rows[0].starts_at.toISOString();

test('a missed day proposes only eligible tasks and a rejected proposal leaves its schedule intact', async () => {
  const flexible = await adminItem(550, 'shopping', at(12, 0, 0));
  const bill = await adminItem(551, 'bill', at(12));
  await h.as(userId, "select public.apm_record_consent('consumer_health_data','granted','2026-10-08')");
  const medicine = await adminItem(552, 'health_routine', at(12));
  const deadline = await adminItem(553, 'shopping', at(12), { dueAt: at(17) });
  const fixed = await adminItem(554, 'meal_plan', at(12), { flexible: false });
  const state = graph({ lifeAdminItems: [flexible, bill, medicine, deadline, fixed], dayRecords: [{ day: priorDay, verdict: 'miss' }] });
  assert.equal((await prepPlans({ ...state, permissions: [] })).prepared, 0);
  assert.equal((await prepPlans(state)).prepared, 1);
  const action = await find('missed_day');
  assert.equal(action.payload.itemId, flexible.id);
  assert.ok(action.payload.startsAt.slice(0, 10) > phaseDay);
  assert.equal(await savedStart(flexible.id), flexible.startsAt);
  await rpc('apm_service_reject_suite_proposal', [userId, action.id]);
  assert.equal((await prepPlans(state)).prepared, 0);
  await assert.rejects(approveSuiteProposal(action, state, input, phaseTime));
  for (const item of [flexible, bill, medicine, deadline, fixed]) assert.equal(await savedStart(item.id), item.startsAt);

  const another = await adminItem(555, 'meal_plan', at(15), { endsAt: at(15, 30) });
  const next = { ...state, lifeAdminItems: [another] };
  assert.equal((await prepPlans(next)).prepared, 1);
  const proposal = await find('missed_day');
  assert.equal((await approveSuiteProposal(proposal, next, input, phaseTime)).status, 'verified');
  assert.equal(await savedStart(another.id), proposal.payload.startsAt);
  assert.equal(writes().length, 0);
});

test('low mood or recovery mode proposes only today’s flexible admin, with an atomic stale-source check', async () => {
  const first = await adminItem(556, 'shopping', at(12));
  const second = await adminItem(557, 'meal_plan', at(14));
  const yesterday = await adminItem(558, 'shopping', at(14, 0, 0));
  const assumedNormal = graph({ lifeAdminItems: [first, second, yesterday] });
  assert.equal((await prepPlans(assumedNormal)).prepared, 0);
  const recovery = { ...assumedNormal, personalOS: { activeMode: 'recovery' }, lifeAdminItems: [first, yesterday] };
  assert.equal((await prepPlans(recovery)).prepared, 1);
  const action = await find('hard_day');
  assert.equal(action.payload.itemId, first.id);
  assert.equal(await savedStart(first.id), first.startsAt);
  await assert.rejects(approveSuiteProposal(action, recovery, { ...input, env: { ...env, ACTION_LIFE_GRAPH_EXECUTION: 'false' } }, phaseTime), /domain_execution_disabled/);
  await h.admin("update public.life_admin_items set due_at = now() where id = $1", [first.id]);
  await assert.rejects(approveSuiteProposal(action, recovery, input, phaseTime));
  assert.equal(await savedStart(first.id), first.startsAt);
  assert.equal((await find('hard_day')).status, 'prepared');
  const mood = { ...assumedNormal, lifeAdminItems: [second, yesterday], dayRecords: [{ day: phaseDay, mood: 2 }] };
  assert.equal((await prepPlans(mood)).prepared, 1);
  const proposal = await find('hard_day');
  assert.equal(proposal.payload.itemId, second.id);
  assert.equal((await approveSuiteProposal(proposal, mood, input, phaseTime)).status, 'verified');
  assert.equal(await savedStart(second.id), proposal.payload.startsAt);
  assert.equal(await savedStart(yesterday.id), yesterday.startsAt);
  assert.equal(writes().length, 0);
});
