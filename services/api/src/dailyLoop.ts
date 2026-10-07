import type { DayRecord, Goal, LifeGraphSnapshot, StoredGoalPlan } from '@apm/domain';
import {
  calendarDateInTimezone,
  coachingCheckIn,
  composeAgenda,
  continuityView,
  detectDrift,
  firstWeekProgramme,
  weeklyReviewDue,
  deriveDayState,
  suggestPillarReview,
  verdictFromReview,
  bodyRedFlags,
  generateGoalPlan,
  isPlanEligible,
  planContextFromGraph,
  validatePlan,
  withCompletionStatus,
  type ContinuityDay,
  type DailyAgenda,
  type DayStateResult,
  type PillarReviewEntry,
  type GoalPlan,
  type PlanEntry,
  type TrackRuleContext,
} from '@apm/planning';
import type { ApiEnv } from './env';
import { flagBodyReferral, getGoalPlans, saveGoalPlan } from './dailyLoopRepository';
import { getLifeGraph } from './lifeGraphRepository';

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
    try { await saveGoalPlan(env, graph.identity.userId, goal.id, buildGoalPlan(graph, goal, now), 'backfill'); }
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
  /** The 7-day continuity snapshot (✅ / ⚡ / ❌), shown when the user's scoring config allows it. */
  continuity: ContinuityDay[];
  showContinuity: boolean;
  /** What the end-of-day close starts from: evidence, a suggested pillar review and the computed verdict. */
  closePreview: { pillarReview: PillarReviewEntry[]; computedVerdict: 'full_day' | 'mvd' | 'miss'; evidence: string[] };
  /** Phase Bridge: the Daily Stack opens after the First Hour begins. */
  phase?: 'first_hour' | 'executing';
  /** Hard Start: nothing but the opening step is served before the check-in. */
  redacted: boolean;
  drift: ReturnType<typeof detectDrift>;
  firstWeek?: ReturnType<typeof firstWeekProgramme>;
  coachingCheckIn: ReturnType<typeof coachingCheckIn>;
  weeklyReview: ReturnType<typeof weeklyReviewDue>;
  bodyReferral?: { since: string; source?: string };
}

export function criticalPillars(graph: Pick<LifeGraphSnapshot, 'pillarSettings'>) {
  return graph.pillarSettings.filter((pillar) => pillar.active && pillar.critical).map((pillar) => pillar.name);
}

