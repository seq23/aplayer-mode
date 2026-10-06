import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRadarItems } from '../.test-dist/index.js';

const now = new Date('2026-10-06T12:00:00.000Z');

function goal(overrides = {}) {
  return {
    id: 'goal-1',
    userId: 'user-1',
    title: 'Finish the launch',
    status: 'active',
    health: 'unknown',
    priority: 1,
    provenance: {
      kind: 'stated',
      sourceType: 'manual',
      createdAt: now.toISOString(),
      confidence: 1,
    },
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    id: 'action-1',
    userId: 'user-1',
    goalId: 'goal-1',
    title: 'Write the launch page',
    status: 'open',
    ...overrides,
  };
}

function graph(goals, nextActions) {
  return {
    identity: { userId: 'user-1', displayName: 'Test User' },
    roles: [],
    goals,
    milestones: [],
    projects: [],
    commitments: [],
    nextActions,
    routines: [],
    people: [],
    lifeRelationships: [],
    lifeAdminItems: [],
    preferences: [],
    rules: [],
    radarItems: [],
    evidence: [],
  };
}

test('surfaces an active goal that has no executable next action', () => {
  const result = buildRadarItems(graph([goal()], []), { now });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.type, 'slipping');
  assert.ok(result[0]?.reasonCodes.includes('goal.no_open_next_action'));
  assert.equal(result[0]?.relatedGoalId, 'goal-1');
});

test('surfaces a near deadline even when a next action exists', () => {
  const result = buildRadarItems(
    graph([goal({ targetDate: '2026-10-08' })], [action()]),
    { now },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.type, 'upcoming');
  assert.equal(result[0]?.severity, 'high');
  assert.ok(result[0]?.reasonCodes.includes('goal.deadline_near'));
});

test('does not invent a warning for a healthy executable goal with no near deadline', () => {
  const result = buildRadarItems(
    graph([goal({ health: 'on_track' })], [action()]),
    { now },
  );
  assert.deepEqual(result, []);
});


test('surfaces a Life OS bill before it becomes a miss', () => {
  const state = graph([goal({ health: 'on_track' })], [action()]);
  state.lifeAdminItems = [{
    id: 'life-1',
    userId: 'user-1',
    kind: 'bill',
    title: 'Pay insurance premium',
    status: 'open',
    importance: 4,
    dueAt: '2026-10-08T12:00:00.000Z',
    recurrence: { frequency: 'monthly', interval: 1 },
    details: {},
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: now.toISOString(), confidence: 1 },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }];
  const result = buildRadarItems(state, { now });
  const item = result.find((candidate) => candidate.id === 'radar:life_os:life-1');
  assert.ok(item);
  assert.equal(item.type, 'recurring');
  assert.ok(item.reasonCodes.includes('life_os.kind.bill'));
});

test('surfaces an upcoming birthday from the relationship graph', () => {
  const state = graph([goal({ health: 'on_track' })], [action()]);
  state.people = [{
    id: 'person-1',
    userId: 'user-1',
    name: 'Avery',
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: now.toISOString(), confidence: 1 },
  }];
  state.lifeRelationships = [{
    id: 'relationship-1',
    userId: 'user-1',
    personId: 'person-1',
    birthday: '1990-10-12',
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: now.toISOString(), confidence: 1 },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }];
  const result = buildRadarItems(state, { now });
  const item = result.find((candidate) => candidate.reasonCodes.includes('relationship.birthday_upcoming'));
  assert.ok(item);
  assert.match(item.headline, /Avery/);
});
