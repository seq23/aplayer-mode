import type { DailyPlan, DailyPlanBlock, Goal, LifeGraphSnapshot, NextAction } from '@apm/domain';
import {
  executableActionProblem,
  selectMinimumViableAction,
} from './methodology.js';
import { dayStateFromGraph } from './daily-loop.js';

export * from './methodology.js';

export interface TodayProjectionOptions {
  date?: string;
  mode?: DailyPlan['mode'];
  now?: Date;
}

export function calendarDateInTimezone(value: string | Date, timezone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    const year = read('year');
    const month = read('month');
    const day = read('day');
    return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
  } catch {
    return date.toISOString().slice(0, 10);
  }
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

function calendarEventDate(graph: LifeGraphSnapshot, event: LifeGraphSnapshot['calendarEvents'][number]): string {
  if (event.allDay) {
    // Cloud providers normalize date-only values to a synthetic UTC midnight, so
    // preserve their serialized date. Device calendars hand us real instants plus
    // the source timezone, so recover the local calendar date instead.
    if (event.provider === 'device') {
      return calendarDateInTimezone(event.startsAt, event.timezone ?? graph.identity.timezone);
    }
    return event.startsAt.slice(0, 10);
  }
  return calendarDateInTimezone(event.startsAt, graph.identity.timezone);
}

function calendarBlocks(graph: LifeGraphSnapshot, date: string): DailyPlanBlock[] {
  return graph.calendarEvents
    .filter((event) => !event.deleted && calendarEventDate(graph, event) === date)
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
  const timezone = graph.identity.timezone;
  return (graph.lifeAdminItems ?? [])
    .filter((item) => {
      if (['completed','cancelled','paused'].includes(item.status) || item.importance < minImportance) return false;
      const scheduledToday = Boolean(item.startsAt && calendarDateInTimezone(item.startsAt, timezone) === date);
      const dueToday = Boolean(item.dueAt && calendarDateInTimezone(item.dueAt, timezone) === date);
      return scheduledToday || dueToday;
    })
    .sort((a, b) => (a.startsAt ?? a.dueAt ?? '').localeCompare(b.startsAt ?? b.dueAt ?? ''))
    .map((item) => {
      const scheduledToday = Boolean(item.startsAt && calendarDateInTimezone(item.startsAt, timezone) === date);
      return {
        id: `life-os:${item.id}`,
        title: item.title,
        startAt: scheduledToday ? item.startsAt : undefined,
        endAt: scheduledToday ? item.endsAt : undefined,
        lifeAdminItemId: item.id,
        source: 'life_os' as const,
      };
    });
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
  const date = options.date ?? calendarDateInTimezone(options.now ?? new Date(), graph.identity.timezone);
  // Never Miss Twice for YESTERDAY only, by the daily loop's own rule (one rule, not two).
  const continuityRecovery = dayStateFromGraph(graph, date, false).state === 'missed_yesterday';
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
export * from './goal-plan.js';
export * from './daily-loop.js';
export * from './track-rules.js';
export * from './loop-extras.js';
