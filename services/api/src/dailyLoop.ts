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
import { bodyReplanDay, flagBodyReferral, getGoalPlans, markPillarRebuilt, pendingPillarRebuilds, saveGoalPlan, type PendingPillarRebuilds } from './dailyLoopRepository';
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
  // Reload whenever reconciliation attempted writes, even partially failed ones.
  if ((await reconcilePillarRebuilds(env, accessToken, graph.identity.userId)).attempted) {
    graph = { ...graph, goalPlans: await getGoalPlans(env, accessToken, graph.identity.userId) as unknown as StoredGoalPlan[] };
  }
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

/**
 * Rebuilds live plans from the current Personal OS WITHOUT restarting them: the plan keeps
 * its original start date, so its 90 days, gates and day index continue (the database
 * refuses a rebuild that moves the start: loop_plan_restart_refused, 0035).
 */
async function rebuildPlans(
  env: ApiEnv, accessToken: string, userId: string, source: 'referral' | 'clearance' | 'os_change',
  affected: (entry: ReturnType<typeof planEntries>[number]) => boolean, extra: { clinicianCleared?: boolean } = {},
  effective: PendingPillarRebuilds['effective'] = {},
): Promise<number> {
  const graph = withEffectivePillars(await getLifeGraph(env, accessToken, userId), effective);
  let rebuilt = 0;
  for (const entry of planEntries(graph)) {
    // Every plan still in execution: active, or decided to promote/maintain (never parked).
    if (!isPlanEligible(entry.record) || !affected(entry)) continue;
    const goal = graph.goals.find((candidate) => candidate.id === entry.record.goalId);
    if (!goal) continue;
    const plan = generateGoalPlan(goalText(goal), planContextFromGraph(graph, { startDate: entry.record.startDate, goal, ...extra }));
    await saveGoalPlan(env, userId, goal.id, plan, source);
    rebuilt += 1;
  }
  return rebuilt;
}

/** The graph as of today's pillar state: a later, not-yet-effective change is undone (0038). */
function withEffectivePillars(graph: LifeGraphSnapshot, effective: PendingPillarRebuilds['effective']): LifeGraphSnapshot {
  const names = Object.keys(effective);
  if (!names.length) return graph;
  const kept = graph.pillarSettings.filter((pillar) => !names.includes(pillar.name));
  const restored = names.flatMap((name) => {
    const row = effective[name];
    return row ? [{ userId: graph.identity.userId, name: row.name, active: row.active, critical: row.critical, ...(row.minimum_floor ? { minimumFloor: row.minimum_floor } : {}) }] : [];
  });
  return { ...graph, pillarSettings: [...kept, ...restored] as LifeGraphSnapshot['pillarSettings'] };
}

/**
 * Rebuilds every live weight-loss plan (referral or clearance), keeping its 90 days. A
 * referral or a clearance is a SAFETY change, so if today is already locked the rest of
 * today is replanned as a declared change (the only mid-day change BHPC allows): the
 * locked agenda then carries the rebuilt plan's actions and its safety state, instead of
 * actions the rebuilt plan no longer allows.
 */
export async function rebuildBodyPlans(env: ApiEnv, accessToken: string, userId: string, source: 'referral' | 'clearance', now: Date): Promise<void> {
  const rebuilt = await rebuildPlans(env, accessToken, userId, source, (entry) => entry.plan.persona.foregroundPersona === 'weight_loss',
    source === 'clearance' ? { clinicianCleared: true } : {});
  if (!rebuilt) return;
  const graph = await getLifeGraph(env, accessToken, userId);
  const date = localToday(graph, now);
  const day = graph.dayRecords.find((record) => record.day === date);
  if (!day?.checkedInAt || day.closedAt) return;
  const agenda = freshAgenda(graph, { date, state: source === 'referral' ? 'recovery' : day.dayState ?? 'normal', ...(day.mood !== undefined ? { mood: day.mood } : {}) });
  // Mandatory (0038): not limited by the declared-replan cap. If it still fails, the
  // locked agenda stays completable because the plan was rebuilt after the lock.
  try { await bodyReplanDay(env, userId, { day: date, source, agenda }); }
  catch (error) { console.error('APM body-safety replan failed; the locked agenda stays completable', { source, message: (error as Error)?.message }); }
}

/**
 * Applied pillar changes reach their plans on the effective date (0037): rebuilt once,
 * in place, then marked. A failure leaves the change pending and is retried on the next
 * read, so an applied change is never stranded half-done.
 */
export async function reconcilePillarRebuilds(env: ApiEnv, accessToken: string, userId: string): Promise<{ attempted: number; failed: number }> {
  if (!env.SUPABASE_SECRET_KEY) return { attempted: 0, failed: 0 };
  let pending: PendingPillarRebuilds;
  try { pending = await pendingPillarRebuilds(env, userId); }
  catch (error) { console.error('APM pillar rebuild check failed', { message: (error as Error)?.message }); return { attempted: 0, failed: 0 }; }
  let failed = 0;
  for (const change of pending.changes) {
    try {
      await rebuildPlansForPillar(env, accessToken, userId, change.pillar, pending.effective);
      await markPillarRebuilt(env, userId, change.id);
    } catch (error) {
      failed += 1;
      console.error('APM pillar rebuild failed; retried on the next read', { changeId: change.id, message: (error as Error)?.message });
    }
  }
  return { attempted: pending.changes.length, failed };
}

/** True while an in-effect pillar change has not reached its plans (a check-in must wait). */
export async function pillarRebuildsPending(env: ApiEnv, userId: string): Promise<boolean> {
  if (!env.SUPABASE_SECRET_KEY) return false;
  return (await pendingPillarRebuilds(env, userId)).changes.length > 0;
}

/**
 * A Drafting Room pillar change (its minimum floor) regenerates the floors of every live
 * plan that has actions in that pillar, keeping each plan's 90 days.
 */
export async function rebuildPlansForPillar(env: ApiEnv, accessToken: string, userId: string, pillar: string, effective: PendingPillarRebuilds['effective'] = {}): Promise<number> {
  return rebuildPlans(env, accessToken, userId, 'os_change', (entry) =>
    entry.plan.foreground.pillar === pillar || Object.values(entry.plan.actions).some((action) => action.pillar === pillar), {}, effective);
}
