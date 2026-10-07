import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE_BRIDGE_QUESTION,
  agendaItems,
  composeAgenda,
  deriveDayState,
  generateGoalPlan,
  midDayReplanDecision,
  planContextFromGraph,
  scoreAgendaDay,
  selectForeground,
  supplyDailyActions,
  validateAgenda,
  withCompletionStatus,
} from '../.test-dist/index.js';

const START = '2026-10-07';
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function entry(id, goalId, goal, startDate = START, extra = {}) {
  const plan = generateGoalPlan(goal, { roles: extra.roles ?? [], startDate, timezone: 'America/Chicago' });
  return { record: { id, goalId, status: 'active', gateReviews: {}, startDate, ...extra.record }, plan };
}
const goals = [
  { id: 'g-body', title: 'lose 30 lbs', status: 'active', priority: 1 },
  { id: 'g-money', title: 'Build a 3-month emergency fund', status: 'active', priority: 2, targetDate: shift(START, 10) },
];
const body = entry('p-body', 'g-body', 'lose 30 lbs');
const money = entry('p-money', 'g-money', 'Build a 3-month emergency fund');

test('Never Miss Twice: a closed Miss or an unclosed day with no evidence makes today a Recovery Day', () => {
  const date = shift(START, 3);
  assert.equal(deriveDayState({ date, dayRecords: [{ day: shift(date, -1), verdict: 'miss' }], completions: [], firstActiveDay: START }).state, 'missed_yesterday');
  assert.equal(deriveDayState({ date, dayRecords: [], completions: [], firstActiveDay: START }).reason, 'missed_yesterday_unclosed');
  assert.equal(deriveDayState({ date, dayRecords: [], completions: [{ day: shift(date, -1) }], firstActiveDay: START }).state, 'normal');
  assert.equal(deriveDayState({ date, dayRecords: [{ day: shift(date, -1), verdict: 'mvd' }], completions: [], firstActiveDay: START }).state, 'normal', 'an MVD day is a win');
  assert.equal(deriveDayState({ date: START, dayRecords: [], completions: [], firstActiveDay: START }).state, 'normal', 'day 1 has no yesterday to miss');
  assert.equal(deriveDayState({ date, dayRecords: [], completions: [], firstActiveDay: START, recoveryMode: true }).reason, 'declared_recovery');
});

test('exactly one foreground: the declared foreground wins; otherwise the Arbitration Engine picks; parked plans never do', () => {
  const pinned = selectForeground({ plans: [body, money], goals, foregroundGoalId: 'g-body', date: START, completions: [] });
  assert.equal(pinned.foreground.record.id, 'p-body');
  assert.equal(pinned.source, 'pinned');
  assert.deepEqual(pinned.background.map((e) => e.record.id), ['p-money']);

  const arbitrated = selectForeground({ plans: [body, money], goals, date: START, completions: [] });
  assert.equal(arbitrated.source, 'arbitration');
  assert.equal(arbitrated.arbitration.ranked.length, 2);
  assert.equal(arbitrated.foreground.record.id, 'p-money', 'a real external deadline in 10 days carries urgency');

  const parkedMoney = { ...money, record: { ...money.record, status: 'decided', decision: 'park' } };
  const afterPark = selectForeground({ plans: [body, parkedMoney], goals, foregroundGoalId: 'g-money', date: START, completions: [] });
  assert.equal(afterPark.foreground.record.id, 'p-body');
  assert.equal(afterPark.background.length, 0);
});

