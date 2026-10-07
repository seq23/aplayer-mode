import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WELCOME_BACK,
  agendaItems,
  coachingCheckIn,
  composeAgenda,
  detectDrift,
  firstWeekProgramme,
  generateGoalPlan,
  reprintAgenda,
  weeklyDebrief,
  weeklyReviewDue,
} from '../.test-dist/index.js';

const START = '2026-10-07';
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const entry = (goal, roles = [], extra = {}) => ({ record: { id: 'p1', goalId: 'g1', status: 'active', gateReviews: {}, startDate: START }, plan: generateGoalPlan(goal, { roles, startDate: START, ...extra }) });
const goals = [{ id: 'g1', title: 'goal', status: 'active', priority: 1 }];
const tracks = (active, extra = {}) => ({ active, roles: [], settings: {}, referral: false, calendar: [], familyBlocks: [], recentVerdicts: [], ...extra });

test('Body Foundation: a day with no body item gets the movement floor; MVD only flags; referral pauses', () => {
  const plan = entry('Pass the CPA exam', ['Studying / learning']);
  const day = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], tracks: tracks(['body_foundation'], { settings: { movementFloor: 'Walk 12 minutes after lunch' } }) });
  const floor = day.dailyStack.find((item) => item.actionKey === 'track:body_floor');
  assert.equal(floor.title, 'Walk 12 minutes after lunch');
  assert.equal(floor.pillar, 'movement');
  assert.ok(day.reasons.includes('body.floor_missing'));
  assert.deepEqual(day.problems, []);
  const low = composeAgenda({ date: shift(START, 3), state: 'normal', mood: 1, plans: [plan], goals, completions: [], morningSequence: [], tracks: tracks(['body_foundation']) });
  assert.equal(agendaItems(low).length, 1, 'MVD stays one action');
  assert.ok(low.trackFlags.some((flag) => flag.code === 'body.floor_missing'));
  const paused = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], tracks: tracks(['body_foundation'], { referral: true }) });
  assert.ok(!paused.dailyStack.some((item) => item.actionKey === 'track:body_floor'));
  assert.ok(paused.trackFlags.some((flag) => flag.code === 'body.referral'));
  const body = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [entry('lose 30 lbs')], goals, completions: [], morningSequence: [], tracks: tracks(['body_foundation']) });
  assert.ok(!body.dailyStack.some((item) => item.kind === 'track_floor'), 'a body plan already carries body behaviour');
});

test('Home Front: parent touchpoint floor, protected-block collisions and the hard stop', () => {
  const plan = entry('Get my first 10 paying customers', ['Building a business']);
  const ctx = tracks(['home_front'], {
    roles: ['Parenting / caregiving', 'Building a business'],
    timezone: 'America/Chicago',
    settings: { hardStop: '18:00', homeTouchpoint: 'Bath and bedtime story, phone away' },
    calendar: [{ title: 'Investor call', startsAt: '2026-10-10T22:00:00Z', endsAt: '2026-10-10T23:00:00Z' }, { title: 'Late pitch prep', startsAt: '2026-10-11T00:30:00Z', endsAt: '2026-10-11T01:00:00Z' }],
    familyBlocks: [{ title: 'School pickup', startsAt: '2026-10-10T21:45:00Z', endsAt: '2026-10-10T22:30:00Z' }],
  });
  const day = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], tracks: ctx });
  assert.equal(day.dailyStack.find((item) => item.actionKey === 'track:home_touchpoint').title, 'Bath and bedtime story, phone away');
  const codes = day.trackFlags.map((flag) => flag.code);
  assert.ok(codes.includes('home.block_collision'));
  assert.equal(codes.filter((code) => code === 'home.after_hours').length, 1, '19:30 local is after the 18:00 stop; 17:00 is not');
  const nonParent = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], tracks: { ...ctx, roles: ['Building a business'] } });
  assert.ok(!nonParent.dailyStack.some((item) => item.kind === 'track_floor'));
});

