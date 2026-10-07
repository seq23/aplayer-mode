// Deterministic BHPC coaching engine (no model anywhere in this file):
//   * the five Modes as explicit state — enter/exit, auto-exit, Sprint ≤ 14 days
//     with a mandatory recovery day, Deep Work time-boxed with one task, and
//     their effect on Today;
//   * Executive Review generated from the Life Graph alone;
//   * the coaching state machine — one question per turn, synthesis + next move,
//     the mandatory close into the Morning Sequence, the redirect, and no silent
//     states on ANY path (exhaustive walk + seeded fuzz);
//   * the not-therapy safety boundary;
//   * active Track RULES reaching coaching and the retired Tracks staying gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
let outDir;
let modes;
let machine;
let safety;
let tracks;
let review;

test.before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'apm-coach-test-'));
  await build({
    entryPoints: {
      modes: join(srcDir, 'coach/modes.ts'),
      machine: join(srcDir, 'coach/machine.ts'),
      safety: join(srcDir, 'coach/safety.ts'),
      tracks: join(srcDir, 'coach/tracks.ts'),
      review: join(srcDir, 'coach/executiveReview.ts'),
    },
    bundle: true, format: 'esm', platform: 'neutral', outdir: outDir, logLevel: 'silent',
  });
  const load = (name) => import(pathToFileURL(join(outDir, `${name}.js`)).href);
  [modes, machine, safety, tracks, review] = await Promise.all(['modes', 'machine', 'safety', 'tracks', 'review'].map(load));
});
test.after(async () => { if (outDir) await rm(outDir, { recursive: true, force: true }); });

const USER = '00000000-0000-4000-8000-00000000000a';
const TZ = 'America/Chicago';
const NOW = new Date('2026-10-06T15:00:00.000Z'); // 10:00 in Chicago
const prov = { kind: 'stated', sourceType: 'manual' };
const track = (key, active = true) => ({ id: `t-${key}`, userId: USER, key, name: key, active, foreground: false, provenance: prov });

function graph(overrides = {}) {
  return {
    identity: { userId: USER, displayName: 'Ari', timezone: TZ, becoming: 'a calm, consistent operator' },
    roles: [{ id: 'r1', userId: USER, name: 'Parenting / caregiving', active: true, provenance: prov }],
    pillarSettings: [], tracks: [], modes: [],
    personalOS: {
      userId: USER, northStar: 'A stable home and a finished thesis', values: ['presence'], nonNegotiables: ['school pickup', 'sleep by 23:00'],
      failurePatterns: ['overcommitting on Mondays'], weeklyCadence: { heavyDays: [], lightDays: [] }, coachingStyle: { firmness: 'direct' },
      accountability: { dayStart: 'guided' }, activeMode: 'standard', morningSequence: ['Drink water', 'Open the thesis file', '', '  '],
      schedulingPreference: 'ordered_stack', hardBoundaries: [], scoringConfig: { enabled: true, showSevenDaySnapshot: true },
      installedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    },
    goals: [
      { id: 'g1', userId: USER, title: 'Submit thesis chapter 3', status: 'active', health: 'on_track', priority: 1, provenance: prov },
      { id: 'g2', userId: USER, title: 'Stabilize the pickup routine', status: 'active', health: 'at_risk', priority: 2, provenance: prov },
    ],
    milestones: [],
    projects: [{ id: 'p1', userId: USER, goalId: 'g1', title: 'Chapter 3', objective: 'Submit a full draft', status: 'active', foreground: true }],
    commitments: [],
    nextActions: [
      { id: 'a1', userId: USER, projectId: 'p1', goalId: 'g1', title: 'Write the methods section outline', status: 'open' },
      { id: 'a2', userId: USER, goalId: 'g2', title: 'Text the carpool group the Thursday plan', status: 'open' },
    ],
    routines: [], people: [], lifeRelationships: [], lifeAdminItems: [], preferences: [], rules: [], radarItems: [],
    evidence: [{ id: 'e1', userId: USER, kind: 'user_completion', summary: 'Finished the literature table', sourceType: 'manual', createdAt: '2026-10-05T20:00:00.000Z' }],
    connections: [], calendarEvents: [], messageSignals: [], permissions: [], actions: [],
    dayRecords: [
      { id: 'd1', userId: USER, day: '2026-10-04', mode: 'standard', verdict: 'full_day', completedActionIds: [] },
      { id: 'd2', userId: USER, day: '2026-10-05', mode: 'recovery', verdict: 'mvd', completedActionIds: [] },
    ],
    ...overrides,
  };
}

