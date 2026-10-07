import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_PRESCRIPTION_PATTERN,
  BODY_SHAME_PATTERN,
  SECURITIES_PATTERN,
  actionAmbiguityProblem,
  applyPlanRefinement,
  decideAtDay90,
  generateGoalPlan,
  recognizePersona,
  reviewPlanGate,
  supplyDailyActions,
  validatePlan,
  weeklyRateCeiling,
} from '../.test-dist/index.js';

const START = '2026-10-05'; // a Monday
const ctx = (extra = {}) => ({ roles: [], startDate: START, timezone: 'America/Chicago', ...extra });

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const PERSONA_CASES = [
  { goal: 'lose 30 lbs', roles: [], key: 'weight_loss', fg: 'weight_loss' },
  { goal: 'Build a 3-month emergency fund and pay off my credit card', roles: [], key: 'wealth_building', fg: 'wealth_building' },
  { goal: 'Get my first 10 paying customers', roles: ['Building a business'], key: 'founder', fg: 'founder' },
  { goal: 'Get promoted to senior engineer by the next review cycle', roles: ['Career / professional'], key: 'operator_promotion', fg: 'operator_promotion' },
  { goal: 'Launch my business and reach $5k MRR', roles: ['Parenting / caregiving', 'Building a business'], key: 'parent_plus', fg: 'founder' },
  { goal: 'Get promoted to director this year', roles: ['Parenting / caregiving'], key: 'parent_plus', fg: 'operator_promotion' },
  { goal: 'Run a half marathon in March', roles: ['Training / competing'], key: 'generic', fg: 'generic', kind: 'race' },
  { goal: 'Pass the CPA exam', roles: ['Studying / learning'], key: 'generic', fg: 'generic', kind: 'exam' },
  { goal: 'Release my debut EP', roles: ['Creating / publishing'], key: 'generic', fg: 'generic', kind: 'creative_release' },
  { goal: 'Learn to speak conversational Italian', roles: [], key: 'generic', fg: 'generic', kind: 'other' },
];

function allActionText(plan) {
  return Object.values(plan.actions).flatMap((a) => [a.title, a.output, a.mvd.title, a.mvd.output]);
}

function suppliedActions(supply) {
  return [supply.foreground, ...supply.floors];
}

test('recognises every persona from free text and roles', () => {
  for (const c of PERSONA_CASES) {
    const match = recognizePersona(c.goal, c.roles);
    assert.equal(match.key, c.key, c.goal);
    assert.equal(match.foregroundPersona, c.fg, c.goal);
    if (c.kind) assert.equal(match.genericKind, c.kind, c.goal);
    assert.ok(match.matchedBy.length > 0);
  }
});

test('every persona plan is structurally valid with three gates, milestones, cadence and a day-90 decision', () => {
  for (const c of PERSONA_CASES) {
    const plan = generateGoalPlan(c.goal, ctx({ roles: c.roles }));
    assert.deepEqual(validatePlan(plan), [], c.goal);
    assert.deepEqual(plan.gates.map((g) => g.label), ['Foundation', 'Build', 'Establish']);
    assert.deepEqual(plan.gates.map((g) => [g.startDay, g.endDay]), [[1, 30], [31, 60], [61, 90]]);
    for (const gate of plan.gates) {
      assert.ok(gate.outcome.length > 20, `${c.goal} ${gate.key} outcome`);
      assert.ok(gate.milestones.length >= 1);
      assert.equal(gate.weeklyCadence.length, 7);
    }
    assert.equal(plan.decision.day, 90);
    assert.equal(plan.decision.date, addDays(START, 89));
    assert.deepEqual(plan.decision.options, ['promote', 'maintain', 'park']);
    assert.equal(plan.provenance.source, 'deterministic_template');
  }
});

test('generation is deterministic', () => {
  for (const c of PERSONA_CASES) {
    assert.deepEqual(generateGoalPlan(c.goal, ctx({ roles: c.roles })), generateGoalPlan(c.goal, ctx({ roles: c.roles })));
  }
});

