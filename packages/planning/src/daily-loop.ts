import type {
  DayRecord,
  DayState,
  Goal,
  LifeGraphSnapshot,
  NextAction,
  PlanActionCompletion,
  PlanPillar,
  StoredGoalPlan,
} from '@apm/domain';
import {
  arbitrateForeground,
  canMiddayReplan,
  isExecutableActionTitle,
  scoreDay,
  type ArbitrationCandidate,
  type ArbitrationResult,
} from './methodology.js';
import { PLAN_LENGTH_DAYS, decideAtDay90, planDayIndex, reviewPlanGate, supplyDailyActions } from './goal-plan.js';
import type { DailySupply, GateKey, GateVerdictKey, GoalPlan, GoalPlanContext, SuppliedAction, Weekday } from './goal-plan-types.js';
import { addDays, daysBetween } from './goal-templates.js';
import { applyTrackRules, type TrackFlag, type TrackRuleContext } from './track-rules.js';
import { dailyPracticeFloors, practicesFromProfile } from './intake/profile.js';

/**
 * The BHPC daily loop, deterministic and model-free:
 *   day state (Never Miss Twice / Recovery / Mood Gate) → one foreground (Arbitration
 *   Engine) → today's supplied actions (No Catch-Up) → the printed agenda (Foreground
 *   Priority, First Hour, Daily Stack, Phase Bridge) → gate verdicts → day score.
 * Persistence and timezones are the API's job; every function here is pure.
 */

export interface PlanEntry {
  record: StoredGoalPlan<GoalPlan>;
  plan: GoalPlan;
}

export const PHASE_BRIDGE_QUESTION = 'Do you need coaching to clear any friction, or are you ready to begin your First Hour?';
export const MOOD_MVD_THRESHOLD = 2;
export const CARRY_FORWARD_ACTION_KEY = 'carry_forward';

// ---------------------------------------------------------------------------
// Plan context from the Life Graph
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES: Record<string, Weekday> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

export function weekdayFromName(name: string | undefined): Weekday | undefined {
  if (!name) return undefined;
  return WEEKDAY_NAMES[name.trim().toLowerCase()];
}