test('the printed agenda: Foreground Priority, First Hour (sequence + one action), Daily Stack, Phase Bridge', () => {
  const agenda = composeAgenda({ date: START, state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-body', completions: [], morningSequence: ['Drink water', 'Stretch 60 seconds'] });
  assert.equal(agenda.foregroundPriority.goalId, 'g-body');
  assert.deepEqual(agenda.firstHour.sequence, ['Drink water', 'Stretch 60 seconds']);
  assert.equal(agenda.firstHour.priority.kind, 'plan_action');
  assert.equal(agendaItems(agenda).filter((item) => item.kind === 'plan_action').length, 1, 'one foreground action');
  assert.ok(agenda.dailyStack.every((item) => item.kind !== 'plan_action'));
  assert.ok(agenda.reasons.includes('one_foreground'));
  assert.equal(agenda.bridge, PHASE_BRIDGE_QUESTION);
  assert.deepEqual(agenda.problems, []);
  assert.deepEqual(agenda.background.map((b) => b.goalId), ['g-money']);
});

test('No Catch-Up + MVD: a missed yesterday or mood ≤ 2 prints the minimum, never yesterday’s action on top', () => {
  const day2 = shift(START, 1);
  const normal = composeAgenda({ date: day2, state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
  const day3 = shift(START, 2);
  const missed = composeAgenda({ date: day3, state: 'missed_yesterday', plans: [body], goals, completions: [], morningSequence: [] });
  assert.equal(missed.mode, 'recovery');
  assert.equal(missed.firstHour.priority.scope, 'mvd');
  assert.ok(missed.reasons.includes('never_miss_twice') && missed.reasons.includes('no_catch_up'));
  assert.ok(agendaItems(missed).every((item) => item.actionKey !== normal.firstHour.priority.actionKey || item.scope === 'mvd'), 'yesterday’s action is not stacked');
  assert.ok(agendaItems(missed).length <= agendaItems(normal).length + 1);

  const lowMood = composeAgenda({ date: day2, state: 'normal', mood: 2, plans: [body], goals, completions: [], morningSequence: [] });
  assert.equal(lowMood.mode, 'recovery');
  assert.ok(lowMood.reasons.includes('low_mood_mvd'));
  assert.ok(lowMood.firstHour.priority.durationMinutes <= 15);
  const okMood = composeAgenda({ date: day2, state: 'normal', mood: 3, plans: [body], goals, completions: [], morningSequence: [] });
  assert.equal(okMood.mode, 'standard');
});

test('Today never runs dry: every day of the plan and after it has a foreground action', () => {
  for (let offset = -2; offset < 100; offset += 1) {
    const agenda = composeAgenda({ date: shift(START, offset), state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
    assert.ok(agenda.firstHour.priority?.title, `day ${offset + 1}`);
  }
});

test('MVD stays minimal: no backlog and no background maintenance on a low day', () => {
  const nextActions = [{ id: 'n1', title: 'Email the landlord about the lease', status: 'open' }, { id: 'n2', title: 'Book the dentist for Tuesday', status: 'open' }];
  const normal = composeAgenda({ date: shift(START, 5), state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-body', completions: [], morningSequence: [], nextActions });
  assert.equal(normal.dailyStack.filter((item) => item.kind === 'next_action').length, 2);
  for (const low of [{ state: 'normal', mood: 2 }, { state: 'missed_yesterday' }, { state: 'recovery' }]) {
    const agenda = composeAgenda({ date: shift(START, 5), ...low, plans: [body, money], goals, foregroundGoalId: 'g-body', completions: [], morningSequence: [], nextActions });
    assert.equal(agenda.dailyStack.filter((item) => item.kind === 'next_action').length, 0, JSON.stringify(low));
    assert.equal(agenda.dailyStack.filter((item) => item.planId === 'p-money').length, 0, JSON.stringify(low));
    assert.ok(agenda.reasons.includes('backlog_held_mvd') && agenda.reasons.includes('background_held_mvd'));
    assert.ok(agendaItems(agenda).every((item) => item.scope === 'mvd'));
    assert.equal(agendaItems(agenda).length, 1, 'ONE meaningful action');
  }
  const parent = entry('p-parent', 'g-body', 'Launch my business', START, { roles: ['Parenting / caregiving', 'Building a business'] });
  const parentLow = composeAgenda({ date: shift(START, 5), state: 'normal', mood: 1, plans: [parent], goals, completions: [], morningSequence: [] });
  assert.equal(agendaItems(parentLow).length, 1);
  assert.ok(parentLow.reasons.includes('floors_held_mvd'));
});

test('a background weight-loss plan keeps its movement floor (the substituted floor is not lost)', () => {
  const bodyBackground = composeAgenda({ date: shift(START, 5), state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-money', completions: [], morningSequence: [] });
  const movement = bodyBackground.dailyStack.find((item) => item.planId === 'p-body');
  assert.equal(movement?.actionKey, 'movement_floor');
  assert.equal(movement.scope, 'mvd');
});

test('background plans get maintenance floors only, at MVD scope, one per pillar', () => {
  const agenda = composeAgenda({ date: shift(START, 5), state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-body', completions: [], morningSequence: [] });
  const fromMoney = agenda.dailyStack.filter((item) => item.planId === 'p-money');
  assert.ok(fromMoney.every((item) => item.kind === 'plan_floor' && item.scope === 'mvd'));
  const pillars = agenda.dailyStack.filter((item) => item.kind === 'plan_floor').map((item) => item.pillar);
  assert.equal(new Set(pillars).size, pillars.length);
});

test('Invalid Agenda clause: generic busywork and untimed actions fail validation', () => {
  const agenda = composeAgenda({ date: START, state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
  const broken = { ...agenda, dailyStack: [...agenda.dailyStack, { id: 'x', kind: 'plan_floor', title: 'Review goals', output: 'Reviewed', durationMinutes: 10, status: 'open', reasonCodes: [] }, { id: 'y', kind: 'plan_floor', title: 'Call the bank about the loan', output: 'Call made', status: 'open', reasonCodes: [] }] };
  const problems = validateAgenda(broken);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /Review goals/);
  assert.match(problems[1], /time box/);
  assert.ok(validateAgenda({ ...agenda, firstHour: { sequence: [] } }).some((p) => /No foreground action/.test(p)));
});

test('No Mid-Day Negotiation: mood and discomfort never reopen the day; external change, safety and permission do', () => {
  for (const reason of ['mood', 'discomfort']) assert.equal(midDayReplanDecision(reason).allowed, false);
  for (const reason of ['external_change', 'safety', 'permission']) assert.equal(midDayReplanDecision(reason).allowed, true);
});

test('completion evidence flows back into a frozen agenda and scores the day', () => {
  const agenda = composeAgenda({ date: START, state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
  assert.equal(scoreAgendaDay(agenda, ['body']).verdict, 'miss');
  const key = agenda.firstHour.priority.actionKey;
  const done = withCompletionStatus(agenda, [{ planId: 'p-body', actionKey: key, day: START }]);
  assert.equal(done.firstHour.priority.status, 'done');
  assert.equal(scoreAgendaDay(done, ['body']).verdict, 'full_day');
  const otherDay = withCompletionStatus(agenda, [{ planId: 'p-body', actionKey: key, day: shift(START, -1) }]);
  assert.equal(otherDay.firstHour.priority.status, 'open', 'evidence from another day never counts');

  const mvd = composeAgenda({ date: shift(START, 3), state: 'missed_yesterday', plans: [body], goals, completions: [], morningSequence: [] });
  const mvdDone = withCompletionStatus(mvd, [{ planId: 'p-body', actionKey: mvd.firstHour.priority.actionKey, day: shift(START, 3) }]);
  assert.equal(scoreAgendaDay(mvdDone, ['body']).verdict, 'mvd');
});

test('gate verdicts and the day-90 decision surface on the agenda when due', () => {
  const day30 = composeAgenda({ date: shift(START, 29), state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
  assert.equal(day30.gateReviews[0].gate, 'foundation');
  assert.equal(day30.gateReviews[0].recommended, 'park');
  const both = composeAgenda({ date: shift(START, 29), state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-body', completions: [], morningSequence: [] });
  assert.deepEqual(both.gateReviews.map((g) => g.planId).sort(), ['p-body', 'p-money'], 'a background plan’s gate comes due too');
  const evidence = Array.from({ length: 25 }, (_, i) => ({ planId: 'p-body', actionKey: 'x', day: shift(START, i) }));
  assert.equal(composeAgenda({ date: shift(START, 29), state: 'normal', plans: [body], goals, completions: evidence, morningSequence: [] }).gateReviews[0].recommended, 'promote');
  const reviewed = { ...body, record: { ...body.record, gateReviews: { foundation: { verdict: 'promote' } } } };
  assert.deepEqual(composeAgenda({ date: shift(START, 29), state: 'normal', plans: [reviewed], goals, completions: [], morningSequence: [] }).gateReviews, []);

  const day90 = composeAgenda({ date: shift(START, 89), state: 'normal', plans: [body], goals, completions: evidence, morningSequence: [] });
  assert.equal(day90.phase, 'decision');
  assert.equal(day90.decisions[0].planId, 'p-body');
  const bg90 = composeAgenda({ date: shift(START, 89), state: 'normal', plans: [body, money], goals, foregroundGoalId: 'g-money', completions: [], morningSequence: [] });
  assert.deepEqual(bg90.decisions.map((d) => d.planId).sort(), ['p-body', 'p-money'], 'background plans face the day-90 decision too');
  assert.equal(day90.firstHour.priority.actionKey, 'day90_decision');
});

test('plan context comes from the Personal OS: roles, floors, recovery day, health notes', () => {
  const context = planContextFromGraph({
    roles: [{ name: 'Parenting / caregiving', active: true }, { name: 'Old role', active: false }],
    identity: { timezone: 'America/Chicago' },
    pillarSettings: [{ name: 'body', active: true, critical: true, minimumFloor: 'Walk 10 minutes' }, { name: 'family', active: true, critical: true, minimumFloor: 'Read one bedtime story' }],
    personalOS: { weeklyCadence: { heavyDays: [], lightDays: [], recoveryDay: 'Sunday' }, bodyContext: 'Bad knee', hardBoundaries: ['No work after 6pm'] },
  }, { startDate: START, goal: { targetDate: '2027-03-01' } });
  assert.deepEqual(context.roles, ['Parenting / caregiving']);
  assert.equal(context.minimumFloors.family, 'Read one bedtime story');
  assert.deepEqual(context.availability.restDays, [0]);
  assert.deepEqual(context.body.healthNotes, ['Bad knee']);
  assert.equal(context.targetDate, '2027-03-01');
  const plan = generateGoalPlan('Launch my business', { ...context, roles: ['Parenting / caregiving', 'Building a business'] });
  const floors = supplyDailyActions(plan, { date: shift(START, 2), state: 'normal' }).floors;
  assert.deepEqual(floors.map((f) => f.pillar), ['family'], 'the family pillar floor is protected every day for a parent+ plan');
});

test('carry-forward joins a normal next day once, is held on a recovery day, and refuses catch-up', async () => {
  const { carryForwardProblem, continuityView, dayInsight, suggestPillarReview, verdictFromReview } = await import('../.test-dist/index.js');
  const day2 = shift(START, 1);
  const carried = composeAgenda({ date: day2, state: 'normal', plans: [body], goals, completions: [], morningSequence: [], carryForward: { text: 'Book the gym induction for Thursday', fromDay: START } });
  const item = carried.dailyStack.find((i) => i.kind === 'carry_forward');
  assert.equal(item.planId, 'p-body');
  assert.equal(item.actionKey, 'carry_forward');
  assert.equal(composeAgenda({ date: shift(START, 2), state: 'normal', plans: [body], goals, completions: [], morningSequence: [], carryForward: { text: 'Book the gym induction for Thursday', fromDay: START } }).dailyStack.some((i) => i.kind === 'carry_forward'), false, 'only the next day');
  const held = composeAgenda({ date: day2, state: 'missed_yesterday', plans: [body], goals, completions: [], morningSequence: [], carryForward: { text: 'Book the gym induction for Thursday', fromDay: START } });
  assert.equal(held.dailyStack.some((i) => i.kind === 'carry_forward'), false);
  assert.ok(held.reasons.includes('carry_forward_held'));

  assert.equal(carryForwardProblem('Book the gym induction for Thursday'), null);
  for (const bad of ['Double workout tomorrow', 'Skip lunch to make up', 'Catch up on all the missed sessions', 'Work on fitness', 'Hi']) assert.ok(carryForwardProblem(bad), bad);

  const agenda = composeAgenda({ date: START, state: 'normal', plans: [body], goals, completions: [], morningSequence: [] });
  const doneAgenda = withCompletionStatus(agenda, [{ planId: 'p-body', actionKey: agenda.firstHour.priority.actionKey, day: START }]);
  const review = suggestPillarReview(doneAgenda, ['body', 'wealth']);
  assert.deepEqual(review.map((r) => [r.pillar, r.score]), [['body', 'hit'], ['wealth', 'miss']]);
  assert.equal(verdictFromReview(review, ['body'], false), 'full_day');
  assert.equal(verdictFromReview(review, ['body', 'wealth'], false), 'miss');
  assert.equal(verdictFromReview([{ pillar: 'body', score: 'partial' }], ['body'], true), 'mvd');

  const continuity = continuityView([{ day: START, verdict: 'full_day' }, { day: shift(START, -1), verdict: 'mvd' }, { day: shift(START, -2), verdict: 'miss' }], START);
  assert.deepEqual(continuity.map((d) => d.symbol), ['·', '·', '·', '·', '❌', '⚡', '✅']);
  assert.match(dayInsight(continuity, 'miss'), /data/);
  assert.doesNotMatch(dayInsight(continuity, 'miss'), /fail|lazy|should have/i, 'no shame language');
});

test('Billionaire Mindset (Track 1) shapes arbitration: ownership outranks linear income; the pinned foreground still wins', () => {
  const g = [
    { id: 'g-promo', title: 'Get promoted to engineering manager', status: 'active', priority: 1 },
    { id: 'g-found', title: 'Launch my startup and reach 10 paying customers', status: 'active', priority: 2 },
  ];
  const promo = entry('p-promo', 'g-promo', 'Get promoted to engineering manager');
  const found = entry('p-found', 'g-found', 'Launch my startup and reach 10 paying customers');
  assert.equal(promo.plan.persona.key, 'operator_promotion');
  assert.equal(found.plan.persona.key, 'founder');
  const plain = selectForeground({ plans: [promo, found], goals: g, date: START, completions: [] });
  const shaped = selectForeground({ plans: [promo, found], goals: g, date: START, completions: [], trackKeys: ['billionaire_mindset'] });
  const score = (sel, id) => sel.arbitration.ranked.find((r) => r.id === id).score;
  assert.ok(score(shaped, 'p-found') > score(plain, 'p-found'), 'ownership gains with the Track');
  assert.ok(score(shaped, 'p-promo') < score(plain, 'p-promo'), 'linear income loses with the Track');
  assert.equal(shaped.foreground.record.id, 'p-found');
  const pinned = selectForeground({ plans: [promo, found], goals: g, foregroundGoalId: 'g-promo', date: START, completions: [], trackKeys: ['billionaire_mindset'] });
  assert.equal(pinned.foreground.record.id, 'p-promo', 'a Track is a filter; only the user moves the foreground');

  // composeAgenda passes the active Tracks to arbitration and says so.
  const agenda = composeAgenda({ date: START, state: 'normal', plans: [promo, found], goals: g, completions: [], morningSequence: [],
    tracks: { active: ['billionaire_mindset'], roles: [], settings: {}, referral: false, calendar: [], familyBlocks: [], recentVerdicts: [] } });
  assert.equal(agenda.foregroundPriority.goalId, 'g-found');
  assert.ok(agenda.reasons.includes('track.billionaire.arbitration'));
  assert.ok(agenda.trackFlags.some((flag) => flag.code === 'billionaire.prioritised'));
});

test('Billionaire Mindset shapes Today: strategic work is framed by the four filters, linear effort is challenged, nothing is added', () => {
  const g = [{ id: 'g-found', title: 'Launch my startup and reach 10 paying customers', status: 'active', priority: 1 }];
  const found = entry('p-found', 'g-found', 'Launch my startup and reach 10 paying customers');
  const ctx = (active) => ({ active, roles: [], settings: {}, referral: false, calendar: [], familyBlocks: [], recentVerdicts: [] });
  const base = composeAgenda({ date: START, state: 'normal', plans: [found], goals: g, foregroundGoalId: 'g-found', completions: [], morningSequence: [], tracks: ctx([]) });
  const shaped = composeAgenda({ date: START, state: 'normal', plans: [found], goals: g, foregroundGoalId: 'g-found', completions: [], morningSequence: [], tracks: ctx(['billionaire_mindset']),
    nextActions: [{ id: 'na-1', title: 'Pick up an extra shift on Saturday', goalId: 'g-found', status: 'open', estimatedMinutes: 30 }] });
  assert.equal(base.trackFlags.some((flag) => flag.track === 'billionaire_mindset'), false);
  assert.equal(shaped.firstHour.priority.pillar, 'execution');
  assert.ok(shaped.trackFlags.some((flag) => flag.code === 'billionaire.decision_frame' && /10 years/.test(flag.message)), 'strategic decision framing');
  assert.ok(agendaItems(shaped).some((item) => /extra shift/i.test(item.title)));
  const linear = shaped.trackFlags.filter((flag) => flag.code === 'billionaire.leverage_check');
  assert.equal(linear.length, 1, 'linear effort is challenged for leverage');
  assert.match(linear[0].message, /extra shift/);
  assert.equal(agendaItems(shaped).length, agendaItems(composeAgenda({ date: START, state: 'normal', plans: [found], goals: g, foregroundGoalId: 'g-found', completions: [], morningSequence: [], tracks: ctx([]),
    nextActions: [{ id: 'na-1', title: 'Pick up an extra shift on Saturday', goalId: 'g-found', status: 'open', estimatedMinutes: 30 }] })).length, 'a Track never adds tasks');
});
