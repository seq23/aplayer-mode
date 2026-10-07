import { isExecutableActionTitle, reviewGateVerdict } from './methodology.js';
import type {
  CompletedEvidence,
  DailySupply,
  DailySupplyInput,
  GateKey,
  GateVerdictKey,
  GoalPlan,
  GoalPlanContext,
  MvdAction,
  PlanAction,
  PlanGate,
  PlanPillar,
  SuppliedAction,
  SupplyReason,
  Weekday,
} from './goal-plan-types.js';
import {
  BODY_PRESCRIPTION_PATTERN,
  BODY_SHAME_PATTERN,
  SECURITIES_PATTERN,
  addDays,
  daysBetween,
  recognizePersona,
  templateFor,
  type ActionSpec,
} from './goal-templates.js';

export * from './goal-plan-types.js';
export {
  BODY_PRESCRIPTION_PATTERN,
  BODY_SHAME_PATTERN,
  DOCTOR_LINE,
  SECURITIES_PATTERN,
  bodyRedFlags,
  parseWeightTarget,
  recognizePersona,
  weeklyRateCeiling,
} from './goal-templates.js';

export const PLAN_LENGTH_DAYS = 90;
export const MVD_MAX_MINUTES = 15;
export const ACTION_MAX_MINUTES = 240;
export const DECISION_ACTION_KEY = 'day90_decision';

const GATE_WINDOWS: Array<{ key: GateKey; label: PlanGate['label']; startDay: number; endDay: number }> = [
  { key: 'foundation', label: 'Foundation', startDay: 1, endDay: 30 },
  { key: 'build', label: 'Build', startDay: 31, endDay: 60 },
  { key: 'establish', label: 'Establish', startDay: 61, endDay: 90 },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): void {
  if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new Error(`${field} must be a YYYY-MM-DD calendar date`);
  }
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function weekdayOf(date: string): Weekday {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() as Weekday;
}

function renderTitle(template: string, minutes: number): string {
  return template.replace(/\{m\}/g, String(minutes));
}

function availableMinutes(context: Pick<GoalPlanContext, 'availability'>, weekday?: Weekday): number | undefined {
  const availability = context.availability;
  if (!availability) return undefined;
  const byDay = weekday === undefined ? undefined : availability.minutesByWeekday?.[weekday];
  return byDay ?? availability.defaultMinutes;
}

function capMinutes(full: number, mvd: number, available?: number): number {
  if (available === undefined || available >= full) return full;
  return Math.max(mvd, Math.floor(available));
}

const FLOOR_MINUTES = /(\d{1,3})\s*-?\s*(min|minute)/i;

function userFloorMvd(floor: string | undefined): MvdAction | undefined {
  if (!floor || !isExecutableActionTitle(floor)) return undefined;
  const minutes = Number(floor.match(FLOOR_MINUTES)?.[1] ?? 10);
  return {
    title: floor.trim(),
    output: 'Floor done and logged',
    durationMinutes: Math.max(1, Math.min(MVD_MAX_MINUTES, minutes)),
  };
}

function toPlanAction(spec: ActionSpec, context: GoalPlanContext, referral: boolean): PlanAction {
  const [mvdTitle, mvdOutput, mvdMinutes] = spec.mvd;
  const userMvd = referral && spec.pillar === 'body' ? undefined : userFloorMvd(context.minimumFloors?.[spec.pillar]);
  const mvd: MvdAction = userMvd ?? { title: mvdTitle, output: mvdOutput, durationMinutes: mvdMinutes };
  const durationMinutes = capMinutes(spec.minutes, mvd.durationMinutes, availableMinutes(context));
  const templated = spec.title.includes('{m}');
  return {
    key: spec.key,
    title: renderTitle(spec.title, durationMinutes),
    ...(templated ? { titleTemplate: spec.title } : {}),
    output: spec.output,
    durationMinutes,
    pillar: spec.pillar,
    satisfiesFloors: spec.satisfies ?? [],
    mvd,
  };
}