test('Ambiguity Stop: every action the supplier can return, every day, every state, has a physical action, output and duration', () => {
  const states = [
    { state: 'normal' },
    { state: 'recovery' },
    { state: 'missed_yesterday' },
    { state: 'normal', mood: 1 },
  ];
  for (const c of PERSONA_CASES) {
    const plan = generateGoalPlan(c.goal, ctx({ roles: c.roles }));
    for (let day = -2; day <= 100; day += 1) {
      const date = addDays(START, day);
      for (const s of states) {
        const supply = supplyDailyActions(plan, { date, ...s });
        assert.ok(supply.foreground, `${c.goal} ${date} has a foreground`);
        assert.equal(supply.foreground.role, 'foreground');
        assert.equal(supply.floors.filter((f) => f.role === 'foreground').length, 0, 'one foreground only');
        for (const action of suppliedActions(supply)) {
          assert.equal(actionAmbiguityProblem(action), null, `${c.goal} ${date} ${action.title}`);
          if (action.scope === 'mvd') assert.ok(action.durationMinutes <= 15, `${action.title} MVD ≤ 15 min`);
        }
      }
    }
  }
});

test('the vague-action patterns fail the Ambiguity Stop', () => {
  assert.notEqual(actionAmbiguityProblem({ title: 'Work on the business', output: 'One sent message', durationMinutes: 10 }), null);
  assert.notEqual(actionAmbiguityProblem({ title: 'Send the offer', output: 'done', durationMinutes: 10 }), null);
  assert.notEqual(actionAmbiguityProblem({ title: 'Send the offer', output: 'Offer sent to one prospect', durationMinutes: 0 }), null);
  assert.notEqual(actionAmbiguityProblem({ title: 'Walk {m} minutes', output: 'Walk logged', durationMinutes: 10 }), null);
});

test('weight loss: behavioural only, covering movement, meals, sleep, weigh-in cadence and environment', () => {
  const plan = generateGoalPlan('lose 30 lbs', ctx());
  const text = allActionText(plan).join(' | ');
  for (const theme of [/walk/i, /meals?/i, /sleep|lights-out/i, /weigh in/i, /water bottle|trigger snack/i]) {
    assert.match(text, theme);
  }
  for (const line of allActionText(plan)) {
    assert.doesNotMatch(line, BODY_PRESCRIPTION_PATTERN, line);
    assert.doesNotMatch(line, BODY_SHAME_PATTERN, line);
  }
  for (const gate of plan.gates) assert.doesNotMatch(gate.outcome, BODY_PRESCRIPTION_PATTERN);
  assert.match(plan.safety.doctorLine, /doctor/);
  assert.ok(plan.safety.reasonCodes.includes('body.no_prescription'));
});

test('weight loss: a body behaviour is on Today every day, in every state', () => {
  const plan = generateGoalPlan('lose 30 lbs', ctx());
  for (let day = 0; day < 90; day += 1) {
    for (const state of ['normal', 'recovery', 'missed_yesterday']) {
      const supply = supplyDailyActions(plan, { date: addDays(START, day), state });
      const body = suppliedActions(supply).filter((a) => a.pillar === 'body');
      assert.ok(body.length >= 1, `day ${day + 1} ${state}`);
      const movement = suppliedActions(supply).some((a) => /walk|squats|strength/i.test(a.title));
      assert.ok(movement, `movement floor on day ${day + 1} ${state}`);
    }
  }
});