function plan(mode = 'standard', g = graph()) {
  return {
    userId: USER, date: '2026-10-06', mode, numberOneMove: g.nextActions[0], morningSequence: g.personalOS?.morningSequence ?? [],
    blocks: [
      { id: 'action:a1', title: 'Write the methods section outline', actionId: 'a1', goalId: 'g1', source: 'methodology' },
      { id: 'cal:1', title: 'Advisor meeting', startAt: '2026-10-06T17:00:00.000Z', endAt: '2026-10-06T17:30:00.000Z', source: 'calendar' },
      { id: 'life:1', title: 'Pay the electricity bill', lifeAdminItemId: 'l1', source: 'life_os' },
      { id: 'action:a2', title: 'Text the carpool group the Thursday plan', actionId: 'a2', goalId: 'g2', source: 'methodology' },
    ],
    routineIds: [], commitmentIds: [], approvalActionIds: [], radarItemIds: [], completionState: 'not_started',
  };
}

const ctx = (over = {}) => ({ now: NOW, timezone: TZ, foregroundTitle: 'Chapter 3', ...over });
const ok = (result) => { assert.equal(result.ok, true, result.message); return result.state; };
const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const chicagoClock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

// ------------------------------------------------------------------ Modes

test('Sprint: declared 1–14 days, needs one foreground, ends at a local midnight', () => {
  const { transitionMode } = modes;
  for (const days of [0, 15, 2.5, -1]) {
    const result = transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days }, ctx());
    assert.equal(result.ok, false); assert.equal(result.error, 'invalid_sprint_duration');
  }
  const noForeground = transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 7 }, ctx({ foregroundTitle: undefined }));
  assert.equal(noForeground.error, 'sprint_needs_foreground');

  const sprint = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 14 }, ctx()));
  assert.equal(sprint.mode, 'sprint');
  assert.equal(sprint.focus, 'Chapter 3');
  assert.equal(chicagoClock(sprint.endsAt), '00:00');
  assert.ok(hours(sprint.startedAt, sprint.endsAt) <= 14 * 24 + 1, 'never longer than 14 days');
  const one = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 1 }, ctx()));
  assert.equal(modes.localDate(new Date(Date.parse(one.endsAt) - 1), TZ), '2026-10-06', 'a 1-day sprint ends tonight');
});

test('Sprint: no new modes or scope during it; Deep Work nests and resumes it', () => {
  const { transitionMode, reconcileModeState } = modes;
  const sprint = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 7 }, ctx()));
  for (const mode of ['high_pressure', 'executive_review', 'standard']) {
    const blocked = transitionMode(sprint, { action: 'enter', mode }, ctx());
    assert.equal(blocked.ok, false); assert.equal(blocked.error, 'sprint_active');
  }
  assert.equal(transitionMode(sprint, { action: 'enter', mode: 'sprint', days: 3 }, ctx()).error, 'mode_already_active');

  const block = ok(transitionMode(sprint, { action: 'enter', mode: 'deep_work', minutes: 90, focus: 'Draft the methods section' }, ctx()));
  assert.equal(block.resume.mode, 'sprint');
  const after = reconcileModeState(block, new Date(NOW.getTime() + 91 * 60_000), TZ);
  assert.equal(after.state.mode, 'sprint');
  assert.equal(after.state.endsAt, sprint.endsAt, 'the sprint keeps its declared end');
  assert.deepEqual(after.events, ['mode.auto_exited']);
});