test('Wealth Foundation buffer gate holds speculative items; Resilience flags two light days', () => {
  const plan = entry('Build a 3-month emergency fund');
  const nextActions = [{ id: 'n1', title: 'Buy more bitcoin on the dip', status: 'open' }, { id: 'n2', title: 'Call the bank about the overdraft fee', status: 'open' }];
  const gated = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], nextActions, tracks: tracks(['wealth_foundation']) });
  assert.ok(!gated.dailyStack.some((item) => item.nextActionId === 'n1'));
  assert.ok(gated.dailyStack.some((item) => item.nextActionId === 'n2'));
  assert.ok(gated.trackFlags.some((flag) => flag.code === 'wealth.buffer_gate'));
  const met = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], nextActions, tracks: tracks(['wealth_foundation'], { settings: { bufferMonths: 6, bufferTarget: 3, highInterestDebt: false } }) });
  assert.ok(met.dailyStack.some((item) => item.nextActionId === 'n1'), 'buffer met: the user decides');
  const tired = composeAgenda({ date: shift(START, 3), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [], tracks: tracks(['resilience'], { recentVerdicts: ['mvd', 'miss'] }) });
  assert.ok(tired.trackFlags.some((flag) => flag.code === 'resilience.capacity'));
});

test('REPRINT swaps a flagged or generic item without changing scope; a valid agenda needs nothing', () => {
  const plan = entry('Get my first 10 paying customers', ['Building a business']);
  const agenda = composeAgenda({ date: shift(START, 10), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [] });
  assert.deepEqual(reprintAgenda(agenda, [plan]).replaced, []);
  const flagged = reprintAgenda(agenda, [plan], [agenda.firstHour.priority.id]);
  assert.equal(flagged.replaced.length, 1);
  // No Mid-Day Negotiation (engine P1-2): the foreground keeps its action; only its scope drops to MVD.
  assert.equal(flagged.agenda.firstHour.priority.actionKey, agenda.firstHour.priority.actionKey);
  assert.equal(flagged.agenda.firstHour.priority.scope, 'mvd');
  assert.equal(flagged.agenda.firstHour.priority.title, plan.plan.actions[agenda.firstHour.priority.actionKey].mvd.title);
  assert.equal(flagged.agenda.mode, agenda.mode);
  const generic = { ...agenda, dailyStack: [...agenda.dailyStack, { id: 'g', kind: 'next_action', title: 'Review goals', nextActionId: 'x', status: 'open', reasonCodes: [] }] };
  const fixed = reprintAgenda(generic, [plan]);
  assert.ok(!fixed.agenda.dailyStack.some((item) => item.title === 'Review goals'));
  assert.deepEqual(fixed.stillInvalid, []);
});

test('Drift Check: two silent days offer the restart with no gap analysis', () => {
  const quiet = detectDrift({ date: shift(START, 5), dayRecords: [{ day: shift(START, 1), closedAt: 'x' }], completions: [], firstActiveDay: START });
  assert.equal(quiet.drifting, true);
  assert.equal(quiet.daysAway, 3);
  assert.equal(quiet.message, WELCOME_BACK);
  assert.equal(detectDrift({ date: shift(START, 2), dayRecords: [{ day: shift(START, 1), checkedInAt: 'x' }], completions: [], firstActiveDay: START }).drifting, false);
  const back = detectDrift({ date: shift(START, 5), dayRecords: [{ day: shift(START, 5), returnedAt: 'x' }], completions: [], firstActiveDay: START });
  assert.equal(back.acknowledged, true);
  assert.equal(back.message, undefined);
});

