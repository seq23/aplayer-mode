import { describe, expect, it } from 'vitest';
import type { Goal, LifeGraphSnapshot, NextAction } from '@apm/domain';
import { buildRadarItems } from './index';

const now = new Date('2026-10-06T12:00:00.000Z');

function goal(overrides: Partial<Goal> = {}): Goal {
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

function action(overrides: Partial<NextAction> = {}): NextAction {
  return {
    id: 'action-1',
    userId: 'user-1',
    goalId: 'goal-1',
    title: 'Write the launch page',
    status: 'open',
    ...overrides,
  };
}

function graph(goals: Goal[], nextActions: NextAction[]): LifeGraphSnapshot {
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

describe('buildRadarItems', () => {
  it('surfaces an active goal that has no executable next action', () => {
    const result = buildRadarItems(graph([goal()], []), { now });

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('slipping');
    expect(result[0]?.reasonCodes).toContain('goal.no_open_next_action');
    expect(result[0]?.relatedGoalId).toBe('goal-1');
  });

  it('surfaces a near deadline even when a next action exists', () => {
    const result = buildRadarItems(
      graph([goal({ targetDate: '2026-10-08' })], [action()]),
      { now },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('upcoming');
    expect(result[0]?.severity).toBe('high');
    expect(result[0]?.reasonCodes).toContain('goal.deadline_near');
  });

  it('does not invent a warning for a healthy executable goal with no near deadline', () => {
    const result = buildRadarItems(
      graph([goal({ health: 'on_track' })], [action()]),
      { now },
    );

    expect(result).toEqual([]);
  });
});