test('Sprint: completion or end date forces a mandatory recovery day that cannot be skipped', () => {
  const { transitionMode, reconcileModeState } = modes;
  const sprint = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 3 }, ctx()));

  const declared = transitionMode(sprint, { action: 'exit' }, ctx());
  assert.deepEqual(declared.events, ['sprint.completed', 'sprint.recovery_started']);
  const recovery = declared.state;
  assert.equal(recovery.mode, 'recovery');
  assert.ok(hours(NOW.toISOString(), recovery.recoveryLockedUntil) >= 24, 'at least a full day');
  assert.equal(chicagoClock(recovery.recoveryLockedUntil), '00:00', 'ends at a local midnight');

  const midLock = new Date(NOW.getTime() + 20 * 3_600_000);
  for (const request of [{ action: 'exit' }, { action: 'enter', mode: 'standard' }, { action: 'enter', mode: 'high_pressure' }, { action: 'enter', mode: 'deep_work', minutes: 30, focus: 'Draft the abstract' }, { action: 'enter', mode: 'sprint', days: 2 }]) {
    const result = transitionMode(recovery, request, ctx({ now: midLock }));
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error, 'recovery_day_required');
  }
  assert.equal(reconcileModeState(recovery, midLock, TZ).state.mode, 'recovery');
  const resumed = reconcileModeState(recovery, new Date(Date.parse(recovery.recoveryLockedUntil) + 1000), TZ);
  assert.equal(resumed.state.mode, 'standard');
  assert.deepEqual(resumed.events, ['recovery.resumed']);

  // Auto-exit at the declared end date, observed late, still leaves a full recovery day from the END.
  const late = reconcileModeState(sprint, new Date(Date.parse(sprint.endsAt) + 3_600_000), TZ);
  assert.equal(late.state.mode, 'recovery');
  assert.equal(late.state.startedAt, sprint.endsAt);
  assert.ok(late.state.recoveryLockedUntil > sprint.endsAt);
  assert.deepEqual(late.events, ['mode.auto_exited', 'sprint.recovery_started']);
  // Entering Recovery during a sprint is a sprint end too.
  assert.equal(ok(transitionMode(sprint, { action: 'enter', mode: 'recovery' }, ctx())).recoveryLockedUntil !== undefined, true);
});

test('Deep Work: 15 min–4 h, one executable task, no nesting of a second task, auto-exit to the prior mode', () => {
  const { transitionMode, reconcileModeState } = modes;
  for (const minutes of [10, 241, 30.5]) {
    assert.equal(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'deep_work', minutes, focus: 'Draft the abstract' }, ctx()).error, 'invalid_block_duration');
  }
  for (const focus of ['', 'work on stuff', 'think about the thesis', 'x'.repeat(201)]) {
    assert.equal(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'deep_work', minutes: 60, focus }, ctx()).error, 'deep_work_needs_one_task');
  }
  const hp = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'high_pressure' }, ctx()));
  const block = ok(transitionMode(hp, { action: 'enter', mode: 'deep_work', minutes: 60, focus: 'Draft the abstract' }, ctx()));
  assert.equal(hours(block.startedAt, block.endsAt), 1);
  assert.equal(reconcileModeState(block, new Date(NOW.getTime() + 59 * 60_000), TZ).state.mode, 'deep_work');
  assert.equal(reconcileModeState(block, new Date(NOW.getTime() + 60 * 60_000), TZ).state.mode, 'high_pressure');
  assert.equal(ok(transitionMode(block, { action: 'exit' }, ctx())).mode, 'high_pressure', 'ending early returns to the prior mode');
});

test('Recovery: the user declares the return and the full agenda resumes the next local day', () => {
  const { transitionMode, reconcileModeState, MODE_LIBRARY } = modes;
  const recovery = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'recovery' }, ctx()));
  assert.equal(transitionMode(recovery, { action: 'enter', mode: 'high_pressure' }, ctx()).error, 'recovery_active');
  const declared = transitionMode(recovery, { action: 'exit' }, ctx());
  assert.deepEqual(declared.events, ['recovery.return_declared']);
  assert.equal(declared.state.mode, 'recovery', 'still recovery today');
  assert.equal(chicagoClock(declared.state.endsAt), '00:00');
  assert.equal(modes.localDate(new Date(declared.state.endsAt), TZ), '2026-10-07');
  assert.equal(reconcileModeState(declared.state, new Date(Date.parse(declared.state.endsAt) - 1), TZ).state.mode, 'recovery');
  assert.equal(reconcileModeState(declared.state, new Date(declared.state.endsAt), TZ).state.mode, 'standard');
  assert.match(MODE_LIBRARY.recovery.rules.join(' '), /No catch-up/);
});

test('High-Pressure and Executive Review: explicit, user-exited, Review returns to where it started', () => {
  const { transitionMode } = modes;
  const hp = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'high_pressure' }, ctx()));
  assert.equal(ok(transitionMode(hp, { action: 'exit' }, ctx())).mode, 'standard');
  const reviewState = ok(transitionMode(hp, { action: 'enter', mode: 'executive_review' }, ctx()));
  assert.equal(reviewState.resume.mode, 'high_pressure');
  assert.equal(ok(transitionMode(reviewState, { action: 'exit' }, ctx())).mode, 'high_pressure');
});

