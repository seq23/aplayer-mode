// Worker-side coaching orchestration (services/api/src/coaching.ts):
//   * with NO approved model route (today's reality: every route is `candidate`)
//     coaching degrades to the scripted BHPC flow instead of failing closed, and
//     never calls OpenRouter;
//   * a candidate route never counts as eligible, even with a key configured;
//   * an approved route may only rephrase a slot, and a rewrite that breaks the
//     one-question rule is discarded for the scripted turn;
//   * crisis text is never sent to a model, the session is stopped and the audit
//     event carries pattern ids only;
//   * session phase persists, so the close into the Morning Sequence spans turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir;
let coaching;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-coaching-worker-'));
  await build({ entryPoints: { coaching: join(srcDir, 'coaching.ts') }, bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent' });
  coaching = await import(pathToFileURL(join(outDir, 'coaching.js')).href);
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const SESSION = '00000000-0000-4000-8000-0000000000c1';
const baseEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const prov = { kind: 'stated', sourceType: 'manual' };

const graph = {
  identity: { userId: USER, displayName: 'Jo', timezone: 'Europe/London' },
  roles: [{ id: 'r1', userId: USER, name: 'Training / competing', active: true, provenance: prov }],
  pillarSettings: [], tracks: [{ id: 't1', userId: USER, key: 'resilience', name: 'Resilience', active: true, foreground: false, provenance: prov }], modes: [],
  personalOS: {
    userId: USER, values: [], nonNegotiables: [], failurePatterns: [], weeklyCadence: { heavyDays: [], lightDays: [] }, coachingStyle: { firmness: 'direct' },
    accountability: { dayStart: 'guided' }, activeMode: 'standard', morningSequence: ['Fill a water bottle', 'Lace up'], schedulingPreference: 'ordered_stack',
    hardBoundaries: [], scoringConfig: { enabled: true, showSevenDaySnapshot: true }, installedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  },
  goals: [], milestones: [], projects: [], commitments: [],
  nextActions: [{ id: 'a1', userId: USER, title: 'Run the 20-minute easy loop', status: 'open' }],
  routines: [], people: [], lifeRelationships: [], lifeAdminItems: [], preferences: [], rules: [], radarItems: [], evidence: [],
  connections: [], calendarEvents: [], messageSignals: [], permissions: [], actions: [], dayRecords: [],
};
const plan = { userId: USER, date: '2026-10-06', mode: 'standard', numberOneMove: graph.nextActions[0], morningSequence: [], blocks: [], routineIds: [], commitmentIds: [], approvalActionIds: [], radarItemIds: [], completionState: 'not_started' };

const routeRow = (status) => ({
  route_id: 'or_test_route', model_id: 'test/model', provider_id: 'TestProvider', status, cost_class: 'zero',
  capabilities: ['conversation', 'reasoning', 'structured_output'], data_classes_allowed: ['private_life'], training_allowed: false, retention: 'zero',
  approved_for_highly_sensitive: false, quality_score: 90, reliability_score: 90, latency_score: 90, last_policy_reviewed_at: '2026-10-06T00:00:00Z', last_eval_run_at: '2026-10-06T00:00:00Z',
});

function harness({ routeStatus = 'candidate', modelText, session } = {}) {
  const db = {
    session: session ?? null,
    userTurns: [],
    patches: [],
    audits: [],
    openrouterCalls: [],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (href.startsWith('https://openrouter.ai/')) {
      db.openrouterCalls.push(body);
      return json({ choices: [{ message: { content: JSON.stringify({ text: modelText, nextMove: null }) } }], usage: {} });
    }
    const path = href.replace(baseEnv.SUPABASE_URL, '');
    if (path.startsWith('/rest/v1/coaching_sessions') && method === 'GET') return json(db.session ? [db.session] : []);
    if (path.startsWith('/rest/v1/coaching_sessions') && method === 'POST') {
      db.session = { id: SESSION, started_at: '2026-10-06T08:00:00Z', ...body[0] };
      return json([db.session]);
    }
    if (path.startsWith('/rest/v1/coaching_sessions') && method === 'PATCH') {
      db.patches.push(body); db.session = { ...db.session, ...body };
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/rest/v1/coaching_turns') && method === 'GET') return json(db.userTurns.map((content, i) => ({ id: `u${i}`, role: 'user', content, created_at: `2026-10-06T08:0${i}:00Z` })));
    if (path.startsWith('/rest/v1/coaching_turns') && method === 'POST') {
      for (const row of body) if (row.role === 'user') db.userTurns.push(row.content);
      // The assistant reply is stored with return=representation so its id reaches the app ("Report this").
      if (body[0]?.role === 'assistant') {
        assert.equal(new Headers(init.headers).get('prefer'), 'return=representation');
        db.assistantTurns = (db.assistantTurns ?? 0) + 1;
        return json([{ id: `00000000-0000-4000-8000-${String(db.assistantTurns).padStart(12, '0')}` }], 201);
      }
      return new Response(null, { status: 201 });
    }
    if (path.startsWith('/rest/v1/model_routes')) return json([routeRow(routeStatus)]);
    if (path.startsWith('/rest/v1/audit_events')) throw new Error('0043: the Worker never writes audit_events directly');
    if (path === '/rest/v1/rpc/apm_service_record_audit') {
      // Audits go through the service-role allow-list, with the server-only key.
      assert.equal(new Headers(init.headers).get('apikey'), baseEnv.SUPABASE_SECRET_KEY);
      db.audits.push({ user_id: body.p_user_id, event_type: body.p_event_type, actor_type: body.p_actor_type, object_type: body.p_object_type, object_id: body.p_object_id, metadata: body.p_metadata });
      return new Response(null, { status: 204 });
    }
    if (path.startsWith('/rest/v1/ai_usage_events')) return new Response(null, { status: 201 });
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { db, restore: () => { globalThis.fetch = original; } };
}

const call = (env, input) => coaching.coach({ env, accessToken: 'jwt', userId: USER, graph, plan, modeState: { mode: 'standard' }, sessionId: SESSION, ...input });

test('no approved route: coaching runs the scripted BHPC flow end to end and never calls OpenRouter', async () => {
  const h = harness({ routeStatus: 'candidate' });
  try {
    const env = { ...baseEnv, OPENROUTER_API_KEY: 'sk-or-test' };
    const steps = [];
    for (const message of ['I feel off', 'Energy', 'Skipping the long run', 'That I am losing fitness']) {
      const { reply } = await call(env, { message });
      steps.push(reply.step);
      assert.equal(reply.engine, 'scripted');
      assert.match(reply.turnId ?? '', /^[0-9a-f-]{36}$/, 'every coach reply carries its stored turn id, so it can be reported');
    }
    assert.deepEqual(steps, ['ask', 'ask', 'ask', 'synthesize']);
    assert.equal(h.db.session.phase, 'closure_offered', 'phase persists between requests');
    assert.equal(h.db.session.questions_asked, 3);

    const launch = (await call(env, { choice: 'close_and_launch' })).reply;
    assert.equal(launch.phase, 'morning_sequence');
    assert.deepEqual(launch.morningSequence, ['Fill a water bottle', 'Lace up']);
    const redirect = (await call(env, { message: 'tell me more about pacing' })).reply;
    assert.equal(redirect.step, 'redirect_to_sequence');
    const done = (await call(env, { choice: 'sequence_done' })).reply;
    assert.equal(done.phase, 'closed');
    assert.equal(h.db.session.status, 'closed');
    assert.equal(h.db.session.closure_directive, 'Run the 20-minute easy loop');
    assert.equal(h.db.openrouterCalls.length, 0, 'a candidate route is never used');
  } finally { h.restore(); }
});

test('no OpenRouter key: still scripted, still works', async () => {
  const h = harness({ routeStatus: 'approved', modelText: 'What is the one thing you are avoiding?' });
  try {
    const { reply } = await call(baseEnv, { message: 'I am stuck' });
    assert.equal(reply.engine, 'scripted');
    assert.equal(reply.prompt.text, 'What feels most stuck right now — time, energy, or confidence?');
    assert.equal(h.db.openrouterCalls.length, 0);
  } finally { h.restore(); }
});

test('approved route: a rewrite with catch-up phrasing (even negated) is guarded to the scripted turn', async () => {
  const env = { ...baseEnv, OPENROUTER_API_KEY: 'sk-or-test' };
  const h = harness({ routeStatus: 'approved', modelText: 'No pressure to catch up — what is the one move for today?' });
  try {
    const { reply } = await call(env, { message: 'I am stuck' });
    assert.equal(h.db.openrouterCalls.length, 1, 'the model was asked');
    assert.match(h.db.openrouterCalls[0].messages[0].content, /BHPC No Catch-Up/, 'the production prompt carries the rule');
    assert.equal(reply.engine, 'scripted');
    assert.equal(reply.prompt.text, 'What feels most stuck right now — time, energy, or confidence?');
    assert.doesNotMatch(JSON.stringify(reply), /catch up/i);
  } finally { h.restore(); }
});

test('approved route: a valid rewrite is used; a two-question rewrite is discarded for the scripted turn', async () => {
  const env = { ...baseEnv, OPENROUTER_API_KEY: 'sk-or-test' };
  let h = harness({ routeStatus: 'approved', modelText: 'What part of the training plan feels heaviest this week?' });
  try {
    const { reply } = await call(env, { message: 'I am stuck' });
    assert.equal(reply.engine, 'model');
    assert.equal(reply.prompt.text, 'What part of the training plan feels heaviest this week?');
    const sent = h.db.openrouterCalls[0];
    assert.equal(sent.provider.zdr, true);
    assert.equal(sent.provider.data_collection, 'deny');
    assert.equal(sent.provider.allow_fallbacks, false);
    const context = JSON.stringify(sent.messages);
    assert.match(context, /Recovery is execution/, 'active Track RULES reach the model, not just names');
    assert.doesNotMatch(context, /sb_publishable_test|sk-or-test|jwt/, 'no credentials in the prompt');
  } finally { h.restore(); }

  h = harness({ routeStatus: 'approved', modelText: 'Why now? And what is in the way?' });
  try {
    const { reply } = await call(env, { message: 'I am stuck' });
    assert.equal(reply.engine, 'scripted');
    assert.equal(reply.prompt.text, 'What feels most stuck right now — time, energy, or confidence?');
  } finally { h.restore(); }
});

test('crisis text: no model call even with an approved route, session stopped, audit has pattern ids only', async () => {
  const h = harness({ routeStatus: 'approved', modelText: 'What is next?' });
  try {
    const env = { ...baseEnv, OPENROUTER_API_KEY: 'sk-or-test' };
    const { reply } = await call(env, { message: 'honestly I want to end my life' });
    assert.equal(reply.step, 'safety_stop');
    assert.equal(reply.phase, 'safety_stop');
    // Europe/London user: no one-tap 911/988 (they would not route); a local-line directory instead.
    assert.ok(reply.safety.resources.every((r) => r.action?.kind !== 'call'), 'never offers a dial action that may not route');
    assert.ok(reply.safety.resources.some((r) => r.action?.value === 'https://findahelpline.com'));
    assert.ok(reply.safety.resources.some((r) => /112 in the EU, 999 in the UK/.test(r.detail)));
    assert.equal(h.db.openrouterCalls.length, 0);
    assert.equal(h.db.session.status, 'closed');
    assert.equal(h.db.session.phase, 'safety_stop');
    const audit = h.db.audits.find((a) => a.event_type === 'coaching.safety_stop');
    assert.deepEqual(audit.metadata, { level: 'crisis', signals: ['end_life'] });
    assert.doesNotMatch(JSON.stringify(h.db.audits), /end my life/);

    const again = (await call(env, { message: 'ok what is my agenda' })).reply;
    assert.equal(again.step, 'safety_followup', 'the stopped session never resumes coaching');
    assert.equal(h.db.openrouterCalls.length, 0);
  } finally { h.restore(); }
});