test('weight loss: pace ceiling is ≤1% bodyweight per week and never above 2 lb', () => {
  assert.equal(weeklyRateCeiling('lb', 150), 1.5);
  assert.equal(weeklyRateCeiling('lb', 300), 2);
  assert.equal(weeklyRateCeiling('lb'), 1);
  assert.equal(weeklyRateCeiling('kg', 70, 'kg'), 0.7);
  assert.equal(weeklyRateCeiling('kg', 140, 'kg'), 0.9);

  const unverified = generateGoalPlan('lose 30 lbs', ctx());
  assert.deepEqual(unverified.safety.weeklyRateCeiling, { amount: 1, unit: 'lb' });
  assert.equal(unverified.safety.safePaceDate, addDays(START, 30 * 7));
  assert.ok(unverified.safety.reasonCodes.includes('body.pace_unverified'));

  const fast = generateGoalPlan('lose 30 lbs', ctx({ targetDate: addDays(START, 56), body: { currentWeight: 220, unit: 'lb' } }));
  assert.ok(fast.safety.reasonCodes.includes('body.rate_ceiling'));
  assert.deepEqual(fast.safety.weeklyRateCeiling, { amount: 2, unit: 'lb' });
  assert.equal(fast.safety.safePaceDate, addDays(START, 15 * 7));
  assert.match(fast.gates[2].outcome, /at most 25\.7 lb over 90 days/);

  const supervised = generateGoalPlan('lose 30 lbs', ctx({ targetDate: addDays(START, 56), body: { currentWeight: 220, clinicianSupervised: true } }));
  assert.ok(!supervised.safety.reasonCodes.includes('body.rate_ceiling'));

  const slow = generateGoalPlan('lose 10 lbs', ctx({ targetDate: addDays(START, 90), body: { currentWeight: 180 } }));
  assert.ok(!slow.safety.reasonCodes.includes('body.rate_ceiling'));
});

test('weight loss: a red flag refers to a doctor and stops body coaching until clearance', () => {
  for (const note of ['I have chest pain when I walk', 'pregnant', 'I eat 800 calories a day', 'history of an eating disorder', 'I fainted last week']) {
    const plan = generateGoalPlan('lose 30 lbs', ctx({ body: { healthNotes: [note] } }));
    assert.equal(plan.safety.referral, true, note);
    assert.ok(plan.safety.reasonCodes.includes('body.referral'));
    assert.deepEqual(validatePlan(plan), []);
    for (let day = 0; day < 95; day += 7) {
      const supply = supplyDailyActions(plan, { date: addDays(START, day), state: 'normal' });
      if (supply.phase !== 'decision') assert.match(supply.foreground.title, /doctor|clinic|appointment/i, note);
      assert.ok(supply.reasons.includes('referral'));
    }
    const refined = applyPlanRefinement(plan, { source: 'llm', actions: [{ key: 'confirm_clinician', title: 'Walk 30 minutes' }] });
    assert.equal(refined.applied.length, 0);
  }
  const cleared = generateGoalPlan('lose 30 lbs', ctx({ body: { healthNotes: ['pregnant'], clinicianCleared: true } }));
  assert.equal(cleared.safety.referral, false);
  const plain = generateGoalPlan('lose 30 lbs', ctx({ body: { healthNotes: ['I eat about 1800 calories'] } }));
  assert.equal(plain.safety.referral, false);
});

test('wealth: emergency fund, debt order, automatic investing cadence, income growth, and no securities advice', () => {
  const plan = generateGoalPlan('Build a 3-month emergency fund and pay off my credit card', ctx());
  const text = allActionText(plan).join(' | ');
  for (const theme of [/emergency fund/i, /payoff order/i, /automatic monthly contribution/i, /income|raise|rate increase/i]) {
    assert.match(text, theme);
  }
  for (const line of [...allActionText(plan), ...plan.gates.map((g) => g.outcome)]) assert.doesNotMatch(line, SECURITIES_PATTERN, line);
  assert.ok(plan.safety.reasonCodes.includes('wealth.no_product_advice'));
  assert.ok(!plan.safety.reasonCodes.includes('wealth.buffer_gate'));

  const spec = generateGoalPlan('Grow my net worth with crypto and stocks', ctx());
  assert.equal(spec.persona.key, 'wealth_building');
  assert.ok(spec.safety.reasonCodes.includes('wealth.buffer_gate'));
  for (const line of allActionText(spec)) assert.doesNotMatch(line, SECURITIES_PATTERN, line);
});

test('no plan of any persona contains diet, medication or securities language', () => {
  for (const c of PERSONA_CASES) {
    const plan = generateGoalPlan(c.goal, ctx({ roles: c.roles }));
    for (const line of allActionText(plan)) {
      assert.doesNotMatch(line, BODY_PRESCRIPTION_PATTERN, `${c.goal}: ${line}`);
      assert.doesNotMatch(line, SECURITIES_PATTERN, `${c.goal}: ${line}`);
    }
  }
});