test('Mode effect on Today: Deep Work shows one task, Sprint holds non-foreground items, Recovery is MVD', () => {
  const { transitionMode, applyModeToPlan } = modes;
  const g = graph();
  const block = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'deep_work', minutes: 50, focus: 'Draft the abstract' }, ctx()));
  const deep = applyModeToPlan(plan(), g, block);
  assert.deepEqual(deep.plan.blocks.map((b) => b.title), ['Draft the abstract']);
  assert.equal(deep.effect.heldBlocks.length, 4, 'nothing silently deleted — held until the block ends');
  assert.equal(deep.effect.heldUntil, block.endsAt);

  const sprint = ok(transitionMode({ mode: 'standard' }, { action: 'enter', mode: 'sprint', days: 5 }, ctx()));
  const sprintPlan = applyModeToPlan(plan(), g, sprint);
  assert.deepEqual(sprintPlan.plan.blocks.map((b) => b.id), ['action:a1', 'cal:1'], 'foreground + fixed commitments only');
  assert.deepEqual(sprintPlan.effect.heldBlocks.map((b) => b.id), ['life:1', 'action:a2']);
  assert.equal(sprintPlan.plan.mode, 'sprint');

  const rec = applyModeToPlan(plan('recovery'), g, { mode: 'recovery' });
  assert.equal(rec.plan.mode, 'recovery');
  assert.match(rec.effect.summary, /Minimum Viable Day/);
  const std = applyModeToPlan(plan(), g, { mode: 'high_pressure' });
  assert.equal(std.plan.blocks.length, 4, 'High-Pressure does not change Today');
});

// ---------------------------------------------------------- Executive Review

test('Executive Review is deterministic, 3–7 items, exact lines, one directive, no questions', () => {
  const { buildExecutiveReview, EXECUTIVE_REVIEW_OPENING, EXECUTIVE_REVIEW_CLOSING } = review;
  assert.equal(EXECUTIVE_REVIEW_OPENING, 'Here’s what you already know that still makes you better:');
  assert.equal(EXECUTIVE_REVIEW_CLOSING, 'None of this is new — you’re just being reminded.');
  const g = graph({ tracks: [track('strategic_patience')] });
  const a = buildExecutiveReview(g, plan(), NOW);
  const b = buildExecutiveReview(structuredClone(g), plan(), NOW);
  assert.deepEqual(a, b, 'same Life Graph → same review');
  assert.ok(a.items.length >= 3 && a.items.length <= 7, `got ${a.items.length}`);
  const lines = a.text.split('\n');
  assert.equal(lines[0], EXECUTIVE_REVIEW_OPENING);
  assert.equal(lines.at(-2), EXECUTIVE_REVIEW_CLOSING);
  assert.match(lines.at(-1), /^Grounding directive: Write the methods section outline/);
  assert.equal(lines.filter((line) => /^\d+\. /.test(line)).length, a.items.length);
  assert.doesNotMatch(a.text, /\?/);
  assert.deepEqual(new Set(a.items.map((i) => i.area)), new Set(['priorities', 'opportunity', 'execution', 'positioning']), 'covers all four BHPC review areas');
  assert.match(a.text, /Chapter 3/); assert.match(a.text, /school pickup/); assert.match(a.text, /Strategic Patience/);

  const sparse = graph({ personalOS: undefined, goals: [], projects: [], dayRecords: [], evidence: [], identity: { userId: USER, displayName: 'Sam' }, nextActions: [] });
  const minimal = buildExecutiveReview(sparse, { ...plan(), numberOneMove: undefined }, NOW);
  assert.equal(minimal.items.length, 3, 'padded to the BHPC floor of 3 from installed laws, never invented facts');
  assert.ok(minimal.items.every((item) => item.area === 'laws'));
  assert.match(minimal.directive, /^Grounding directive: /);

  const questiony = graph({ personalOS: { ...graph().personalOS, northStar: 'Am I enough?', nonNegotiables: ['why?', 'a', 'b', 'c'], failurePatterns: ['?', 'x'] } });
  assert.doesNotMatch(buildExecutiveReview(questiony, plan(), NOW).text, /\?/, 'user text cannot smuggle a question into the review');
});

// ------------------------------------------------------- state machine