/**
 * Deterministic goal → 30/60/90 plan. There is no model refinement path: any future one
 * must re-validate every edit through validatePlan before it can be stored.
 */
export function generateGoalPlan(goalText: string, context: GoalPlanContext): GoalPlan {
  assertDate(context.startDate, 'startDate');
  if (context.targetDate) assertDate(context.targetDate, 'targetDate');
  const text = goalText.trim();
  if (!text) throw new Error('goalText is required');

  const persona = recognizePersona(text, context.roles ?? []);
  const template = templateFor(persona, text, context);
  const safety = { ...template.safety, reasonCodes: [...template.safety.reasonCodes], notes: [...template.safety.notes] };
  const id = `plan_${hash(`${text.toLowerCase()}|${context.startDate}|${template.key}`)}`;

  const actions: Record<string, PlanAction> = {};
  for (const spec of template.actions) actions[spec.key] = toPlanAction(spec, context, safety.referral);
  actions[DECISION_ACTION_KEY] = {
    key: DECISION_ACTION_KEY,
    title: 'Make the day-90 call for this goal: Promote, Maintain or Park, and write one line why',
    output: 'Verdict recorded with a one-line reason',
    durationMinutes: 20,
    pillar: template.pillar,
    satisfiesFloors: [],
    mvd: { title: 'Write Promote, Maintain or Park and one reason', output: 'Verdict recorded', durationMinutes: 5 },
  };

  for (const [pillar, floor] of Object.entries(context.minimumFloors ?? {})) {
    if (floor && !isExecutableActionTitle(floor)) {
      if (!safety.reasonCodes.includes('floor.needs_clarifying')) safety.reasonCodes.push('floor.needs_clarifying');
      safety.notes.push(`Your ${pillar} floor "${floor}" is not a physical action yet, so the template floor is used.`);
    }
  }

  const gates = GATE_WINDOWS.map((window, index): PlanGate => {
    const spec = template.gates[index];
    if (!spec) throw new Error(`template ${template.key} has no ${window.key} gate`);
    return {
      key: window.key,
      label: window.label,
      startDay: window.startDay,
      endDay: window.endDay,
      startDate: addDays(context.startDate, window.startDay - 1),
      endDate: addDays(context.startDate, window.endDay - 1),
      outcome: spec.outcome,
      milestones: spec.milestones.map(([day, title], m) => ({
        id: `${id}:${window.key}:m${m + 1}`,
        title,
        dueDay: day,
        dueDate: addDays(context.startDate, day - 1),
      })),
      weeklyCadence: spec.week.map((actionKey, weekday) => ({ weekday: weekday as Weekday, actionKey })),
    };
  }) as GoalPlan['gates'];

  return {
    id,
    version: 1,
    goalText: text,
    persona,
    foreground: { pillar: template.pillar, label: template.label },
    startDate: context.startDate,
    endDate: addDays(context.startDate, PLAN_LENGTH_DAYS - 1),
    ...(context.timezone ? { timezone: context.timezone } : {}),
    ...(context.availability ? { availability: context.availability } : {}),
    gates,
    actions,
    setup: template.setup.map((actionKey, i) => ({ day: i + 1, actionKey })),
    floors: [...template.floors],
    decision: {
      day: 90,
      date: addDays(context.startDate, PLAN_LENGTH_DAYS - 1),
      options: ['promote', 'maintain', 'park'],
      criteria: template.decisionCriteria,
      actionKey: DECISION_ACTION_KEY,
    },
    safety,
    provenance: { source: 'deterministic_template', templateKey: template.key },
  };
}

// ---------------------------------------------------------------------------
// Ambiguity Stop + safety validation
// ---------------------------------------------------------------------------

const VAGUE_OUTPUT = /^(progress|done|something|stuff|work|it|n\/a|tbd|complete|finished)\.?$/i;