test('founder: customer/revenue foreground and the MVD is one decisive follow-up', () => {
  const plan = generateGoalPlan('Get my first 10 paying customers', ctx({ roles: ['Building a business'] }));
  assert.match(plan.foreground.label, /customers/i);
  assert.match(plan.gates[0].outcome, /customer conversations/);
  const supply = supplyDailyActions(plan, { date: addDays(START, 10), state: 'recovery' });
  assert.equal(supply.foreground.scope, 'mvd');
  assert.match(supply.foreground.title, /one decisive follow-up/);
});

test('operator: promotion deliverable, visibility and manager 1:1s', () => {
  const plan = generateGoalPlan('Get promoted to senior engineer by the next review cycle', ctx({ roles: ['Career / professional'] }));
  const text = allActionText(plan).join(' | ');
  assert.match(text, /promotion deliverable/);
  assert.match(text, /progress update/);
  assert.match(text, /1:1/);
  const keys = new Set(plan.gates.flatMap((g) => g.weeklyCadence.map((s) => s.actionKey)));
  assert.ok(keys.has('one_on_one') && keys.has('visibility') && keys.has('deliverable'));
});

test('parent+: family floor protected every day while the second game keeps the foreground', () => {
  const plan = generateGoalPlan('Launch my business and reach $5k MRR', ctx({ roles: ['Parenting / caregiving'] }));
  assert.ok(plan.safety.reasonCodes.includes('home.floor_protected'));
  assert.equal(plan.foreground.pillar, 'execution');
  for (let day = 0; day < 90; day += 1) {
    for (const state of ['normal', 'recovery', 'missed_yesterday']) {
      const supply = supplyDailyActions(plan, { date: addDays(START, day), state });
      const touchpoints = suppliedActions(supply).filter((a) => a.actionKey === 'family_floor');
      assert.equal(touchpoints.length, 1, `exactly one protected family touchpoint day ${day + 1} ${state}`);
      assert.equal(suppliedActions(supply).filter((a) => a.role === 'foreground').length, 1);
    }
  }
  const wednesday = supplyDailyActions(plan, { date: addDays(START, 9), state: 'normal' });
  assert.equal(wednesday.foreground.pillar, 'execution');
  assert.equal(wednesday.floors[0].actionKey, 'family_floor');
  assert.ok(wednesday.reasons.includes('floor_protected'));
  const recovery = supplyDailyActions(plan, { date: addDays(START, 9), state: 'recovery' });
  assert.match(recovery.foreground.title, /decisive follow-up/);
  assert.equal(recovery.floors[0].scope, 'mvd');
});

test('generic fallback: race, exam, creative release and anything else get a usable plan', () => {
  const other = generateGoalPlan('Learn to speak conversational Italian', ctx());
  assert.equal(other.provenance.templateKey, 'generic.other');
  assert.match(other.actions.setup_finish.title, /Learn to speak conversational Italian/);
  const day1 = supplyDailyActions(other, { date: START, state: 'normal' });
  assert.equal(day1.foreground.actionKey, 'setup_finish');
  assert.equal(generateGoalPlan('Run a half marathon in March', ctx()).provenance.templateKey, 'generic.race');
  assert.equal(generateGoalPlan('Pass the CPA exam', ctx()).provenance.templateKey, 'generic.exam');
  assert.equal(generateGoalPlan('Release my debut EP', ctx()).provenance.templateKey, 'generic.creative_release');
  assert.match(generateGoalPlan('Run a half marathon in March', ctx()).safety.doctorLine, /doctor/);
  const odd = generateGoalPlan('xyz', ctx());
  assert.deepEqual(validatePlan(odd), []);
});

