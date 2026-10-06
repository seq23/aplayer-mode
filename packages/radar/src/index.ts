import type { CalendarEvent, Commitment, Goal, LifeGraphSnapshot, RadarItem } from '@apm/domain';

const DAY_MS = 86_400_000;

export interface RadarBuildOptions {
  now?: Date;
  maxItems?: number;
}

const severityRank: Record<RadarItem['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

function goalImportance(goal: Goal): number {
  return Math.max(0.4, Math.min(1, 1 - (goal.priority - 1) * 0.1));
}

function daysUntilDate(targetDate: string | undefined, now: Date): number | undefined {
  if (!targetDate) return undefined;
  const target = targetDate.includes('T') ? Date.parse(targetDate) : Date.parse(`${targetDate}T23:59:59.999Z`);
  if (Number.isNaN(target)) return undefined;
  return Math.ceil((target - now.getTime()) / DAY_MS);
}

function score(item: RadarItem): number {
  return item.importance * 0.28 + item.urgency * 0.28 + item.goalAlignment * 0.22 + item.consequence * 0.22;
}

function sourceType(source: string): RadarItem['sourceRefs'][number]['sourceType'] {
  if (source === 'gmail' || source === 'outlook' || source === 'calendar' || source === 'conversation' || source === 'manual') return source;
  return 'system';
}

function makeGoalItem(
  goal: Goal,
  now: Date,
  input: Pick<RadarItem, 'type' | 'headline' | 'summary' | 'severity' | 'urgency' | 'consequence'> & { rule: string; extraReasons?: string[] },
): RadarItem {
  const createdAt = now.toISOString();
  return {
    id: `radar:${input.rule}:${goal.id}`, userId: goal.userId, type: input.type, headline: input.headline, summary: input.summary,
    status: 'open', severity: input.severity, confidence: 1, importance: goalImportance(goal), urgency: input.urgency,
    goalAlignment: 1, consequence: input.consequence,
    sourceRefs: [{ sourceType: 'system', sourceRef: goal.id, label: `Life Graph goal: ${goal.title}` }],
    reasonCodes: [input.rule, ...(input.extraReasons ?? [])], relatedGoalId: goal.id, createdAt, firstRelevantAt: createdAt,
  };
}

function commitmentItem(commitment: Commitment, graph: LifeGraphSnapshot, now: Date): RadarItem | null {
  if (['verified','closed','dismissed','corrected'].includes(commitment.status) || !commitment.dueAt) return null;
  const days = daysUntilDate(commitment.dueAt, now);
  if (days === undefined || days > 7) return null;
  const goal = commitment.goalId ? graph.goals.find((candidate) => candidate.id === commitment.goalId) : undefined;
  const overdue = days < 0;
  const soon = days <= 1;
  const ownedByUser = commitment.owner === 'user';
  const headline = overdue
    ? `${commitment.title} is overdue`
    : days === 0
      ? `${commitment.title} is due today`
      : days === 1
        ? `${commitment.title} is due tomorrow`
        : `${commitment.title} is due in ${days} days`;
  const label = commitment.provenance.sourceType === 'gmail' ? 'Gmail' : commitment.provenance.sourceType === 'outlook' ? 'Outlook' : 'Life Graph';
  return {
    id: `radar:commitment:${commitment.id}`, userId: commitment.userId,
    type: ownedByUser ? (overdue || soon ? 'promised' : 'upcoming') : 'waiting',
    headline,
    summary: ownedByUser ? 'APM still sees this commitment as open.' : 'This is still waiting on someone else and the due point is approaching.',
    status: 'open', severity: overdue ? 'critical' : soon ? 'high' : 'medium', confidence: commitment.provenance.confidence ?? 0.9,
    importance: goal ? goalImportance(goal) : 0.7, urgency: overdue ? 1 : soon ? 0.9 : 0.65,
    goalAlignment: goal ? 1 : 0.6, consequence: overdue ? 0.9 : 0.7,
    sourceRefs: [{ sourceType: sourceType(commitment.provenance.sourceType), sourceRef: commitment.provenance.sourceRef, label }],
    reasonCodes: [overdue ? 'commitment.overdue' : 'commitment.due_soon', ownedByUser ? 'commitment.user_owned' : 'commitment.waiting_on_other'],
    relatedGoalId: commitment.goalId, relatedProjectId: commitment.projectId, relatedCommitmentId: commitment.id,
    createdAt: now.toISOString(), firstRelevantAt: now.toISOString(),
  };
}

function overlaps(a: CalendarEvent, b: CalendarEvent): boolean {
  if (a.allDay || b.allDay || a.availability === 'free' || b.availability === 'free') return false;
  return Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
}

function calendarConflictItems(graph: LifeGraphSnapshot, now: Date): RadarItem[] {
  const horizon = now.getTime() + 7 * DAY_MS;
  const events = (graph.calendarEvents ?? [])
    .filter((event) => !event.deleted && Date.parse(event.endsAt) >= now.getTime() && Date.parse(event.startsAt) <= horizon)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const items: RadarItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      if (Date.parse(events[j]!.startsAt) >= Date.parse(events[i]!.endsAt)) break;
      const a = events[i]!;
      const b = events[j]!;
      if (!overlaps(a, b)) continue;
      const key = [a.id, b.id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const startsInHours = (Math.min(Date.parse(a.startsAt), Date.parse(b.startsAt)) - now.getTime()) / 3_600_000;
      items.push({
        id: `radar:calendar_conflict:${key}`, userId: graph.identity.userId, type: 'conflict',
        headline: `Calendar conflict: ${a.title || 'event'} and ${b.title || 'event'}`,
        summary: 'Two busy calendar events overlap. APM will not silently move either one.', status: 'open',
        severity: startsInHours <= 24 ? 'high' : 'medium', confidence: 1, importance: 0.75,
        urgency: startsInHours <= 24 ? 0.95 : 0.7, goalAlignment: 0.6, consequence: 0.75,
        sourceRefs: [
          { sourceType: 'calendar', sourceRef: a.externalEventId, label: a.provider },
          { sourceType: 'calendar', sourceRef: b.externalEventId, label: b.provider },
        ],
        reasonCodes: ['calendar.busy_overlap'], createdAt: now.toISOString(), firstRelevantAt: now.toISOString(),
      });
    }
  }
  return items;
}