/** What the plan engine needs, read from the user's Personal OS (never from free text guesses). */
export function planContextFromGraph(
  graph: Pick<LifeGraphSnapshot, 'roles' | 'identity' | 'pillarSettings' | 'personalOS'>,
  input: { startDate: string; goal: Pick<Goal, 'targetDate'>; clinicianCleared?: boolean; healthNotes?: string[] },
): GoalPlanContext {
  const minimumFloors: GoalPlanContext['minimumFloors'] = {};
  for (const pillar of graph.pillarSettings) {
    if (pillar.active && pillar.minimumFloor?.trim()) minimumFloors[pillar.name] = pillar.minimumFloor.trim();
  }
  const recoveryDay = weekdayFromName(graph.personalOS?.weeklyCadence.recoveryDay);
  // Generated Mind / Spirit practices join the plan as daily floors (active areas only).
  const activeAreas = new Set(graph.pillarSettings.filter((setting) => setting.active).map((setting) => setting.name));
  const profile = graph.personalOS?.intakeProfile;
  const practices = profile
    ? dailyPracticeFloors(practicesFromProfile(profile, input.startDate, input.startDate).filter((p) => activeAreas.has(p.area)), input.startDate)
    : [];
  const healthNotes = [graph.personalOS?.bodyContext, ...(input.healthNotes ?? [])].filter((note): note is string => Boolean(note?.trim()));
  return {
    roles: graph.roles.filter((role) => role.active).map((role) => role.name),
    ...(graph.identity.timezone ? { timezone: graph.identity.timezone } : {}),
    startDate: input.startDate,
    ...(input.goal.targetDate ? { targetDate: input.goal.targetDate.slice(0, 10) } : {}),
    ...(recoveryDay !== undefined ? { availability: { restDays: [recoveryDay] } } : {}),
    constraints: graph.personalOS?.hardBoundaries ?? [],
    minimumFloors,
    ...(practices.length ? { practices } : {}),
    body: {
      healthNotes,
      ...(graph.personalOS?.bodyReferral ? { referralActive: true } : {}),
      ...(input.clinicianCleared || (graph.personalOS?.clinicianClearedAt && !graph.personalOS.bodyReferral) ? { clinicianCleared: true } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Day state
// ---------------------------------------------------------------------------

export interface DayStateInput {
  date: string;
  dayRecords: Pick<DayRecord, 'day' | 'verdict'>[];
  completions: Pick<PlanActionCompletion, 'day'>[];
  /** First local day the user had a plan running; days before it are never "missed". */
  firstActiveDay?: string;
  /** Recovery Mode declared (or the post-sprint recovery lock). */
  recoveryMode?: boolean;
}

export interface DayStateResult {
  state: DayState;
  /** Why: `declared_recovery`, `missed_yesterday_closed`, `missed_yesterday_unclosed`, or `normal`. */
  reason: 'declared_recovery' | 'missed_yesterday_closed' | 'missed_yesterday_unclosed' | 'normal';
}

/**
 * Never Miss Twice: a day closed as Miss, or a past day with no close and no
 * completion evidence, makes today a Recovery Day. A miss is data; the next day
 * is reduced, never doubled (No Catch-Up).
 */
export function deriveDayState(input: DayStateInput): DayStateResult {
  if (input.recoveryMode) return { state: 'recovery', reason: 'declared_recovery' };
  const yesterday = addDays(input.date, -1);
  if (input.firstActiveDay && yesterday < input.firstActiveDay) return { state: 'normal', reason: 'normal' };
  const record = input.dayRecords.find((candidate) => candidate.day === yesterday);
  if (record?.verdict === 'miss') return { state: 'missed_yesterday', reason: 'missed_yesterday_closed' };
  if (record?.verdict) return { state: 'normal', reason: 'normal' };
  const evidence = input.completions.some((completion) => completion.day === yesterday);
  if (!evidence && input.firstActiveDay) return { state: 'missed_yesterday', reason: 'missed_yesterday_unclosed' };
  return { state: 'normal', reason: 'normal' };
}

/**
 * The one Never Miss Twice rule over a Life Graph: yesterday decides, from the plans that
 * are still running (a parked plan or a paused goal supplies nothing to miss). Used by the
 * daily loop AND the daily plan projection, so the two can never disagree.
 */
export function dayStateFromGraph(
  graph: Pick<LifeGraphSnapshot, 'goalPlans' | 'goals' | 'dayRecords' | 'planCompletions'>,
  date: string,
  recoveryMode: boolean,
): DayStateResult {
  const running = (graph.goalPlans ?? []).filter((record) => isPlanEligible(record)
    && graph.goals.some((goal) => goal.id === record.goalId && goal.status === 'active'));
  return deriveDayState({
    date,
    dayRecords: graph.dayRecords,
    completions: graph.planCompletions ?? [],
    firstActiveDay: running.map((record) => record.startDate).sort()[0],
    recoveryMode,
  });
}

// ---------------------------------------------------------------------------
// One foreground: the Arbitration Engine
// ---------------------------------------------------------------------------

const PERSONA_LEVERAGE: Record<string, number> = {
  founder: 8, operator_promotion: 7, wealth_building: 7, weight_loss: 6, parent_plus: 7, generic: 5,
};
const PERSONA_COMPOUNDING: Record<string, number> = {
  founder: 8, operator_promotion: 7, wealth_building: 9, weight_loss: 8, parent_plus: 7, generic: 6,
};

/**
 * Billionaire High Performance Coach Track (BHPC v2.1 Appendix A, Track 1) shapes
 * project prioritisation: "prefer ownership to income", "favor asymmetric upside over
 * linear effort", "default to long-term compounding". Ownership plans gain leverage and
 * compounding; a linear-income plan loses leverage. The user's pinned foreground still wins.
 */
export const BILLIONAIRE_OWNERSHIP_PERSONAS = ['founder', 'wealth_building'] as const;
export const BILLIONAIRE_LINEAR_INCOME_PERSONAS = ['operator_promotion'] as const;
function billionaireAdjustment(persona: string, tracks: readonly string[] | undefined): { leverage: number; compounding: number } {
  if (!tracks?.includes('billionaire_mindset')) return { leverage: 0, compounding: 0 };
  if ((BILLIONAIRE_OWNERSHIP_PERSONAS as readonly string[]).includes(persona)) return { leverage: 2, compounding: 1 };
  if ((BILLIONAIRE_LINEAR_INCOME_PERSONAS as readonly string[]).includes(persona)) return { leverage: -1, compounding: 0 };
  return { leverage: 0, compounding: 0 };
}

export function isPlanEligible(record: Pick<StoredGoalPlan, 'status' | 'decision'>): boolean {
  return record.status !== 'superseded' && record.decision !== 'park';
}

function lastCompletionDay(planId: string, completions: PlanActionCompletion[]): string | undefined {
  return completions.filter((completion) => completion.planId === planId).map((completion) => completion.day).sort().at(-1);
}

/** Deterministic scores for the five BHPC factors. Fake urgency (no external date) scores 0. */
export function arbitrationCandidate(
  entry: PlanEntry,
  goal: Pick<Goal, 'targetDate' | 'priority'> | undefined,
  context: { date: string; mood?: number; completions: PlanActionCompletion[]; trackKeys?: readonly string[] },
): ArbitrationCandidate {
  const persona = entry.plan.persona.key;
  // A parent/caregiver wrapper (parent_plus) keeps the real goal persona in foregroundPersona.
  const track = billionaireAdjustment(entry.plan.persona.foregroundPersona ?? persona, context.trackKeys);
  const daysToTarget = goal?.targetDate ? daysBetween(context.date, goal.targetDate.slice(0, 10)) : undefined;
  const urgency = daysToTarget === undefined ? 0 : daysToTarget <= 14 ? 9 : daysToTarget <= 30 ? 7 : daysToTarget <= 60 ? 5 : 3;
  const supply = supplyDailyActions(entry.plan, { date: context.date, state: 'normal' });
  const minutes = supply.foreground.durationMinutes;
  const energy = context.mood === undefined ? 6 : context.mood <= 4 ? (minutes <= 20 ? 8 : 3) : minutes >= 30 ? 8 : 6;
  const last = lastCompletionDay(entry.record.id, context.completions);
  const idleDays = last ? daysBetween(last, context.date) : planDayIndex(entry.plan, context.date);
  return {
    id: entry.record.id,
    leverage: (PERSONA_LEVERAGE[persona] ?? 5) + (goal?.priority === 1 ? 1 : 0) + track.leverage,
    urgency,
    energyMatch: energy,
    compounding: (PERSONA_COMPOUNDING[persona] ?? 6) + track.compounding,
    downside: idleDays >= 3 ? 8 : 4,
  };
}

export interface ForegroundSelection {
  foreground?: PlanEntry;
  background: PlanEntry[];
  arbitration?: ArbitrationResult;
  /** `pinned` = the user's declared foreground goal; `arbitration` = the engine chose. */
  source?: 'pinned' | 'arbitration' | 'only_plan';
}

/**
 * Exactly ONE foreground. The user's declared foreground goal keeps it (Strategic
 * Patience: no daily flip-flopping); otherwise the Arbitration Engine picks among the
 * eligible plans. Parked and superseded plans are never foreground.
 */
export function selectForeground(input: {
  plans: PlanEntry[];
  goals: Pick<Goal, 'id' | 'targetDate' | 'priority' | 'status'>[];
  foregroundGoalId?: string;
  date: string;
  mood?: number;
  completions: PlanActionCompletion[];
  /** Active Track keys: Track rules shape arbitration (Billionaire Mindset). */
  trackKeys?: readonly string[];
}): ForegroundSelection {
  const eligible = input.plans.filter((entry) => {
    if (!isPlanEligible(entry.record)) return false;
    const goal = input.goals.find((candidate) => candidate.id === entry.record.goalId);
    return !goal || goal.status === 'active';
  });
  if (eligible.length === 0) return { background: [] };
  const pinned = input.foregroundGoalId ? eligible.find((entry) => entry.record.goalId === input.foregroundGoalId) : undefined;
  if (pinned) return { foreground: pinned, background: eligible.filter((entry) => entry !== pinned), source: 'pinned' };
  if (eligible.length === 1) return { foreground: eligible[0], background: [], source: 'only_plan' };
  const arbitration = arbitrateForeground(
    eligible.map((entry) => arbitrationCandidate(entry, input.goals.find((goal) => goal.id === entry.record.goalId), input)),
  );
  const winner = eligible.find((entry) => entry.record.id === arbitration.winnerId)!;
  return { foreground: winner, background: eligible.filter((entry) => entry !== winner), arbitration, source: 'arbitration' };
}

// ---------------------------------------------------------------------------
// The printed agenda
// ---------------------------------------------------------------------------

export type AgendaItemKind = 'plan_action' | 'plan_floor' | 'next_action' | 'track_floor' | 'carry_forward';

export interface AgendaItem {
  id: string;
  kind: AgendaItemKind;
  title: string;
  output?: string;
  durationMinutes?: number;
  pillar?: PlanPillar;
  planId?: string;
  goalId?: string;
  actionKey?: string;
  nextActionId?: string;
  scope?: 'standard' | 'mvd';
  status: 'open' | 'done';
  reasonCodes: string[];
}

export interface GateReviewDue {
  planId: string;
  gate: GateKey;
  label: string;
  recommended: GateVerdictKey;
  completedDays: number;
  evidenceCount: number;
}

export interface DecisionDue {
  planId: string;
  goalId: string;
  recommended: GateVerdictKey;
  completedDays: number;
  evidenceCount: number;
  criteria: string[];
}

export interface DailyAgenda {
  version: 1;
  date: string;
  state: DayState;
  mode: 'standard' | 'recovery';
  mood?: number;
  dayIndex?: number;
  phase?: DailySupply['phase'];
  foregroundPriority?: { planId: string; goalId: string; label: string; pillar: PlanPillar; source: ForegroundSelection['source'] };
  firstHour: { sequence: string[]; priority?: AgendaItem };
  dailyStack: AgendaItem[];
  /** Background plans that only get maintenance today. */
  background: Array<{ planId: string; goalId: string; label: string }>;
  arbitration?: ArbitrationResult;
  /** Due 30/60 gate reviews across all live plans. */
  gateReviews: GateReviewDue[];
  /** Due day-90 decisions across all live plans. */
  decisions: DecisionDue[];
  reasons: string[];
  bridge: string;
  /** Agenda-quality problems (Invalid Agenda clause). Empty = valid. */
  problems: string[];
  /** What the active Tracks challenge today (reason codes body.* / home.* / wealth.* …). */
  trackFlags: TrackFlag[];
  safety: { referral: boolean; doctorLine?: string; notes: string[] };
}

export interface AgendaInput {
  date: string;
  state: DayState;
  mood?: number;
  plans: PlanEntry[];
  goals: Pick<Goal, 'id' | 'targetDate' | 'priority' | 'status' | 'title'>[];
  foregroundGoalId?: string;
  completions: PlanActionCompletion[];
  morningSequence: string[];
  nextActions?: Pick<NextAction, 'id' | 'title' | 'goalId' | 'status' | 'estimatedMinutes'>[];
  /** The one item yesterday's close carried forward. */
  carryForward?: { text: string; fromDay: string };
  /** Active Tracks and what their rules need (track-rules.ts). */
  tracks?: TrackRuleContext;
}

function completionsFor(entry: PlanEntry, completions: PlanActionCompletion[]) {
  return completions
    .filter((completion) => completion.planId === entry.record.id)
    .map((completion) => ({ date: completion.day, actionKey: completion.actionKey }));
}

function itemFromSupplied(entry: PlanEntry, action: SuppliedAction, kind: AgendaItemKind, reasonCodes: string[]): AgendaItem {
  return {
    id: `plan:${entry.record.id}:${action.actionKey}`,
    kind,
    title: action.title,
    output: action.output,
    durationMinutes: action.durationMinutes,
    pillar: action.pillar,
    planId: entry.record.id,
    goalId: entry.record.goalId,
    actionKey: action.actionKey,
    scope: action.scope,
    status: action.status,
    reasonCodes,
  };
}

/** Distinct days with evidence and the evidence count for one plan inside [from, to]. */
export function planEvidenceStats(planId: string, completions: PlanActionCompletion[], from: string, to: string) {
  const inWindow = completions.filter((completion) => completion.planId === planId && completion.day >= from && completion.day <= to);
  return { completedDays: new Set(inWindow.map((completion) => completion.day)).size, evidenceCount: inWindow.length };
}

function gateReviewDue(entry: PlanEntry, date: string, completions: PlanActionCompletion[]): GateReviewDue | undefined {
  const dayIndex = planDayIndex(entry.plan, date);
  for (const gate of entry.plan.gates.slice(0, 2)) {
    if (dayIndex < gate.endDay || entry.record.gateReviews?.[gate.key]) continue;
    const stats = planEvidenceStats(entry.record.id, completions, gate.startDate, gate.endDate);
    return {
      planId: entry.record.id,
      gate: gate.key,
      label: `${gate.endDay}-day gate (${gate.label})`,
      recommended: reviewPlanGate(entry.plan, gate.key, { ...stats, stillAligned: true }),
      ...stats,
    };
  }
  return undefined;
}

/**
 * Build today's agenda. One foreground action from the foreground plan; background
 * plans contribute only their floors at MVD scope; nothing from a missed day is ever
 * re-supplied (No Catch-Up).
 */
export function composeAgenda(input: AgendaInput): DailyAgenda {
  const selection = selectForeground({ ...input, ...(input.tracks ? { trackKeys: input.tracks.active } : {}) });
  const reasons = new Set<string>();
  if (selection.source === 'arbitration' && input.tracks?.active.includes('billionaire_mindset')) reasons.add('track.billionaire.arbitration');
  const dailyStack: AgendaItem[] = [];
  let priority: AgendaItem | undefined;
  let supply: DailySupply | undefined;
  // Gates and the day-90 decision come due for EVERY live plan, foreground or background.
  const gateReviews: GateReviewDue[] = [];
  const decisions: DecisionDue[] = [];
  for (const entry of [selection.foreground, ...selection.background].filter((candidate): candidate is PlanEntry => Boolean(candidate))) {
    const due = gateReviewDue(entry, input.date, input.completions);
    if (due) gateReviews.push(due);
    if (entry.record.status === 'active' && planDayIndex(entry.plan, input.date) >= PLAN_LENGTH_DAYS) {
      const stats = planEvidenceStats(entry.record.id, input.completions, entry.plan.startDate, entry.plan.endDate);
      decisions.push({
        planId: entry.record.id,
        goalId: entry.record.goalId,
        recommended: decideAtDay90(entry.plan, { ...stats, stillAligned: true }),
        criteria: entry.plan.decision.criteria,
        ...stats,
      });
    }
  }
  const safetyNotes: string[] = [];
  let referral = false;
  let doctorLine: string | undefined;

  const lowDay = input.state !== 'normal' || (input.mood !== undefined && input.mood <= MOOD_MVD_THRESHOLD);

  if (selection.foreground) {
    const entry = selection.foreground;
    supply = supplyDailyActions(entry.plan, {
      date: input.date,
      state: input.state,
      mood: input.mood,
      completed: completionsFor(entry, input.completions),
      decision: entry.record.decision,
    });
    for (const reason of supply.reasons) reasons.add(reason);
    priority = itemFromSupplied(entry, supply.foreground, 'plan_action', supply.reasons);
    const coveredPillars = new Set<PlanPillar>([supply.foreground.pillar]);
    // MVD (mood ≤ 2, missed yesterday, Recovery) is ONE meaningful action (BHPC Law 6): the
    // other floors, background maintenance and the open backlog wait for a normal day.
    if (!lowDay) {
      for (const floor of supply.floors) {
        coveredPillars.add(floor.pillar);
        dailyStack.push(itemFromSupplied(entry, floor, 'plan_floor', ['floor_protected']));
      }
    } else if (supply.floors.length) {
      reasons.add('floors_held_mvd');
    }
    if (!lowDay) {
      for (const background of selection.background) {
        const backgroundSupply = supplyDailyActions(background.plan, {
          date: input.date,
          state: 'recovery',
          completed: completionsFor(background, input.completions),
          decision: background.record.decision,
        });
        // Under recovery scope the supplier may substitute a floor for the foreground; keep it.
        const maintenance = [backgroundSupply.foreground, ...backgroundSupply.floors].filter((action) => background.plan.floors.includes(action.actionKey));
        for (const floor of maintenance) {
          if (coveredPillars.has(floor.pillar)) continue;
          coveredPillars.add(floor.pillar);
          dailyStack.push(itemFromSupplied(background, floor, 'plan_floor', ['background_maintenance']));
        }
        reasons.add('background_maintenance');
      }
    } else if (selection.background.length) {
      reasons.add('background_held_mvd');
    }
    if (selection.arbitration) reasons.add('arbitration');
    referral = entry.plan.safety.referral;
    doctorLine = entry.plan.safety.doctorLine;
    safetyNotes.push(...entry.plan.safety.notes);
  }

  for (const action of lowDay ? [] : input.nextActions ?? []) {
    if (action.status !== 'open') continue;
    if (!isExecutableActionTitle(action.title)) continue;
    dailyStack.push({
      id: `next_action:${action.id}`,
      kind: 'next_action',
      title: action.title,
      ...(action.estimatedMinutes ? { durationMinutes: action.estimatedMinutes } : {}),
      goalId: action.goalId,
      nextActionId: action.id,
      status: 'open',
      reasonCodes: ['user_next_action'],
    });
  }

  // Carry-forward is a named intention, never debt: it joins a normal day's stack once,
  // and a recovery / MVD day holds it (No Catch-Up).
  if (input.carryForward && input.carryForward.fromDay === addDays(input.date, -1)) {
    if (lowDay) {
      reasons.add('carry_forward_held');
    } else {
      dailyStack.push({
        id: 'carry_forward',
        kind: 'carry_forward',
        title: input.carryForward.text,
        output: 'Carried item done',
        durationMinutes: 15,
        ...(selection.foreground ? { planId: selection.foreground.record.id, goalId: selection.foreground.record.goalId } : {}),
        actionKey: CARRY_FORWARD_ACTION_KEY,
        status: input.completions.some((c) => c.day === input.date && c.actionKey === CARRY_FORWARD_ACTION_KEY) ? 'done' : 'open',
        reasonCodes: ['carry_forward'],
      });
      reasons.add('carry_forward');
    }
  }

  if (lowDay && (input.nextActions ?? []).some((action) => action.status === 'open')) reasons.add('backlog_held_mvd');
  const recovery = supply?.mode === 'recovery' || lowDay;
  const agenda: DailyAgenda = {
    version: 1,
    date: input.date,
    state: input.state,
    mode: recovery ? 'recovery' : 'standard',
    ...(input.mood !== undefined ? { mood: input.mood } : {}),
    ...(supply ? { dayIndex: supply.dayIndex, phase: supply.phase } : {}),
    ...(selection.foreground
      ? {
          foregroundPriority: {
            planId: selection.foreground.record.id,
            goalId: selection.foreground.record.goalId,
            label: input.goals.find((goal) => goal.id === selection.foreground!.record.goalId)?.title ?? selection.foreground.plan.foreground.label,
            pillar: selection.foreground.plan.foreground.pillar,
            source: selection.source,
          },
        }
      : {}),
    firstHour: { sequence: input.morningSequence.slice(0, 5), ...(priority ? { priority } : {}) },
    dailyStack,
    background: selection.background.map((entry) => ({
      planId: entry.record.id,
      goalId: entry.record.goalId,
      label: input.goals.find((goal) => goal.id === entry.record.goalId)?.title ?? entry.plan.foreground.label,
    })),
    ...(selection.arbitration ? { arbitration: selection.arbitration } : {}),
    gateReviews,
    decisions,
    reasons: [...reasons],
    bridge: PHASE_BRIDGE_QUESTION,
    problems: [],
    trackFlags: [],
    safety: { referral, ...(doctorLine ? { doctorLine } : {}), notes: safetyNotes },
  };
  if (input.tracks) {
    const shaped = applyTrackRules(agenda, input.tracks, lowDay);
    shaped.agenda.trackFlags = shaped.flags;
    for (const flag of shaped.flags) shaped.agenda.reasons.push(flag.code);
    shaped.agenda.problems = validateAgenda(shaped.agenda);
    return shaped.agenda;
  }
  agenda.problems = validateAgenda(agenda);
  return agenda;
}

/** Every actionable item on the agenda, foreground first. */
export function agendaItems(agenda: Pick<DailyAgenda, 'firstHour' | 'dailyStack'>): AgendaItem[] {
  return [...(agenda.firstHour.priority ? [agenda.firstHour.priority] : []), ...agenda.dailyStack];
}

// ---------------------------------------------------------------------------
// Invalid Agenda clause
// ---------------------------------------------------------------------------

/** Generic busywork an agenda must never print (BHPC Part VI §4: "Review goals" is a system failure). */
export const GENERIC_AGENDA_PATTERNS = [
  /^review (your |my )?(goals?|plan|priorities)\b/i,
  /^(be|stay) (productive|focused|positive|motivated)\b/i,
  /^(check|process) (email|inbox)$/i,
  /^(plan|organi[sz]e) (the|your|my) (day|week)$/i,
  /^(do|get) (some|more) (work|stuff|things)\b/i,
  /^(keep|continue) going\b/i,
  /^reflect\b/i,
];

export function isGenericAgendaTitle(title: string): boolean {
  const normalized = title.trim();
  return !isExecutableActionTitle(normalized) || GENERIC_AGENDA_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function agendaItemProblem(item: AgendaItem): string | null {
  if (isGenericAgendaTitle(item.title)) return `"${item.title}" is not a physical action.`;
  if (item.kind === 'plan_action' || item.kind === 'plan_floor' || item.kind === 'track_floor') {
    if (!item.output || item.output.trim().length < 6) return `"${item.title}" has no observable output.`;
    if (!item.durationMinutes || item.durationMinutes < 1) return `"${item.title}" has no time box.`;
  }
  return null;
}

/** An agenda that does not reduce cognitive load is invalid. Empty array = valid. */
export function validateAgenda(agenda: Pick<DailyAgenda, 'firstHour' | 'dailyStack' | 'foregroundPriority'>): string[] {
  const problems: string[] = [];
  if (agenda.foregroundPriority && !agenda.firstHour.priority) problems.push('No foreground action: the First Hour has nothing to execute.');
  for (const item of agendaItems(agenda)) {
    const problem = agendaItemProblem(item);
    if (problem) problems.push(problem);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Completion status, No Mid-Day Negotiation, day score
// ---------------------------------------------------------------------------

/** Re-applies today's completion evidence to a (frozen) agenda snapshot. */
export function withCompletionStatus(agenda: DailyAgenda, completions: PlanActionCompletion[], nextActions: Pick<NextAction, 'id' | 'status'>[] = []): DailyAgenda {
  const done = (item: AgendaItem): AgendaItem['status'] => {
    if (item.planId && item.actionKey) {
      return completions.some((completion) => completion.planId === item.planId && completion.actionKey === item.actionKey && completion.day === agenda.date) ? 'done' : item.status;
    }
    if (item.nextActionId) return nextActions.find((action) => action.id === item.nextActionId)?.status === 'done' ? 'done' : item.status;
    return item.status;
  };
  return {
    ...agenda,
    firstHour: { ...agenda.firstHour, ...(agenda.firstHour.priority ? { priority: { ...agenda.firstHour.priority, status: done(agenda.firstHour.priority) } } : {}) },
    dailyStack: agenda.dailyStack.map((item) => ({ ...item, status: done(item) })),
  };
}

// ---------------------------------------------------------------------------
// End-of-day close (BHPC Prompt #6)
// ---------------------------------------------------------------------------

export type PillarScore = 'hit' | 'partial' | 'miss';
export interface PillarReviewEntry { pillar: PlanPillar; score: PillarScore; completed?: string }

/** Compensation after a slip ("double session", "skip a meal") is never a carry-forward (No Catch-Up, Body Foundation). */
export const COMPENSATION_PATTERN = /\b(double|twice as|extra|make up|makeup|catch[- ]?up|skip (a |the )?(meal|breakfast|lunch|dinner)|fast(ing)? (all|the whole) day|punish|burn (it )?off)\b/i;

export function carryForwardProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 5 || trimmed.length > 200) return 'A carry-forward item is one short physical action (5–200 characters).';
  if (isGenericAgendaTitle(trimmed)) return 'Ambiguity stop: name the physical action, not a theme.';
  if (COMPENSATION_PATTERN.test(trimmed)) return 'No Catch-Up: tomorrow does not pay for today. Carry one normal action, not a make-up.';
  return null;
}

/**
 * Pillar-by-pillar review suggested from the day's evidence; the user may change any
 * score. Only pillars the agenda actually carried are scored: the engine chose the
 * agenda, so a pillar it left off is not applicable today, never a miss.
 */
export function suggestPillarReview(agenda: DailyAgenda): PillarReviewEntry[] {
  const items = agendaItems(agenda).filter((item) => item.pillar);
  const order = [...new Set(items.map((item) => item.pillar!))];
  return order.map((pillar) => {
    const forPillar = items.filter((item) => item.pillar === pillar);
    const done = forPillar.filter((item) => item.status === 'done');
    const score: PillarScore = done.length === 0 ? 'miss' : done.length === forPillar.length ? 'hit' : 'partial';
    return { pillar, score, ...(done.length ? { completed: done.map((item) => item.title).join('; ').slice(0, 300) } : {}) };
  });
}

export interface ContinuityDay { day: string; verdict?: 'full_day' | 'mvd' | 'miss'; symbol: '✅' | '⚡' | '❌' | '·' }

/** The 7-day continuity snapshot, oldest first, ending today. */
export function continuityView(dayRecords: Pick<DayRecord, 'day' | 'verdict'>[], today: string): ContinuityDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const day = addDays(today, index - 6);
    const verdict = dayRecords.find((record) => record.day === day)?.verdict;
    const symbol = verdict === 'full_day' ? '✅' : verdict === 'mvd' ? '⚡' : verdict === 'miss' ? '❌' : '·';
    return { day, ...(verdict ? { verdict } : {}), symbol };
  });
}

/** One behavioural pattern, named without judgement (no gap analysis, no shame). */
export function dayInsight(continuity: ContinuityDay[], verdict: 'full_day' | 'mvd' | 'miss'): string {
  const shown = continuity.filter((day) => day.verdict);
  const counted = shown.filter((day) => day.verdict !== 'miss').length;
  if (verdict === 'miss') return 'A miss is data. Tomorrow starts as a Recovery Day: one small thing, then close.';
  if (verdict === 'mvd') return `Minimum Viable Day kept the chain: ${counted} of the last ${Math.max(shown.length, 1)} recorded days counted.`;
  const streak = [...continuity].reverse().findIndex((day) => !day.verdict || day.verdict === 'miss');
  const run = streak === -1 ? continuity.length : streak;
  return run >= 3 ? `${run} days in a row that counted. Keep it boring.` : `${counted} of the last ${Math.max(shown.length, 1)} recorded days counted. Continuity beats intensity.`;
}

export type ReplanReason = 'external_change' | 'safety' | 'permission' | 'mood' | 'discomfort';

export interface ReplanDecision {
  allowed: boolean;
  code: 'replan_allowed' | 'no_midday_negotiation';
  message: string;
}

/** Law 4: the morning plan stands. Only a real external change, safety or permission reopens it. */
export function midDayReplanDecision(reason: ReplanReason): ReplanDecision {
  if (canMiddayReplan(reason)) {
    return { allowed: true, code: 'replan_allowed', message: 'Declared change accepted. Today is rebuilt from your plan; nothing from earlier is carried as debt.' };
  }
  return {
    allowed: false,
    code: 'no_midday_negotiation',
    message: 'The plan was made this morning and it stands. If it feels heavy, do the smallest version of the next item and close the day. Tomorrow is rebuilt automatically.',
  };
}

/**
 * The day's computed verdict, from the locked agenda's evidence (the one rule the API
 * uses for every close). Critical pillars ON the agenda must be done for a Full Day; a
 * critical pillar the agenda did not carry is not required. On a recovery day the one
 * MVD action is the win. Continuity > Intensity: a normal day with any completed
 * action is at least an MVD, never a Miss ("10% is better than 0%").
 */
export function scoreAgendaDay(
  agenda: DailyAgenda,
  criticalPillars: PlanPillar[],
): { verdict: 'full_day' | 'mvd' | 'miss'; requiredCritical: number; completedCritical: number; mvdActionCompleted: boolean } {
  const items = agendaItems(agenda).filter((item) => item.kind !== 'next_action');
  const critical = new Set<PlanPillar>(criticalPillars);
  const criticalItems = items.filter((item) => item.pillar && critical.has(item.pillar));
  const requiredPillars = new Set<PlanPillar>(criticalItems.map((item) => item.pillar!));
  const completedPillars = new Set<PlanPillar>(criticalItems.filter((item) => item.status === 'done').map((item) => item.pillar!));
  const mvdActionCompleted = agenda.firstHour.priority?.status === 'done' || items.some((item) => item.status === 'done');
  const scored = scoreDay({
    completedCritical: completedPillars.size,
    requiredCritical: requiredPillars.size,
    recoveryMode: agenda.mode === 'recovery',
    mvdActionCompleted,
  });
  const verdict = scored === 'miss' && mvdActionCompleted ? 'mvd' : scored;
  return { verdict, requiredCritical: requiredPillars.size, completedCritical: completedPillars.size, mvdActionCompleted };
}

/** Days since the plan started, clamped to the plan window (for display). */
export function planProgress(plan: GoalPlan, date: string): { dayIndex: number; of: number } {
  return { dayIndex: Math.max(0, Math.min(PLAN_LENGTH_DAYS, planDayIndex(plan, date))), of: PLAN_LENGTH_DAYS };
}
