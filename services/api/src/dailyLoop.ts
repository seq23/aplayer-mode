import type { DayRecord, Goal, LifeGraphSnapshot, StoredGoalPlan } from '@apm/domain';
import {
  calendarDateInTimezone,
  composeAgenda,
  deriveDayState,
  generateGoalPlan,
  isPlanEligible,
  planContextFromGraph,
  validatePlan,
  withCompletionStatus,
  type DailyAgenda,
  type DayStateResult,
  type GoalPlan,
  type PlanEntry,
} from '@apm/planning';
import type { ApiEnv } from './env';
import { getGoalPlans, saveGoalPlan } from './dailyLoopRepository';

/**
 * Server side of the BHPC daily loop. Deterministic: the planning package owns every
 * rule; this module only decides WHICH local day it is, reads the frozen agenda back
 * and hands the database a validated plan / agenda to persist.
 */

export function localToday(graph: Pick<LifeGraphSnapshot, 'identity'>, now: Date): string {
  return calendarDateInTimezone(now, graph.identity.timezone);
}

export function planEntries(graph: Pick<LifeGraphSnapshot, 'goalPlans'>): PlanEntry[] {
  return (graph.goalPlans as unknown as Array<StoredGoalPlan<GoalPlan>>).map((record) => ({ record, plan: record.plan }));
}

function goalText(goal: Pick<Goal, 'title' | 'outcome'>): string {
  const outcome = goal.outcome?.trim();
  return outcome && outcome.toLowerCase() !== goal.title.trim().toLowerCase() ? `${goal.title.trim()}. ${outcome}` : goal.title.trim();
}

/** Goal → validated 30/60/90 plan starting today (local). Throws if the engine output fails its own validation. */
export function buildGoalPlan(graph: LifeGraphSnapshot, goal: Pick<Goal, 'title' | 'outcome' | 'targetDate'>, now: Date): GoalPlan {
  const startDate = localToday(graph, now);
  const plan = generateGoalPlan(goalText(goal), planContextFromGraph(graph, { startDate, goal }));
  const problems = validatePlan(plan);
  if (problems.length) throw new Error(`goal_plan_invalid: ${problems[0]}`);
  return plan;
}

function entitled(graph: LifeGraphSnapshot): boolean {
  const entitlement = graph.entitlement;
  return Boolean(entitlement && (entitlement.status === 'active' || entitlement.status === 'trialing') && entitlement.plan !== 'household');
}

/**
 * Today never runs dry: every active goal of an installed Personal OS has a plan. Goals
 * created before migration 0021 (or by a path that skipped planning) get one here, once,
 * through the governed RPC (audited as `goal_plan.created`, source `backfill`).
 */
export async function ensureGoalPlans(env: ApiEnv, accessToken: string, graph: LifeGraphSnapshot, now: Date): Promise<LifeGraphSnapshot> {
  if (!graph.personalOS || !entitled(graph)) return graph;
  const planned = new Set(graph.goalPlans.map((plan) => plan.goalId));
  const missing = graph.goals.filter((goal) => goal.status === 'active' && !planned.has(goal.id));
  if (missing.length === 0) return graph;
  for (const goal of missing) {
    // One bad goal must never take Today down: it stays planless (and retried next read).
    try { await saveGoalPlan(env, accessToken, goal.id, buildGoalPlan(graph, goal, now), 'backfill'); }
    catch (error) { console.error('APM goal-plan backfill failed', { goalId: goal.id, message: (error as Error)?.message }); }
  }
  return { ...graph, goalPlans: await getGoalPlans(env, accessToken, graph.identity.userId) as unknown as StoredGoalPlan[] };
}

export interface TodayLoopState {
  date: string;
  agenda: DailyAgenda;
  dayState: DayStateResult;
  /** The agenda is frozen once the user checks in (No Mid-Day Negotiation). */
  locked: boolean;
  checkedIn: boolean;
  closed: boolean;
  dayStart: 'guided' | 'hard';
  day?: DayRecord;
}

function firstActiveDay(entries: PlanEntry[]): string | undefined {
  return entries.map((entry) => entry.record.startDate).sort()[0];
}

export function dayStateFor(graph: LifeGraphSnapshot, date: string, recoveryMode: boolean): DayStateResult {
  // Only plans still running count: a parked plan or a paused goal supplies nothing to miss.
  const running = planEntries(graph).filter((entry) => isPlanEligible(entry.record)
    && graph.goals.some((goal) => goal.id === entry.record.goalId && goal.status === 'active'));
  return deriveDayState({
    date,
    dayRecords: graph.dayRecords,
    completions: graph.planCompletions,
    firstActiveDay: firstActiveDay(running),
    recoveryMode,
  });
}

/** A fresh agenda for `date` from the persisted plans and evidence (used at check-in and declared replans). */
export function freshAgenda(graph: LifeGraphSnapshot, input: { date: string; state: DayStateResult['state']; mood?: number }): DailyAgenda {
  return composeAgenda({
    date: input.date,
    state: input.state,
    ...(input.mood !== undefined ? { mood: input.mood } : {}),
    plans: planEntries(graph),
    goals: graph.goals,
    foregroundGoalId: graph.personalOS?.foregroundGoalId,
    completions: graph.planCompletions,
    morningSequence: graph.personalOS?.morningSequence ?? [],
    nextActions: graph.nextActions,
  });
}

export function todayLoopState(graph: LifeGraphSnapshot, input: { now: Date; recoveryMode: boolean }): TodayLoopState {
  const date = localToday(graph, input.now);
  const day = graph.dayRecords.find((record) => record.day === date);
  const derived = dayStateFor(graph, date, input.recoveryMode);
  const lockedAgenda = day?.agendaStatus === 'locked' && day.agenda ? (day.agenda as unknown as DailyAgenda) : undefined;
  const dayState: DayStateResult = lockedAgenda ? { state: lockedAgenda.state, reason: derived.reason } : derived;
  const fresh = freshAgenda(graph, { date, state: lockedAgenda?.state ?? derived.state, mood: day?.mood });
  // The execution stack stays frozen; due gate / day-90 prompts are reconciled with the
  // current plan records so a review or decision made today disappears at once.
  const agenda = lockedAgenda
    ? { ...withCompletionStatus(lockedAgenda, graph.planCompletions, graph.nextActions), gateReviews: fresh.gateReviews, decisions: fresh.decisions }
    : fresh;
  return {
    date,
    agenda,
    dayState,
    locked: Boolean(lockedAgenda),
    checkedIn: Boolean(day?.checkedInAt),
    closed: Boolean(day?.closedAt),
    dayStart: graph.personalOS?.accountability.dayStart ?? 'guided',
    ...(day ? { day } : {}),
  };
}
