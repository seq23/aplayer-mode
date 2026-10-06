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
