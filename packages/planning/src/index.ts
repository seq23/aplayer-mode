import type { DailyPlan, DailyPlanBlock, Goal, LifeGraphSnapshot, NextAction } from '@apm/domain';
import {
  executableActionProblem,
  selectMinimumViableAction,
  shouldForceRecovery,
} from './methodology.js';

export * from './methodology.js';

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

function selectStandardNumberOneMove(graph: LifeGraphSnapshot): NextAction | undefined {
  const foregroundGoalId = graph.personalOS?.foregroundGoalId;
  if (foregroundGoalId) {
    const foreground = graph.nextActions.find(
      (candidate) => candidate.goalId === foregroundGoalId && candidate.status === 'open',
    );
    if (foreground) return foreground;
  }

  const activeGoals = graph.goals.filter((goal) => goal.status === 'active').sort(compareGoals);
  for (const goal of activeGoals) {
    const action = graph.nextActions.find(
      (candidate) => candidate.goalId === goal.id && candidate.status === 'open',
    );
    if (action) return action;
  }
  return graph.nextActions.find((candidate) => candidate.status === 'open');
}

function calendarBlocks(graph: LifeGraphSnapshot, date: string): DailyPlanBlock[] {
  return graph.calendarEvents
    .filter((event) => !event.deleted && event.startsAt.slice(0, 10) === date)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((event) => ({
      id: `calendar:${event.id}`,
      title: event.title || 'Busy',
      startAt: event.startsAt,
      endAt: event.endsAt,
      source: 'calendar' as const,
    }));
}

function lifeOsBlocks(graph: LifeGraphSnapshot, date: string, minImportance = 1): DailyPlanBlock[] {
  return (graph.lifeAdminItems ?? [])
    .filter((item) => {
      if (['completed','cancelled','paused'].includes(item.status) || item.importance < minImportance) return false;
      const relevantAt = item.startsAt ?? item.dueAt;
      return Boolean(relevantAt && relevantAt.slice(0, 10) === date);
    })
    .sort((a, b) => (a.startsAt ?? a.dueAt ?? '').localeCompare(b.startsAt ?? b.dueAt ?? ''))
    .map((item) => ({
      id: `life-os:${item.id}`,
      title: item.title,
      startAt: item.startsAt,
      endAt: item.endsAt,
      lifeAdminItemId: item.id,
      source: 'life_os' as const,
    }));
}

function actionBlock(action: NextAction | undefined): DailyPlanBlock[] {
  if (!action) return [];
  const problem = executableActionProblem(action.title);
  return [
    {
      id: `action:${action.id}`,
      title: problem ? `Clarify next action: ${action.title}` : action.title,
      actionId: action.id,
      goalId: action.goalId,
      source: 'methodology',
    },
  ];
}

export function buildDailyPlan(
  graph: LifeGraphSnapshot,
  options: TodayProjectionOptions = {},
): DailyPlan {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const continuityRecovery = shouldForceRecovery(graph.dayRecords);
  const mode = options.mode ?? (continuityRecovery ? 'recovery' : graph.personalOS?.activeMode ?? 'standard');
  const numberOneMove = mode === 'recovery' ? selectMinimumViableAction(graph) : selectStandardNumberOneMove(graph);
  const openActions = graph.nextActions.filter((action) => action.status === 'open');
  const doneActions = graph.nextActions.filter((action) => action.status === 'done');

  const completionState: DailyPlan['completionState'] =
    openActions.length === 0 && doneActions.length > 0
      ? 'complete'
      : doneActions.length > 0
        ? 'in_progress'
        : 'not_started';

  const calendar = calendarBlocks(graph, date);
  const lifeOs = lifeOsBlocks(graph, date, mode === 'recovery' ? 4 : 1);
  const firstMove = actionBlock(numberOneMove);
  const blocks = mode === 'recovery'
    ? [...calendar, ...lifeOs, ...firstMove]
    : [...firstMove, ...calendar, ...lifeOs];

  return {
    userId: graph.identity.userId,
    date,
    mode,
    numberOneMove,
    morningSequence: graph.personalOS?.morningSequence ?? [],
    blocks,
    routineIds: graph.routines.filter((routine) => routine.active).map((routine) => routine.id),
    commitmentIds: graph.commitments
      .filter((commitment) => !['verified', 'closed', 'dismissed'].includes(commitment.status))
      .map((commitment) => commitment.id),
    approvalActionIds: graph.actions
      .filter((action) => action.status === 'prepared' && action.requiresApproval)
      .map((action) => action.id),
    radarItemIds: graph.radarItems.filter((item) => item.status === 'open').map((item) => item.id),
    completionState,
    verdict: mode === 'recovery' && completionState === 'complete' ? 'mvd' : undefined,
  };
}
export * from './recurrence.js';
