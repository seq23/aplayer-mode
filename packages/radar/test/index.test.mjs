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


test('keeps a birthday reminder active through the full local birthday date', () => {
  const late = new Date('2026-10-12T23:30:00.000Z');
  const state = graph([goal({ health: 'on_track' })], [action()]);
  state.identity.timezone = 'UTC';
  state.people = [{
    id: 'person-2',
    userId: 'user-1',
    name: 'Jordan',
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: late.toISOString(), confidence: 1 },
  }];
  state.lifeRelationships = [{
    id: 'relationship-2',
    userId: 'user-1',
    personId: 'person-2',
    birthday: '1990-10-12',
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: late.toISOString(), confidence: 1 },
    createdAt: late.toISOString(),
    updatedAt: late.toISOString(),
  }];
  const result = buildRadarItems(state, { now: late });
  const item = result.find((candidate) => candidate.reasonCodes.includes('relationship.birthday_upcoming'));
  assert.ok(item);
  assert.match(item.headline, /today/i);
});


test('Life OS lead windows use local calendar days instead of elapsed hours', () => {
  const state = graph([goal({ health: 'on_track' })], [action()]);
  state.identity.timezone = 'America/Los_Angeles';
  state.lifeAdminItems = [{
    id: 'life-local-radar',
    userId: 'user-1',
    kind: 'bill',
    title: 'Pay local bill',
    status: 'open',
    importance: 4,
    dueAt: '2026-10-07T19:00:00.000Z',
    recurrence: {},
    details: {},
    provenance: { kind: 'stated', sourceType: 'manual', createdAt: now.toISOString(), confidence: 1 },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }];

  const dayBefore = buildRadarItems(state, { now: new Date('2026-10-06T15:00:00.000Z') });
  const beforeItem = dayBefore.find((candidate) => candidate.id === 'radar:life_os:life-local-radar');
  assert.ok(beforeItem);
  assert.match(beforeItem.headline, /tomorrow/i);

  const dayAfter = buildRadarItems(state, { now: new Date('2026-10-08T15:00:00.000Z') });
  const afterItem = dayAfter.find((candidate) => candidate.id === 'radar:life_os:life-local-radar');
  assert.ok(afterItem);
  assert.match(afterItem.headline, /overdue/i);
});

test('calendar conflicts are found across connected accounts and name each account; a shared invite is not a conflict (0065)', () => {
  const base = graph([], []);
  const event = (id, connectionId, externalEventId, start, end, title) => ({
    id, userId: 'user-1', connectionId, provider: 'google', externalEventId, title, startsAt: start, endsAt: end,
    allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false,
  });
  const snapshot = {
    ...base,
    connections: [
      { id: 'conn-work', userId: 'user-1', provider: 'google', kind: 'calendar', label: 'Work', isPrimary: true, status: 'connected', scopes: [] },
      { id: 'conn-personal', userId: 'user-1', provider: 'google', kind: 'calendar', label: 'Personal', isPrimary: false, status: 'connected', scopes: [] },
    ],
    calendarEvents: [
      event('w1', 'conn-work', 'board', '2026-10-06T15:00:00.000Z', '2026-10-06T16:00:00.000Z', 'Board prep'),
      event('p1', 'conn-personal', 'dentist', '2026-10-06T15:30:00.000Z', '2026-10-06T16:30:00.000Z', 'Dentist'),
      event('w2', 'conn-work', 'shared', '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z', 'Parent evening'),
      event('p2', 'conn-personal', 'shared', '2026-10-07T15:00:00.000Z', '2026-10-07T16:00:00.000Z', 'Parent evening'),
    ],
  };
  const conflicts = buildRadarItems(snapshot, { now, maxItems: 20 }).filter((item) => item.reasonCodes.includes('calendar.busy_overlap'));
  assert.equal(conflicts.length, 1, 'work vs personal is a conflict; the same invite on both is not');
  assert.deepEqual(conflicts[0].sourceRefs.map((ref) => ref.label).sort(), ['Personal', 'Work']);
});