function cctx(mode = 'standard', prior = [], over = {}) {
  const g = over.graph ?? graph();
  return { mode, modeState: over.modeState ?? { mode }, graph: g, plan: over.plan ?? plan(mode === 'recovery' ? 'recovery' : 'standard', g), now: NOW, priorUserMessages: prior };
}
const fresh = () => ({ phase: 'exploring', questionsAsked: 0, deeperRounds: 0 });
const qm = (s) => (s.match(/\?/g) ?? []).length;

function run(mode, inputs, over = {}) {
  let state = fresh();
  const prior = [];
  const turns = [];
  for (const input of inputs) {
    const turn = machine.decideTurn(state, input, cctx(mode, [...prior], over));
    machine.assertCoachTurnContract(turn);
    if (input.message?.trim()) prior.push(input.message.trim());
    turns.push(turn);
    state = turn.session;
  }
  return turns;
}

test('Standard coaching: one question per turn, then synthesis + next move + the BHPC closure choice', () => {
  const turns = run('standard', [
    { message: 'I feel stuck and behind.' },
    { message: 'Confidence. I keep second-guessing.' },
    { message: 'Whether to push the project or pause it.' },
    { message: 'That I am not cut out for this.' },
  ]);
  assert.deepEqual(turns.map((t) => t.step), ['ask', 'ask', 'ask', 'synthesize']);
  assert.equal(turns[0].prompt.text, 'What feels most stuck right now — time, energy, or confidence?');
  for (const t of turns.slice(0, 3)) {
    assert.equal(t.prompt.kind, 'question'); assert.equal(qm(t.prompt.text), 1); assert.equal(qm(t.reply), 0);
    assert.equal(t.modelSlot, 'question');
  }
  const synthesis = turns[3];
  assert.equal(synthesis.session.phase, 'closure_offered');
  assert.equal(qm(synthesis.reply), 0, 'synthesis asks nothing');
  assert.match(synthesis.reply, /Confidence\. I keep second-guessing\./);
  assert.match(synthesis.reply, /Here’s the move: Write the methods section outline\./);
  assert.equal(synthesis.nextMove, 'Write the methods section outline');
  assert.equal(synthesis.prompt.text, 'Would you like to close coaching and begin your Morning Sequence, or go deeper?');
  assert.deepEqual(synthesis.prompt.options.map((o) => o.id), ['close_and_launch', 'go_deeper']);
});

test('Closure: the Morning Sequence launches, chatting is redirected, "done" closes back into execution', () => {
  const turns = run('standard', [
    { message: 'I feel off.' }, { message: 'Energy.' }, { message: 'The email to my advisor.' }, { message: 'That I am late.' },
    { choice: 'close_and_launch' },
    { message: 'Actually can we talk about my week more' },
    { message: 'done' },
  ]);
  const [launch, redirect, done] = turns.slice(4);
  assert.equal(launch.step, 'launch_sequence');
  assert.deepEqual(launch.morningSequence, ['Drink water', 'Open the thesis file'], 'the user’s own steps, blanks removed, max 5');
  assert.equal(launch.prompt.text, 'Tell me when you’re done.');
  assert.equal(launch.prompt.kind, 'confirm');
  assert.equal(redirect.step, 'redirect_to_sequence');
  assert.match(redirect.reply, /^Let’s run your Morning Sequence first\. I’ll be here after you complete it\./);
  assert.equal(redirect.session.phase, 'morning_sequence');
  assert.equal(done.step, 'sequence_complete');
  assert.equal(done.session.phase, 'closed');
  assert.equal(done.closeSession, true);
  assert.match(done.reply, /Write the methods section outline/);

  const empty = graph({ personalOS: { ...graph().personalOS, morningSequence: [] } });
  const fallback = run('standard', [{ message: 'x1' }, { message: 'x2' }, { message: 'x3' }, { message: 'x4' }, { choice: 'close_and_launch' }], { graph: empty });
  assert.deepEqual(fallback.at(-1).morningSequence, machine.DEFAULT_MORNING_SEQUENCE);
});