export function buildRadarItems(graph: LifeGraphSnapshot, options: RadarBuildOptions = {}): RadarItem[] {
  const now = options.now ?? new Date();
  const maxItems = Math.max(1, options.maxItems ?? 8);
  const items: RadarItem[] = [];

  for (const goal of graph.goals.filter((candidate) => candidate.status === 'active')) {
    const actionable = graph.nextActions.find((action) => action.goalId === goal.id && (action.status === 'open' || action.status === 'scheduled'));
    const remainingDays = daysUntilDate(goal.targetDate, now);
    if (remainingDays !== undefined && remainingDays <= 7) {
      const overdue = remainingDays < 0;
      const dueNow = remainingDays <= 1;
      const severity: RadarItem['severity'] = overdue ? 'critical' : dueNow ? 'high' : remainingDays <= 3 ? 'high' : 'medium';
      const deadlineText = overdue ? 'past its target date' : remainingDays === 0 ? 'due today' : remainingDays === 1 ? 'due tomorrow' : `due in ${remainingDays} days`;
      items.push(makeGoalItem(goal, now, {
        rule: overdue ? 'goal.deadline_overdue' : 'goal.deadline_near', extraReasons: actionable ? [] : ['goal.no_open_next_action'],
        type: dueNow || overdue ? 'urgent' : 'upcoming', headline: `${goal.title} is ${deadlineText}`,
        summary: actionable ? `The target date is close. Your current next action is “${actionable.title}.”` : 'The target date is close and APM cannot find an open next action for this goal.',
        severity, urgency: overdue || dueNow ? 1 : remainingDays <= 3 ? 0.9 : 0.7, consequence: goal.health === 'stalled' || goal.health === 'at_risk' ? 0.9 : 0.7,
      }));
      continue;
    }
    if (!actionable) {
      items.push(makeGoalItem(goal, now, {
        rule: 'goal.no_open_next_action', type: 'slipping', headline: `${goal.title} needs a next move`,
        summary: 'APM cannot find an open next action for this active goal. Without one, the goal has no executable path forward.',
        severity: goal.health === 'stalled' || goal.health === 'at_risk' ? 'high' : 'medium', urgency: goal.health === 'stalled' ? 0.85 : 0.65, consequence: goal.health === 'stalled' || goal.health === 'at_risk' ? 0.85 : 0.65,
      }));
      continue;
    }
    if (goal.health === 'stalled' || goal.health === 'at_risk') {
      items.push(makeGoalItem(goal, now, {
        rule: `goal.health_${goal.health}`, type: 'slipping', headline: `${goal.title} is ${goal.health === 'stalled' ? 'stalled' : 'at risk'}`,
        summary: `APM has an executable next action, but the goal health is marked ${goal.health.replace('_', ' ')}.`,
        severity: goal.health === 'stalled' ? 'high' : 'medium', urgency: goal.health === 'stalled' ? 0.8 : 0.65, consequence: 0.8,
      }));
    }
  }

  for (const commitment of graph.commitments ?? []) {
    const item = commitmentItem(commitment, graph, now);
    if (item) items.push(item);
  }

  for (const project of (graph.projects ?? []).filter((project) => project.status === 'active' && project.reviewGateAt)) {
    const days = daysUntilDate(project.reviewGateAt, now);
    if (days !== undefined && days <= 3) {
      items.push({
        id: `radar:project_gate:${project.id}`, userId: project.userId, type: 'upcoming',
        headline: days < 0 ? `${project.title} review gate is overdue` : `${project.title} reaches its review gate ${days === 0 ? 'today' : `in ${days} days`}`,
        summary: 'Use evidence to Promote, Maintain, or Park. Do not pivot because of mood or short-term volatility.', status: 'open',
        severity: days < 0 ? 'high' : 'medium', confidence: 1, importance: project.foreground ? 1 : 0.65,
        urgency: days <= 0 ? 0.9 : 0.7, goalAlignment: project.foreground ? 1 : 0.7, consequence: 0.7,
        sourceRefs: [{ sourceType: 'system', sourceRef: project.id, label: '30/60/90 review gate' }],
        reasonCodes: ['project.review_gate'], relatedGoalId: project.goalId, relatedProjectId: project.id,
        createdAt: now.toISOString(), firstRelevantAt: now.toISOString(),
      });
    }
  }

  items.push(...calendarConflictItems(graph, now));

  const unique = new Map<string, RadarItem>();
  for (const item of items) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()]
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || score(b) - score(a))
    .slice(0, maxItems);
}