test('First 7 Days programme, the coaching check-in and the weekly debrief cadence', () => {
  assert.equal(firstWeekProgramme(START, START).objective, 'Installation Day');
  assert.match(firstWeekProgramme(START, START).loop, /only the first item/);
  assert.equal(firstWeekProgramme(START, shift(START, 6)).objective, 'First Review');
  assert.equal(firstWeekProgramme(START, shift(START, 7)), undefined);
  assert.equal(coachingCheckIn({ lastCoachingAt: '2026-10-01T09:00:00Z', today: '2026-10-08' }).due, true);
  assert.equal(coachingCheckIn({ lastCoachingAt: '2026-10-05T09:00:00Z', today: '2026-10-08' }).due, false);
  assert.equal(coachingCheckIn({ lastCoachingAt: '2026-10-05T09:00:00Z', today: '2026-10-08', afterDays: 3 }).due, true);
  assert.equal(weeklyReviewDue({ today: '2026-10-11', reviews: [] }).due, true, '11 Oct 2026 is a Sunday');
  assert.equal(weeklyReviewDue({ today: '2026-10-11', reviews: [{ weekStart: '2026-10-05' }] }).due, false);
  assert.equal(weeklyReviewDue({ today: '2026-10-09', reviewDay: 'Friday', reviews: [] }).due, true);
  const debrief = weeklyDebrief({
    today: '2026-10-11',
    dayRecords: [{ day: '2026-10-05', verdict: 'full_day', replans: [] }, { day: '2026-10-06', verdict: 'mvd', replans: [{ reason: 'safety' }] }, { day: '2026-10-07', verdict: 'miss', replans: [] }],
    completions: [{ day: '2026-10-05', planId: 'p1', role: 'foreground' }, { day: '2026-10-06', planId: 'p1', role: 'foreground' }],
    foreground: { planId: 'p1', label: 'lose 30 lbs' },
    diary: [{ kind: 'breakthrough', body: 'Walking after lunch works', localDay: '2026-10-08' }, { kind: 'diary', body: 'old', localDay: '2026-09-01' }],
  });
  assert.deepEqual([debrief.executionScore.counted, debrief.executionScore.misses, debrief.executionScore.unclosed], [2, 1, 4]);
  assert.equal(debrief.foregroundFocus.daysWithForegroundDone, 2);
  assert.ok(debrief.friction.some((line) => /replan/.test(line)));
  assert.equal(debrief.diary.length, 1);
  assert.equal(debrief.executiveReview.open, "Here's what you already know that still makes you better:");
});

test('a recorded red flag keeps the body plan paused until clearance', () => {
  const paused = generateGoalPlan('lose 30 lbs', { roles: [], startDate: START, body: { referralActive: true } });
  assert.equal(paused.safety.referral, true);
  assert.ok(paused.safety.reasonCodes.includes('body.referral'));
  const cleared = generateGoalPlan('lose 30 lbs', { roles: [], startDate: START, body: { referralActive: false, clinicianCleared: true, healthNotes: ['fainted last month'] } });
  assert.equal(cleared.safety.referral, false);
});

test('REPRINT never drops a protected floor: a flagged floor becomes its own MVD or stays', () => {
  const plan = entry('Launch my startup MVP to ten paying users', ['Parenting / caregiving', 'Building a business']);
  const agenda = composeAgenda({ date: shift(START, 2), state: 'normal', plans: [plan], goals, completions: [], morningSequence: [] });
  const floor = agenda.dailyStack.find((item) => item.kind === 'plan_floor');
  assert.ok(floor, 'the parent+founder plan prints its family floor');
  const out = reprintAgenda(agenda, [plan], [floor.id]);
  const kept = out.agenda.dailyStack.find((item) => item.kind === 'plan_floor' && item.actionKey === floor.actionKey);
  assert.ok(kept, 'the floor is still on the agenda');
  assert.equal(out.agenda.dailyStack.length, agenda.dailyStack.length);
  const both = reprintAgenda(agenda, [plan], [floor.id, agenda.firstHour.priority.id]);
  assert.equal(both.agenda.firstHour.priority.actionKey, agenda.firstHour.priority.actionKey, 'the foreground is never swapped');
  assert.ok(both.agenda.dailyStack.some((item) => item.kind === 'plan_floor' && item.actionKey === floor.actionKey));
});