test('Go deeper adds exactly one question per round and is capped', () => {
  const turns = run('standard', [
    { message: 'a' }, { message: 'b' }, { message: 'c' }, { message: 'd' },
    { choice: 'go_deeper' }, { message: 'e' },
    { choice: 'go_deeper' }, { message: 'f' },
  ]);
  assert.deepEqual(turns.map((t) => t.step), ['ask', 'ask', 'ask', 'synthesize', 'ask', 'synthesize', 'ask', 'synthesize']);
  assert.equal(turns[4].prompt.text, machine.QUESTION_BANK.standard.deeper[0]);
  assert.equal(turns[6].prompt.text, machine.QUESTION_BANK.standard.deeper[1]);
  assert.deepEqual(turns.at(-1).prompt.options.map((o) => o.id), ['close_and_launch'], 'no third deeper round');
  const capped = machine.decideTurn(turns.at(-1).session, { choice: 'go_deeper' }, cctx('standard', ['a', 'b', 'c', 'd', 'e', 'f']));
  assert.equal(capped.step, 'offer_closure');
});

test('Mode-specific coaching: High-Pressure numbered list + one stabilizing directive; Recovery and Sprint are brief', () => {
  const hp = run('high_pressure', [{ message: 'I keep stalling.' }, { message: 'Calling the landlord.' }, { message: 'Another late fee.' }]);
  assert.deepEqual(hp.map((t) => t.step), ['ask', 'ask', 'synthesize']);
  assert.match(hp[2].reply, /^1\. /m);
  assert.equal((hp[2].reply.match(/Stabilizing directive:/g) ?? []).length, 1);
  assert.doesNotMatch(hp[2].reply, /it’s okay|don’t worry|no pressure/i, 'no comfort language');

  const rec = run('recovery', [{ message: 'Exhausted.' }, { message: 'Everything.' }, { message: 'A walk.' }]);
  assert.deepEqual(rec.map((t) => t.step), ['ask', 'ask', 'synthesize']);
  assert.match(rec[2].reply, /No catch-up and no evaluation today/);

  const sprint = run('sprint', [{ message: 'Deadline Friday.' }, { message: 'The full draft.' }]);
  assert.deepEqual(sprint.map((t) => t.step), ['ask', 'synthesize']);
  assert.match(sprint[1].reply, /one foreground output only/);
});

test('Executive Review mode coaching asks nothing and is the deterministic review', () => {
  const [turn] = run('executive_review', [{}]);
  assert.equal(turn.step, 'executive_review');
  assert.equal(qm(turn.reply), 0);
  assert.equal(turn.modelSlot, undefined, 'never sent to a model');
  assert.equal(turn.prompt.text, machine.CLOSURE_QUESTION);
  const done = run('executive_review', [{}, { choice: 'close_and_launch' }, { choice: 'sequence_done' }]).at(-1);
  assert.deepEqual(done.modeRequest, { action: 'exit' }, 'the review ends with its session');
});

test('Deep Work: no coaching during the block; ending early is an explicit choice', () => {
  const modeState = { mode: 'deep_work', startedAt: NOW.toISOString(), endsAt: new Date(NOW.getTime() + 3_600_000).toISOString(), focus: 'Draft the abstract', resume: { mode: 'standard' } };
  const [held] = run('deep_work', [{ message: 'quick question about my week' }], { modeState });
  assert.equal(held.step, 'deferred_deep_work');
  assert.match(held.reply, /Draft the abstract/);
  assert.match(held.reply, /11:00 AM/, 'block end shown in the user’s timezone');
  assert.deepEqual(held.prompt.options.map((o) => o.id), ['stay_in_block', 'end_block_early']);
  const [ended] = run('deep_work', [{ choice: 'end_block_early' }], { modeState });
  assert.deepEqual(ended.modeRequest, { action: 'exit' });
  assert.equal(ended.prompt.kind, 'question');
});