test('missed day: Never Miss Twice gives recovery scope and No Catch-Up never stacks yesterday', () => {
  const plan = generateGoalPlan('Get my first 10 paying customers', ctx({ roles: ['Building a business'] }));
  const yesterday = addDays(START, 7);
  const today = addDays(START, 8);
  const missed = supplyDailyActions(plan, { date: yesterday, state: 'normal' });
  const supply = supplyDailyActions(plan, { date: today, state: 'missed_yesterday' });
  assert.equal(supply.mode, 'recovery');
  assert.equal(supply.foreground.scope, 'mvd');
  assert.ok(supply.reasons.includes('never_miss_twice'));
  assert.ok(supply.reasons.includes('no_catch_up'));
  assert.equal(suppliedActions(supply).length, 1);
  for (const action of suppliedActions(supply)) {
    assert.ok(action.instanceId.includes(today));
    assert.ok(!action.instanceId.includes(yesterday));
  }
  assert.notEqual(supply.foreground.instanceId, missed.foreground.instanceId);
  const normal = supplyDailyActions(plan, { date: today, state: 'normal' });
  assert.ok(supply.foreground.durationMinutes <= normal.foreground.durationMinutes);
});

test('MVD when mood ≤ 2 or in recovery; standard scope otherwise', () => {
  const plan = generateGoalPlan('Pass the CPA exam', ctx());
  const date = addDays(START, 5);
  assert.equal(supplyDailyActions(plan, { date, state: 'normal', mood: 2 }).foreground.scope, 'mvd');
  assert.ok(supplyDailyActions(plan, { date, state: 'normal', mood: 2 }).reasons.includes('low_mood_mvd'));
  assert.equal(supplyDailyActions(plan, { date, state: 'recovery' }).foreground.scope, 'mvd');
  assert.equal(supplyDailyActions(plan, { date, state: 'normal', mood: 3 }).foreground.scope, 'standard');
  assert.equal(supplyDailyActions(plan, { date, state: 'normal' }).mode, 'standard');
});

test('completed evidence marks the action done without adding more work', () => {
  const plan = generateGoalPlan('lose 30 lbs', ctx());
  const date = addDays(START, 4);
  const before = supplyDailyActions(plan, { date, state: 'normal' });
  const completed = suppliedActions(before).map((a) => ({ date, instanceId: a.instanceId }));
  const after = supplyDailyActions(plan, { date, state: 'normal', completed });
  assert.equal(after.dayComplete, true);
  assert.equal(after.foreground.status, 'done');
  assert.equal(suppliedActions(after).length, suppliedActions(before).length);
  const byKey = supplyDailyActions(plan, { date, state: 'normal', completed: [{ date, actionKey: before.foreground.actionKey }] });
  assert.equal(byKey.foreground.status, 'done');
});

test('Today never runs dry: before start, at day 90 and after the plan', () => {
  const plan = generateGoalPlan('Release my debut EP', ctx());
  const pre = supplyDailyActions(plan, { date: addDays(START, -3), state: 'normal' });
  assert.equal(pre.phase, 'pre_start');
  const day90 = supplyDailyActions(plan, { date: plan.decision.date, state: 'normal' });
  assert.equal(day90.phase, 'decision');
  assert.match(day90.foreground.title, /Promote, Maintain or Park/);
  const pending = supplyDailyActions(plan, { date: addDays(START, 100), state: 'normal' });
  assert.equal(pending.phase, 'decision');
  const promoted = supplyDailyActions(plan, { date: addDays(START, 100), state: 'normal', decision: 'promote' });
  assert.equal(promoted.phase, 'post_plan');
  assert.equal(promoted.foreground.scope, 'standard');
  const maintained = supplyDailyActions(plan, { date: addDays(START, 100), state: 'normal', decision: 'maintain' });
  assert.equal(maintained.foreground.scope, 'mvd');
  const parked = supplyDailyActions(plan, { date: addDays(START, 100), state: 'normal', decision: 'park' });
  assert.ok(parked.reasons.includes('parked_background'));
  assert.equal(parked.foreground.scope, 'mvd');
});

test('day-90 and gate reviews return Promote, Maintain or Park', () => {
  const plan = generateGoalPlan('Get my first 10 paying customers', ctx());
  assert.equal(decideAtDay90(plan, { completedDays: 80, evidenceCount: 12, stillAligned: true }), 'promote');
  assert.equal(decideAtDay90(plan, { completedDays: 40, evidenceCount: 3, stillAligned: true }), 'maintain');
  assert.equal(decideAtDay90(plan, { completedDays: 5, evidenceCount: 0, stillAligned: true }), 'park');
  assert.equal(decideAtDay90(plan, { completedDays: 90, evidenceCount: 30, stillAligned: false }), 'park');
  assert.equal(reviewPlanGate(plan, 'foundation', { completedDays: 25, evidenceCount: 4, stillAligned: true }), 'promote');
});

