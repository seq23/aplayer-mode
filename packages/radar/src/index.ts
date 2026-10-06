import type { Goal, LifeGraphSnapshot, RadarItem } from '@apm/domain';

const DAY_MS = 86_400_000;

export interface RadarBuildOptions {
  now?: Date;
  maxItems?: number;
}

const severityRank: Record<RadarItem['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function goalImportance(goal: Goal): number {
  return Math.max(0.4, Math.min(1, 1 - (goal.priority - 1) * 0.1));
}

function daysUntil(targetDate: string | undefined, now: Date): number | undefined {
  if (!targetDate) return undefined;
  const target = Date.parse(`${targetDate}T23:59:59.999Z`);
  if (Number.isNaN(target)) return undefined;
  return Math.ceil((target - now.getTime()) / DAY_MS);
}

function score(item: RadarItem): number {
  return (
    item.importance * 0.28 +
    item.urgency * 0.28 +
    item.goalAlignment * 0.22 +
    item.consequence * 0.22
  );
}

function makeGoalItem(
  goal: Goal,
  now: Date,
  input: Pick<RadarItem, 'type' | 'headline' | 'summary' | 'severity' | 'urgency' | 'consequence'> & {
    rule: string;
    extraReasons?: string[];
  },
): RadarItem {
  const createdAt = now.toISOString();
  return {
    id: `radar:${input.rule}:${goal.id}`,
    userId: goal.userId,
    type: input.type,
    headline: input.headline,
    summary: input.summary,
    status: 'open',
    severity: input.severity,
    confidence: 1,
    importance: goalImportance(goal),
    urgency: input.urgency,
    goalAlignment: 1,
    consequence: input.consequence,
    sourceRefs: [
      {
        sourceType: 'system',
        sourceRef: goal.id,
        label: `Life Graph goal: ${goal.title}`,
      },
    ],
    reasonCodes: [input.rule, ...(input.extraReasons ?? [])],
    relatedGoalId: goal.id,
    createdAt,
    firstRelevantAt: createdAt,
  };
}

export function buildRadarItems(
  graph: LifeGraphSnapshot,
  options: RadarBuildOptions = {},
): RadarItem[] {
  const now = options.now ?? new Date();
  const maxItems = Math.max(1, options.maxItems ?? 5);
  const items: RadarItem[] = [];

  for (const goal of graph.goals.filter((candidate) => candidate.status === 'active')) {
    const actionable = graph.nextActions.find(
      (action) =>
        action.goalId === goal.id &&
        (action.status === 'open' || action.status === 'scheduled'),
    );
    const remainingDays = daysUntil(goal.targetDate, now);

    if (remainingDays !== undefined && remainingDays <= 7) {
      const overdue = remainingDays < 0;
      const dueNow = remainingDays <= 1;
      const severity: RadarItem['severity'] = overdue
        ? 'critical'
        : dueNow
          ? 'high'
          : remainingDays <= 3
            ? 'high'
            : 'medium';
      const deadlineText = overdue
        ? 'past its target date'
        : remainingDays === 0
          ? 'due today'
          : remainingDays === 1
            ? 'due tomorrow'
            : `due in ${remainingDays} days`;

      items.push(
        makeGoalItem(goal, now, {
          rule: overdue ? 'goal.deadline_overdue' : 'goal.deadline_near',
          extraReasons: actionable ? [] : ['goal.no_open_next_action'],
          type: dueNow || overdue ? 'urgent' : 'upcoming',
          headline: `${goal.title} is ${deadlineText}`,
          summary: actionable
            ? `The target date is close. Your current next action is “${actionable.title}.”`
            : 'The target date is close and APM cannot find an open next action for this goal.',
          severity,
          urgency: overdue || dueNow ? 1 : remainingDays <= 3 ? 0.9 : 0.7,
          consequence: goal.health === 'stalled' || goal.health === 'at_risk' ? 0.9 : 0.7,
        }),
      );
      continue;
    }

    if (!actionable) {
      items.push(
        makeGoalItem(goal, now, {
          rule: 'goal.no_open_next_action',
          type: 'slipping',
          headline: `${goal.title} needs a next move`,
          summary:
            'APM cannot find an open next action for this active goal. Without one, the goal has no executable path forward.',
          severity: goal.health === 'stalled' || goal.health === 'at_risk' ? 'high' : 'medium',
          urgency: goal.health === 'stalled' ? 0.85 : 0.65,
          consequence: goal.health === 'stalled' || goal.health === 'at_risk' ? 0.85 : 0.65,
        }),
      );
      continue;
    }

    if (goal.health === 'stalled' || goal.health === 'at_risk') {
      items.push(
        makeGoalItem(goal, now, {
          rule: `goal.health_${goal.health}`,
          type: 'slipping',
          headline: `${goal.title} is ${goal.health === 'stalled' ? 'stalled' : 'at risk'}`,
          summary: `APM has an executable next action, but the goal health is marked ${goal.health.replace('_', ' ')}.`,
          severity: goal.health === 'stalled' ? 'high' : 'medium',
          urgency: goal.health === 'stalled' ? 0.8 : 0.65,
          consequence: 0.8,
        }),
      );
    }
  }

  return items
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || score(b) - score(a))
    .slice(0, maxItems);
}