test('Safety boundary: crisis language stops coaching and shows resources, in every mode and phase', () => {
  const crisisPhrases = ['I want to kill myself', 'sometimes I think about suicide', 'I want to end my life', 'everyone would be better off without me', 'I have been cutting myself', 'my partner hits me'];
  for (const mode of ['standard', 'high_pressure', 'recovery', 'sprint', 'executive_review', 'deep_work']) {
    for (const phrase of crisisPhrases) {
      const modeState = mode === 'deep_work' ? { mode, endsAt: new Date(NOW.getTime() + 3_600_000).toISOString(), focus: 'Draft the abstract' } : { mode };
      const turn = machine.decideTurn(fresh(), { message: phrase }, cctx(mode, [], { modeState }));
      machine.assertCoachTurnContract(turn);
      assert.equal(turn.step, 'safety_stop', `${mode}: ${phrase}`);
      assert.equal(turn.session.phase, 'safety_stop');
      assert.equal(turn.closeSession, true);
      assert.ok(turn.safety.resources.some((r) => r.action?.value === '988'));
      assert.equal(turn.modelSlot, undefined, 'crisis text never goes to a model');
      assert.equal(turn.nextMove, undefined, 'no productivity push in a crisis');
    }
  }
  // Mid-flow: the boundary still wins over closure and the Morning Sequence.
  for (const phase of ['closure_offered', 'morning_sequence']) {
    const turn = machine.decideTurn({ phase, questionsAsked: 3, deeperRounds: 0 }, { message: 'I don’t want to live anymore' }, cctx());
    assert.equal(turn.step, 'safety_stop', phase);
  }
  // A stopped session never resumes coaching, whatever is sent.
  const stopped = { phase: 'safety_stop', questionsAsked: 0, deeperRounds: 0 };
  for (const input of [{ message: 'ok can we do my agenda' }, { choice: 'close_and_launch' }, { choice: 'go_deeper' }, { choice: 'need_help_now' }, { choice: 'im_safe' }, {}]) {
    const turn = machine.decideTurn(stopped, input, cctx());
    machine.assertCoachTurnContract(turn);
    assert.equal(turn.step, 'safety_followup', JSON.stringify(input));
    assert.equal(turn.session.phase, 'safety_stop');
    assert.equal(turn.modelSlot, undefined);
  }
});

test('Safety boundary: medical red flags refer out; therapy-scope gets a boundary note; idioms are not crises', () => {
  const medical = machine.decideTurn(fresh(), { message: 'I had chest pain on my run this morning' }, cctx());
  assert.equal(medical.step, 'safety_stop');
  assert.equal(medical.safety.level, 'medical');
  assert.ok(medical.safety.resources.some((r) => /clinician/i.test(r.label)));

  const scope = run('standard', [{ message: 'I think this is about my childhood trauma' }])[0];
  assert.equal(scope.step, 'ask', 'coaching continues');
  assert.equal(scope.boundaryNote, safety.THERAPY_SCOPE_NOTE);
  assert.match(scope.reply, /isn’t therapy/);
  assert.equal(qm(scope.reply), 0);

  for (const idiom of ['this deadline is killing me', 'I could kill for a coffee', 'my boss will murder me if this slips', 'I am dying to ship this']) {
    assert.equal(safety.assessSafety(idiom).level, 'none', idiom);
  }
  assert.deepEqual(safety.assessSafety('I want to die').signals, ['want_to_die'], 'signals are pattern ids, never the user’s words');
});

test('No silent states: exhaustive and fuzzed walks — every turn ends in a question, choice or confirmation', () => {
  const allModes = ['standard', 'high_pressure', 'recovery', 'sprint', 'executive_review', 'deep_work'];
  const inputs = [
    {}, { message: 'I feel stuck' }, { message: 'yes' }, { message: 'go deeper' }, { message: 'done' }, { message: 'what?? why??' },
    { message: 'I want to pivot and quit this' }, { message: 'trauma' }, ...machine.COACH_CHOICES.map((choice) => ({ choice })),
  ];
  const phases = ['exploring', 'closure_offered', 'morning_sequence', 'closed', 'safety_stop'];
  let count = 0;
  for (const mode of allModes) {
    const modeState = mode === 'deep_work' ? { mode, endsAt: new Date(NOW.getTime() + 3_600_000).toISOString(), focus: 'Draft the abstract' } : { mode };
    for (const phase of phases) {
      for (const asked of [0, 1, 3, 5]) {
        for (const deeper of [0, 1, 2]) {
          for (const input of inputs) {
            const turn = machine.decideTurn({ phase, questionsAsked: asked, deeperRounds: deeper }, input, cctx(mode, ['first', 'second'], { modeState }));
            machine.assertCoachTurnContract(turn);
            count += 1;
          }
        }
      }
    }
  }
  assert.ok(count > 5000, `walked ${count} turns`);

  // Seeded fuzz over whole sessions.
  let seed = 23;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let session = 0; session < 300; session += 1) {
    const mode = allModes[rand(allModes.length)];
    const modeState = mode === 'deep_work' ? { mode, endsAt: new Date(NOW.getTime() + 3_600_000).toISOString(), focus: 'Draft the abstract' } : { mode };
    let state = fresh();
    const prior = [];
    for (let step = 0; step < 12; step += 1) {
      const input = inputs[rand(inputs.length)];
      const turn = machine.decideTurn(state, input, cctx(mode, prior, { modeState }));
      machine.assertCoachTurnContract(turn);
      if (input.message) prior.push(input.message);
      state = turn.session;
    }
  }
});