test('availability caps durations (never below the MVD) and rest days run at MVD scope', () => {
  const plan = generateGoalPlan('Get promoted to senior engineer', ctx({
    roles: ['Career / professional'],
    availability: { defaultMinutes: 60, minutesByWeekday: { 3: 30 }, restDays: [6] },
  }));
  assert.equal(plan.actions.deliverable.durationMinutes, 60);
  assert.match(plan.actions.deliverable.title, /Block 60 minutes/);
  const wednesday = supplyDailyActions(plan, { date: addDays(START, 9), state: 'normal' });
  assert.equal(wednesday.foreground.actionKey, 'deliverable');
  assert.equal(wednesday.foreground.durationMinutes, 30);
  assert.match(wednesday.foreground.title, /Block 30 minutes/);
  const saturday = supplyDailyActions(plan, { date: addDays(START, 12), state: 'normal' });
  assert.equal(saturday.foreground.scope, 'mvd');
  assert.ok(saturday.reasons.includes('rest_day'));
});

test('user minimum floors become the MVD; a vague floor is flagged and the template floor kept', () => {
  const plan = generateGoalPlan('Pass the CPA exam', ctx({ minimumFloors: { execution: 'Do 5 flashcards (5 minutes)' } }));
  assert.equal(plan.actions.practice.mvd.title, 'Do 5 flashcards (5 minutes)');
  assert.equal(plan.actions.practice.mvd.durationMinutes, 5);
  const vague = generateGoalPlan('Pass the CPA exam', ctx({ minimumFloors: { execution: 'work on it' } }));
  assert.ok(vague.safety.reasonCodes.includes('floor.needs_clarifying'));
  assert.match(vague.actions.practice.mvd.title, /practice questions/);
});

test('refinement seam: valid edits apply, vague or unsafe edits are rejected', () => {
  const plan = generateGoalPlan('lose 30 lbs', ctx());
  const result = applyPlanRefinement(plan, {
    source: 'llm:test',
    actions: [
      { key: 'walk', title: 'Walk 25 minutes on the river path after lunch', durationMinutes: 25 },
      { key: 'meal_list', title: 'Work on meals' },
      { key: 'environment', title: 'Start a keto diet and cut carbs' },
      { key: 'nope', title: 'Walk 10 minutes' },
    ],
    gateOutcomes: { build: 'Build: strength twice a week and a 1,200 calorie plan', foundation: 'Foundation: walking on 25 of 30 days, every meal list written' },
    milestones: [{ id: plan.gates[0].milestones[0].id, title: 'Walk slot fixed and used 6 of 7 days' }],
  });
  assert.deepEqual(result.applied.sort(), ['action:walk', 'gate:foundation', `milestone:${plan.gates[0].milestones[0].id}`].sort());
  assert.deepEqual(result.rejected.map((r) => r.target).sort(), ['environment', 'gate:build', 'meal_list', 'nope'].sort());
  assert.equal(result.plan.actions.walk.title, 'Walk 25 minutes on the river path after lunch');
  assert.equal(plan.actions.walk.title.includes('river'), false, 'input plan is not mutated');
  assert.deepEqual(validatePlan(result.plan), []);
  assert.deepEqual(result.plan.provenance.refinedBy, ['llm:test']);

  const wealth = generateGoalPlan('Pay off my student loans', ctx());
  const bad = applyPlanRefinement(wealth, { source: 'llm', actions: [{ key: 'auto_invest', title: 'Buy an S&P 500 index fund every payday' }] });
  assert.equal(bad.applied.length, 0);
  assert.equal(bad.rejected.length, 1);
});

test('invalid dates and empty goals are refused', () => {
  assert.throws(() => generateGoalPlan('lose 30 lbs', ctx({ startDate: '10/05/2026' })));
  assert.throws(() => generateGoalPlan('   ', ctx()));
});
