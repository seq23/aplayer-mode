import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPlan } from '../.test-dist/index.js';

function graph() {
  return {
    identity: { userId: 'user-1', displayName: 'Test User' },
    roles: [],
    pillarSettings: [],
    tracks: [],
    modes: [],
    goals: [],
    milestones: [],
    projects: [],
    commitments: [],
    nextActions: [],
    routines: [],
    people: [],
    lifeRelationships: [],
    lifeAdminItems: [],
    preferences: [],
    rules: [],
    radarItems: [],
    evidence: [],
    connections: [],
    calendarEvents: [],
    messageSignals: [],
    permissions: [],
    actions: [],
    dayRecords: [],
  };
}

test('includes due Life OS items in the Today projection', () => {
  const state = graph();
  state.lifeAdminItems = [{
    id: 'life-1',
    userId: 'user-1',
    kind: 'appointment',
    title: 'Dentist',
    status: 'scheduled',
    importance: 3,
    dueAt: '2026-10-06T12:00:00.000Z',
    recurrence: {},
    details: {},
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00.000Z' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }];
  const plan = buildDailyPlan(state, { date: '2026-10-06' });
  assert.ok(plan.blocks.some((block) => block.lifeAdminItemId === 'life-1' && block.source === 'life_os'));
});

test('recovery mode only carries high-importance Life OS items into Today', () => {
  const state = graph();
  state.lifeAdminItems = [
    {
      id: 'low',
      userId: 'user-1',
      kind: 'shopping',
      title: 'Buy paper towels',
      status: 'open',
      importance: 2,
      dueAt: '2026-10-06T12:00:00.000Z',
      recurrence: {},
      details: {},
      provenance: { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00.000Z' },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'high',
      userId: 'user-1',
      kind: 'bill',
      title: 'Pay insurance',
      status: 'open',
      importance: 5,
      dueAt: '2026-10-06T12:00:00.000Z',
      recurrence: {},
      details: {},
      provenance: { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00.000Z' },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ];
  const plan = buildDailyPlan(state, { date: '2026-10-06', mode: 'recovery' });
  assert.equal(plan.blocks.some((block) => block.lifeAdminItemId === 'low'), false);
  assert.equal(plan.blocks.some((block) => block.lifeAdminItemId === 'high'), true);
});


test('uses the user timezone when deciding which Life OS items are due today', () => {
  const state = graph();
  state.identity.timezone = 'America/Los_Angeles';
  state.lifeAdminItems = [{
    id: 'life-local-day',
    userId: 'user-1',
    kind: 'appointment',
    title: 'Evening appointment',
    status: 'scheduled',
    importance: 3,
    startsAt: '2026-10-07T00:30:00.000Z',
    endsAt: '2026-10-07T01:30:00.000Z',
    recurrence: {},
    details: {},
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00.000Z' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }];
  const plan = buildDailyPlan(state, { now: new Date('2026-10-07T00:45:00.000Z') });
  assert.equal(plan.date, '2026-10-06');
  assert.ok(plan.blocks.some((block) => block.lifeAdminItemId === 'life-local-day'));
});


test('keeps all-day provider events on their serialized provider date west of UTC', () => {
  const state = graph();
  state.identity.timezone = 'America/Los_Angeles';
  state.calendarEvents = [{
    id: 'cal-all-day',
    userId: 'user-1',
    provider: 'google',
    externalEventId: 'ext-1',
    title: 'All-day event',
    startsAt: '2026-10-06T00:00:00.000Z',
    endsAt: '2026-10-07T00:00:00.000Z',
    allDay: true,
    availability: 'busy',
    deleted: false,
  }];
  const oct5 = buildDailyPlan(state, { date: '2026-10-05' });
  const oct6 = buildDailyPlan(state, { date: '2026-10-06' });
  assert.equal(oct5.blocks.some((block) => block.id === 'calendar:cal-all-day'), false);
  assert.equal(oct6.blocks.some((block) => block.id === 'calendar:cal-all-day'), true);
});

test('still localizes timed calendar events into the user day', () => {
  const state = graph();
  state.identity.timezone = 'America/Los_Angeles';
  state.calendarEvents = [{
    id: 'cal-timed',
    userId: 'user-1',
    provider: 'google',
    externalEventId: 'ext-2',
    title: 'Late UTC meeting',
    startsAt: '2026-10-07T00:30:00.000Z',
    endsAt: '2026-10-07T01:00:00.000Z',
    allDay: false,
    availability: 'busy',
    deleted: false,
  }];
  const oct6 = buildDailyPlan(state, { date: '2026-10-06' });
  assert.equal(oct6.blocks.some((block) => block.id === 'calendar:cal-timed'), true);
});

test('projects a timed Life OS item again on its independent due date', () => {
  const state = graph();
  state.identity.timezone = 'UTC';
  state.lifeAdminItems = [{
    id: 'life-timed-due',
    userId: 'user-1',
    kind: 'appointment',
    title: 'Submit follow-up after appointment',
    status: 'scheduled',
    importance: 4,
    startsAt: '2026-10-01T15:00:00.000Z',
    endsAt: '2026-10-01T16:00:00.000Z',
    dueAt: '2026-10-06T12:00:00.000Z',
    recurrence: {},
    details: {},
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: '2026-10-01T00:00:00.000Z' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }];
  const plan = buildDailyPlan(state, { date: '2026-10-06' });
  const block = plan.blocks.find((candidate) => candidate.lifeAdminItemId === 'life-timed-due');
  assert.ok(block);
  assert.equal(block.startAt, undefined);
  assert.equal(block.endAt, undefined);
});