test('Turn contract rejects silent endings and double questions', () => {
  const { assertCoachTurnContract } = machine;
  assert.throws(() => assertCoachTurnContract({ reply: 'Here is the plan.', prompt: { kind: 'question', text: '', options: [] } }), /silent_state/);
  assert.throws(() => assertCoachTurnContract({ reply: 'Here is the plan.', prompt: { kind: 'question', text: 'Good luck.', options: [] } }), /silent_state/);
  assert.throws(() => assertCoachTurnContract({ reply: 'x', prompt: { kind: 'confirm', text: 'Tell me.', options: [] } }), /silent_state/);
  assert.throws(() => assertCoachTurnContract({ reply: 'Why now?', prompt: { kind: 'question', text: 'And what next?', options: [] } }), /one_question/);
  assert.equal(machine.isValidModelQuestion('What matters most? And why?'), false);
  assert.equal(machine.isValidModelQuestion('Tell me more.'), false);
  assert.equal(machine.isValidModelQuestion('What is the one move you are avoiding?'), true);
  assert.equal(machine.isValidModelSynthesis('You named the friction. Next move: call the landlord at 9.', 'standard'), true);
  assert.equal(machine.isValidModelSynthesis('You named the friction. Ready to move?', 'standard'), false);
  assert.equal(machine.isValidModelSynthesis('You named the friction clearly and the next move is obvious.', 'high_pressure'), false, 'High-Pressure requires a numbered list');
});

// ------------------------------------------------------------------ Tracks

test('Track library: the 4 BHPC + 3 app Tracks with rules; retired Tracks are not installable', () => {
  const { ACTIVE_TRACK_KEYS, RETIRED_TRACK_KEYS, TRACK_LIBRARY } = tracks;
  assert.deepEqual([...ACTIVE_TRACK_KEYS], ['billionaire_mindset', 'operator_discipline', 'strategic_patience', 'resilience', 'body_foundation', 'wealth_foundation', 'home_front']);
  assert.deepEqual(Object.keys(TRACK_LIBRARY).sort(), [...ACTIVE_TRACK_KEYS].sort());
  for (const key of RETIRED_TRACK_KEYS) assert.equal(TRACK_LIBRARY[key], undefined);
  for (const def of Object.values(TRACK_LIBRARY)) {
    assert.ok(def.rules.length >= 5, `${def.key} carries its rules`);
    assert.ok(def.mustChallenge.length >= 3 && def.filters.length >= 1 && def.triggers.length >= 1);
    assert.doesNotMatch(def.challenge, /\?/, 'challenge lines are statements, keeping one question per turn');
  }
  assert.equal(TRACK_LIBRARY.billionaire_mindset.origin, 'bhpc');
  assert.equal(TRACK_LIBRARY.home_front.origin, 'app');
  assert.match(TRACK_LIBRARY.body_foundation.rules.join(' '), /0\.9 kg/);
  assert.match(TRACK_LIBRARY.wealth_foundation.precedence, /takes precedence over Billionaire Mindset/);
});

test('Active Track RULES reach coaching and are enforced in the scripted flow; inactive and retired ones are not', () => {
  const installed = [track('strategic_patience'), track('wealth_foundation'), track('home_front', false), track('manifestation_mastery')];
  const context = tracks.trackRulesForCoaching(installed);
  assert.deepEqual(context.map((t) => t.name), ['Strategic Patience', 'Wealth Foundation']);
  assert.ok(context[0].rules.includes('No pivot before the evaluation gate.'));
  assert.ok(context[1].filters.includes('If this goes to zero, is my buffer intact?'));

  const g = graph({ tracks: installed });
  const turns = run('standard', [{ message: 'I want to pivot.' }, { message: 'Confidence' }, { message: 'Put savings into crypto' }, { message: 'that I am behind' }], { graph: g });
  const synthesis = turns.at(-1);
  assert.equal(synthesis.step, 'synthesize');
  assert.equal(synthesis.trackChallenges.length, 2);
  assert.match(synthesis.reply, /Strategic Patience is active: no pivot before the evaluation gate/);
  assert.match(synthesis.reply, /Wealth Foundation is active: buffer before bets/);
  assert.doesNotMatch(synthesis.reply, /Home Front/, 'inactive Track has no effect');
  assert.equal(qm(synthesis.reply), 0);
});
