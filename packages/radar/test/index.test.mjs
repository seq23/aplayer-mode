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