/** BHPC Ambiguity Stop: a physical action with a specific output and a duration. */
export function actionAmbiguityProblem(action: MvdAction): string | null {
  if (!isExecutableActionTitle(action.title) || /\{m\}/.test(action.title)) {
    return `Ambiguity stop: "${action.title}" is not a physical action.`;
  }
  const output = action.output?.trim() ?? '';
  if (output.length < 6 || VAGUE_OUTPUT.test(output)) {
    return `Ambiguity stop: "${action.title}" has no observable output.`;
  }
  if (!Number.isInteger(action.durationMinutes) || action.durationMinutes < 1 || action.durationMinutes > ACTION_MAX_MINUTES) {
    return `Ambiguity stop: "${action.title}" needs a duration between 1 and ${ACTION_MAX_MINUTES} minutes.`;
  }
  return null;
}

/** Safety vocabulary check shared by generation and refinement. */
export function actionSafetyProblem(action: MvdAction): string | null {
  const text = `${action.title} ${action.output}`;
  if (BODY_PRESCRIPTION_PATTERN.test(text)) return `Safety: "${action.title}" prescribes diet or medication.`;
  if (BODY_SHAME_PATTERN.test(text)) return `Safety: "${action.title}" uses shame or appearance language.`;
  if (SECURITIES_PATTERN.test(text)) return `Safety: "${action.title}" gives securities or product advice.`;
  return null;
}

function actionProblems(action: PlanAction): string[] {
  const problems: string[] = [];
  for (const candidate of [action, action.mvd]) {
    const ambiguity = actionAmbiguityProblem(candidate);
    if (ambiguity) problems.push(`${action.key}: ${ambiguity}`);
    const unsafe = actionSafetyProblem(candidate);
    if (unsafe) problems.push(`${action.key}: ${unsafe}`);
  }
  if (action.mvd.durationMinutes > MVD_MAX_MINUTES) problems.push(`${action.key}: MVD is longer than ${MVD_MAX_MINUTES} minutes.`);
  if (action.mvd.durationMinutes > action.durationMinutes) problems.push(`${action.key}: MVD is longer than the full action.`);
  return problems;
}

/** Structural, Ambiguity Stop and safety checks. Empty array = valid plan. */
export function validatePlan(plan: GoalPlan): string[] {
  const problems: string[] = [];
  for (const action of Object.values(plan.actions)) problems.push(...actionProblems(action));
  const known = (key: string) => key in plan.actions;
  for (const gate of plan.gates) {
    if (gate.outcome.trim().length < 10) problems.push(`${gate.key}: gate has no outcome.`);
    if (gate.milestones.length < 1) problems.push(`${gate.key}: gate has no milestones.`);
    for (const milestone of gate.milestones) {
      if (milestone.dueDay < gate.startDay || milestone.dueDay > gate.endDay) {
        problems.push(`${gate.key}: milestone "${milestone.title}" falls outside the gate.`);
      }
    }
    const weekdays = new Set(gate.weeklyCadence.map((slot) => slot.weekday));
    if (weekdays.size !== 7) problems.push(`${gate.key}: weekly cadence does not cover all seven days.`);
    for (const slot of gate.weeklyCadence) if (!known(slot.actionKey)) problems.push(`${gate.key}: unknown action ${slot.actionKey}.`);
    if (SECURITIES_PATTERN.test(gate.outcome) || BODY_PRESCRIPTION_PATTERN.test(gate.outcome)) {
      problems.push(`${gate.key}: gate outcome fails the safety vocabulary.`);
    }
  }
  for (const entry of plan.setup) if (!known(entry.actionKey)) problems.push(`setup: unknown action ${entry.actionKey}.`);
  for (const floor of plan.floors) if (!known(floor)) problems.push(`floors: unknown action ${floor}.`);
  if (!known(plan.decision.actionKey)) problems.push('decision: day-90 action missing.');
  if (plan.persona.foregroundPersona === 'weight_loss' && !plan.safety.doctorLine) problems.push('safety: weight-loss plan has no doctor line.');
  return problems;
}

