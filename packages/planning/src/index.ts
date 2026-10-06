import type { DailyPlan, Goal, LifeGraphSnapshot, NextAction } from '@apm/domain';

export interface TodayProjectionOptions {
  date?: string;
  mode?: DailyPlan['mode'];
}

function compareGoals(a: Goal, b: Goal): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const healthRank: Record<Goal['health'], number> = {
    at_risk: 0,
    stalled: 1,
    unknown: 2,
    on_track: 3,
  };
  return healthRank[a.health] - healthRank[b.health];
}

function selectNumberOneMove(graph: LifeGraphSnapshot): NextAction | undefined {
  const activeGoals = graph.goals
    .filter((goal) => goal.status === 'active')
    .sort(compareGoals);

  for (const goal of activeGoals) {
    const action = graph.nextActions.find(
      (candidate) => candidate.goalId === goal.id && candidate.status === 'open',
    );
    if (action) return action;
  }

  return graph.nextActions.find((candidate) => candidate.status === 'open');
}

export function buildDailyPlan(
  graph: LifeGraphSnapshot,
  options: TodayProjectionOptions = {},
): DailyPlan {
  const numberOneMove = selectNumberOneMove(graph);
  const openActions = graph.nextActions.filter((action) => action.status === 'open');
  const doneActions = graph.nextActions.filter((action) => action.status === 'done');

  const completionState: DailyPlan['completionState'] =
    openActions.length === 0 && doneActions.length > 0
      ? 'complete'
      : doneActions.length > 0
        ? 'in_progress'
        : 'not_started';

  return {
    userId: graph.identity.userId,
    date: options.date ?? new Date().toISOString().slice(0, 10),
    mode: options.mode ?? 'standard',
    numberOneMove,
    blocks: [],
    routineIds: graph.routines.filter((routine) => routine.active).map((routine) => routine.id),
    commitmentIds: graph.commitments
      .filter((commitment) => !['verified', 'closed', 'dismissed'].includes(commitment.status))
      .map((commitment) => commitment.id),
    approvalActionIds: [],
    radarItemIds: graph.radarItems.filter((item) => item.status === 'open').map((item) => item.id),
    completionState,
  };
}