export function closePreview(graph: LifeGraphSnapshot, agenda: DailyAgenda): TodayLoopState['closePreview'] {
  const critical = criticalPillars(graph);
  // Every active pillar is reviewed; only the critical ones decide the verdict.
  const active = graph.pillarSettings.filter((pillar) => pillar.active).map((pillar) => pillar.name);
  const pillarReview = suggestPillarReview(agenda, active.length ? active : critical);
  const evidence = [agenda.firstHour.priority, ...agenda.dailyStack].filter((item) => item?.status === 'done').map((item) => item!.title);
  return { pillarReview, computedVerdict: verdictFromReview(pillarReview, critical, agenda.mode === 'recovery'), evidence };
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
function carriedInto(graph: LifeGraphSnapshot, date: string) {
  const yesterday = graph.dayRecords.find((record) => record.day < date && record.closedAt && record.carryForward);
  return yesterday?.carryForward ? { text: yesterday.carryForward, fromDay: yesterday.day } : undefined;
}

function sameLocalDay(iso: string | undefined, date: string, timezone?: string): boolean {
  return Boolean(iso && calendarDateInTimezone(iso, timezone) === date);
}

/** What the active Tracks' rules need for `date` (packages/planning track-rules). */
export function trackContext(graph: LifeGraphSnapshot, date: string): TrackRuleContext {
  const timezone = graph.identity.timezone;
  return {
    active: graph.tracks.filter((track) => track.active).map((track) => track.key),
    roles: graph.roles.filter((role) => role.active).map((role) => role.name),
    settings: graph.personalOS?.trackSettings ?? {},
    referral: Boolean(graph.personalOS?.bodyReferral),
    ...(timezone ? { timezone } : {}),
    calendar: graph.calendarEvents
      .filter((event) => !event.deleted && !event.allDay && event.availability !== 'free' && sameLocalDay(event.startsAt, date, timezone))
      .map((event) => ({ title: event.title, startsAt: event.startsAt, endsAt: event.endsAt })),
    familyBlocks: (graph.lifeAdminItems ?? [])
      .filter((item) => item.kind === 'family_obligation' && item.startsAt && item.endsAt && !['completed', 'cancelled', 'paused'].includes(item.status) && sameLocalDay(item.startsAt, date, timezone))
      .map((item) => ({ title: item.title, startsAt: item.startsAt!, endsAt: item.endsAt! })),
    recentVerdicts: graph.dayRecords
      .filter((record) => record.day < date && record.verdict)
      .sort((a, b) => b.day.localeCompare(a.day))
      .map((record) => record.verdict!),
  };
}

export function freshAgenda(graph: LifeGraphSnapshot, input: { date: string; state: DayStateResult['state']; mood?: number }): DailyAgenda {
  const carryForward = carriedInto(graph, input.date);
  return composeAgenda({
    tracks: trackContext(graph, input.date),
    ...(carryForward ? { carryForward } : {}),
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

export function todayLoopState(graph: LifeGraphSnapshot, input: { now: Date; recoveryMode: boolean; lastCoachingAt?: string }): TodayLoopState {
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
    continuity: continuityView(graph.dayRecords, date),
    showContinuity: graph.personalOS?.scoringConfig.showSevenDaySnapshot ?? true,
    closePreview: closePreview(graph, agenda),
    ...(day?.phase ? { phase: day.phase } : {}),
    redacted: false,
    drift: detectDrift({ date, dayRecords: graph.dayRecords, completions: graph.planCompletions, firstActiveDay: firstActiveDay(planEntries(graph).filter((entry) => isPlanEligible(entry.record))) }),
    ...(firstWeekProgramme(graph.personalOS?.stabilizationStartedAt, date) ? { firstWeek: firstWeekProgramme(graph.personalOS?.stabilizationStartedAt, date) } : {}),
    coachingCheckIn: coachingCheckIn({ lastCoachingAt: input.lastCoachingAt, installedAt: graph.personalOS?.installedAt, today: date, afterDays: graph.personalOS?.accountability.coachingReminderAfterDays }),
    weeklyReview: weeklyReviewDue({ today: date, reviewDay: graph.personalOS?.weeklyCadence.reviewDay, reviews: graph.weeklyReviews }),
    ...(graph.personalOS?.bodyReferral ? { bodyReferral: graph.personalOS.bodyReferral } : {}),
  };
}

/**
 * Hard Start (BHPC accountability choice): before the opening step is confirmed the
 * server serves no execution detail at all — only the foreground's name and the check-in.
 */
export function redactForHardStart(state: TodayLoopState): TodayLoopState {
  if (state.dayStart !== 'hard' || state.checkedIn || state.closed) return state;
  return {
    ...state,
    redacted: true,
    agenda: { ...state.agenda, firstHour: { sequence: [] }, dailyStack: [], background: [], gateReviews: [], decisions: [], trackFlags: [] },
    closePreview: { ...state.closePreview, pillarReview: [], evidence: [] },
  };
}

/**
 * Body Foundation red-flag stop: a red flag in a diary entry, a day-close note or the
 * intake pauses body coaching until clinician clearance. Weight-loss plans are rebuilt
 * with the referral stop (book / confirm the clinician) through the governed RPC.
 */
export async function pauseBodyCoachingIfFlagged(
  env: ApiEnv, accessToken: string, userId: string, texts: Array<string | undefined>, source: 'intake' | 'diary' | 'day_close' | 'check_in', now: Date,
): Promise<boolean> {
  const flags = bodyRedFlags(texts.filter((text): text is string => Boolean(text?.trim())));
  if (!flags.length) return false;
  await flagBodyReferral(env, accessToken, source);
  await rebuildBodyPlans(env, accessToken, userId, 'referral', now);
  return true;
}

/** Rebuilds every live weight-loss plan from the current Personal OS (referral or clearance). */
export async function rebuildBodyPlans(env: ApiEnv, accessToken: string, userId: string, source: 'referral' | 'clearance', now: Date): Promise<void> {
  const graph = await getLifeGraph(env, accessToken, userId);
  for (const entry of planEntries(graph)) {
    if (entry.plan.persona.foregroundPersona !== 'weight_loss' || entry.record.status !== 'active') continue;
    const goal = graph.goals.find((candidate) => candidate.id === entry.record.goalId);
    if (!goal) continue;
    const plan = generateGoalPlan(goalText(goal), planContextFromGraph(graph, { startDate: localToday(graph, now), goal, ...(source === 'clearance' ? { clinicianCleared: true } : {}) }));
    await saveGoalPlan(env, userId, goal.id, plan, source);
  }
}