// ---------------------------------------------------------------------------
// Daily-action supplier
// ---------------------------------------------------------------------------

export function planDayIndex(plan: Pick<GoalPlan, 'startDate'>, date: string): number {
  return daysBetween(plan.startDate, date) + 1;
}

function gateForDay(plan: GoalPlan, dayIndex: number): PlanGate {
  return plan.gates.find((gate) => dayIndex >= gate.startDay && dayIndex <= gate.endDay) ?? plan.gates[2];
}

function cadenceAction(gate: PlanGate, weekday: Weekday): string {
  return gate.weeklyCadence.find((slot) => slot.weekday === weekday)!.actionKey;
}

function isDone(plan: GoalPlan, date: string, actionKey: string, completed: CompletedEvidence[]): boolean {
  const instanceId = `${plan.id}:${date}:${actionKey}`;
  return completed.some(
    (entry) => entry.instanceId === instanceId || (entry.date === date && entry.actionKey === actionKey),
  );
}

function supplied(
  plan: GoalPlan,
  action: PlanAction,
  input: { date: string; role: SuppliedAction['role']; scope: SuppliedAction['scope']; completed: CompletedEvidence[]; available?: number },
): SuppliedAction {
  const base = {
    instanceId: `${plan.id}:${input.date}:${action.key}`,
    actionKey: action.key,
    role: input.role,
    pillar: action.pillar,
    status: isDone(plan, input.date, action.key, input.completed) ? ('done' as const) : ('open' as const),
  };
  if (input.scope === 'mvd') {
    return { ...base, scope: 'mvd', title: action.mvd.title, output: action.mvd.output, durationMinutes: action.mvd.durationMinutes };
  }
  const minutes = capMinutes(action.durationMinutes, action.mvd.durationMinutes, input.available);
  const title = action.titleTemplate ? renderTitle(action.titleTemplate, minutes) : action.title;
  return { ...base, scope: 'standard', title, output: action.output, durationMinutes: minutes };
}

/**
 * Today's next action(s) for a plan. Exactly one foreground action, plus background floors.
 * - No Catch-Up: only today's slot is ever returned; missed days are never stacked.
 * - Never Miss Twice: the day after a miss runs at recovery (MVD) scope.
 * - MVD when mood ≤ 2 or in recovery.
 * Today never runs dry: before start, at day 90 and after the plan there is still an action.
 */
export function supplyDailyActions(plan: GoalPlan, input: DailySupplyInput): DailySupply {
  assertDate(input.date, 'date');
  const completed = input.completed ?? [];
  const dayIndex = planDayIndex(plan, input.date);
  const weekday = weekdayOf(input.date);
  const reasons: SupplyReason[] = [];

  let phase: DailySupply['phase'];
  let actionKey: string;
  let forcedScope: SuppliedAction['scope'] | undefined;

  if (dayIndex < 1) {
    phase = 'pre_start';
    actionKey = plan.setup[0]?.actionKey ?? cadenceAction(plan.gates[0], weekdayOf(plan.startDate));
    reasons.push('pre_start');
  } else if (dayIndex >= PLAN_LENGTH_DAYS && !input.decision) {
    phase = 'decision';
    actionKey = plan.decision.actionKey;
    reasons.push('day_90_decision');
  } else if (dayIndex > PLAN_LENGTH_DAYS || (dayIndex === PLAN_LENGTH_DAYS && input.decision)) {
    phase = 'post_plan';
    const establish = plan.gates[2];
    if (input.decision === 'park') {
      actionKey = plan.floors[0] ?? cadenceAction(establish, weekday);
      forcedScope = 'mvd';
      reasons.push('parked_background');
    } else {
      actionKey = cadenceAction(establish, weekday);
      if (input.decision === 'maintain') {
        forcedScope = 'mvd';
        reasons.push('maintained');
      } else {
        reasons.push('promoted');
      }
    }
  } else {
    const gate = gateForDay(plan, dayIndex);
    phase = gate.key;
    const setup = plan.setup.find((entry) => entry.day === dayIndex);
    actionKey = setup?.actionKey ?? cadenceAction(gate, weekday);
    reasons.push(setup ? 'setup' : 'weekly_cadence');
  }

  const recovery = input.state !== 'normal' || (input.mood !== undefined && input.mood <= 2);
  if (input.state === 'missed_yesterday') reasons.push('never_miss_twice', 'no_catch_up');
  if (input.state === 'recovery') reasons.push('recovery_mvd');
  if (input.mood !== undefined && input.mood <= 2) reasons.push('low_mood_mvd');
  const restDay = plan.setup.every((entry) => entry.day !== dayIndex) && (plan.availability?.restDays ?? []).includes(weekday);
  if (restDay) reasons.push('rest_day');
  if (plan.safety.referral) reasons.push('referral');

  const scope: SuppliedAction['scope'] = forcedScope ?? (recovery || restDay ? 'mvd' : 'standard');
  let foregroundAction = plan.actions[actionKey];
  if (!foregroundAction) throw new Error(`plan ${plan.id} has no action ${actionKey}`);
  // Under MVD scope the pillar's floor IS the minimum (Body Foundation: the movement floor).
  if (scope === 'mvd' && actionKey !== plan.decision.actionKey) {
    const pillarFloor = plan.floors.map((key) => plan.actions[key]).find((floor): floor is PlanAction => floor?.pillar === foregroundAction!.pillar);
    if (pillarFloor) foregroundAction = pillarFloor;
  }
  const available = availableMinutes(plan, weekday);
  const foreground = supplied(plan, foregroundAction, { date: input.date, role: 'foreground', scope, completed, available });
  reasons.push('one_foreground');

  const covered = new Set([foregroundAction.key, ...foregroundAction.satisfiesFloors]);
  const floors = plan.floors
    .filter((key) => !covered.has(key) && plan.actions[key] !== undefined)
    .map((key) =>
      supplied(plan, plan.actions[key]!, { date: input.date, role: 'floor', scope: recovery ? 'mvd' : 'standard', completed, available: undefined }),
    );
  if (floors.length > 0 || foregroundAction.satisfiesFloors.length > 0) reasons.push('floor_protected');

  return {
    planId: plan.id,
    date: input.date,
    dayIndex,
    phase,
    mode: recovery ? 'recovery' : 'standard',
    foreground,
    floors,
    reasons,
    dayComplete: foreground.status === 'done' && floors.every((floor) => floor.status === 'done'),
  };
}

// ---------------------------------------------------------------------------
// Gate reviews and the day-90 decision
// ---------------------------------------------------------------------------

export interface GateReviewInput {
  /** Days in the window with completed evidence (full day or MVD both count). */
  completedDays: number;
  evidenceCount: number;
  stillAligned: boolean;
}

function verdictFor(windowDays: number, input: GateReviewInput): GateVerdictKey {
  const progressScore = Math.round((Math.max(0, Math.min(windowDays, input.completedDays)) / windowDays) * 100) / 10;
  return reviewGateVerdict({ progressScore, evidenceCount: input.evidenceCount, stillAligned: input.stillAligned });
}

export function reviewPlanGate(plan: GoalPlan, gateKey: GateKey, input: GateReviewInput): GateVerdictKey {
  const gate = plan.gates.find((candidate) => candidate.key === gateKey)!;
  return verdictFor(gate.endDay - gate.startDay + 1, input);
}

/** The forced day-90 decision: Promote, Maintain or Park (parking is a valid outcome). */
export function decideAtDay90(plan: GoalPlan, input: GateReviewInput): GateVerdictKey {
  void plan;
  return verdictFor(PLAN_LENGTH_DAYS, input);
}


export type { PlanPillar };
