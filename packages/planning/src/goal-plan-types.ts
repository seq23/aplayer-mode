import type { DayState, PlanPillar } from '@apm/domain';

/**
 * Goal → plan engine types (BHPC Part VII: 30/60/90 gates, one foreground,
 * Promote/Maintain/Park). Pure data; no persistence or LLM concerns here.
 */

/** Plan-level pillar: the four life pillars plus the Home Front `family` floor (domain `PlanPillar`). */
export type { PlanPillar };

export type PersonaKey =
  | 'weight_loss'
  | 'wealth_building'
  | 'founder'
  | 'operator_promotion'
  | 'parent_plus'
  | 'generic';

export type GenericKind = 'race' | 'exam' | 'creative_release' | 'other';

/** The persona that owns the foreground (never `parent_plus`; that is a wrapper). */
export type ForegroundPersonaKey = Exclude<PersonaKey, 'parent_plus'>;

export interface PersonaMatch {
  key: PersonaKey;
  /** For parent_plus: the second game that gets the foreground. Otherwise equals `key`. */
  foregroundPersona: ForegroundPersonaKey;
  genericKind?: GenericKind;
  /** Human-readable trace of what matched (keyword or role). */
  matchedBy: string[];
}

/** 0 = Sunday … 6 = Saturday (UTC weekday of the calendar date). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GoalPlanAvailability {
  /** Minutes available for the foreground action on each weekday. */
  minutesByWeekday?: Partial<Record<Weekday, number>>;
  /** Fallback minutes for weekdays not listed above. */
  defaultMinutes?: number;
  /** Weekdays that run at MVD scope by design. */
  restDays?: Weekday[];
}

export interface BodyContext {
  currentWeight?: number;
  unit?: 'lb' | 'kg';
  /** User-chosen weigh-in cadence; the app never insists on daily weighing. */
  weighInCadence?: 'weekly' | 'none';
  /** User confirms a clinician supervises a faster pace. */
  clinicianSupervised?: boolean;
  /** User confirms clinician clearance after a red flag; lifts the referral stop. */
  clinicianCleared?: boolean;
  /** A red flag recorded earlier (diary, check-in, close) is still active: the pause persists. */
  referralActive?: boolean;
  /** Free-text health notes from intake / check-ins (scanned for red flags). */
  healthNotes?: string[];
}

export interface GoalPlanContext {
  roles: string[];
  timezone?: string;
  /** YYYY-MM-DD, day 1 of the plan in the user's timezone. */
  startDate: string;
  /** Optional user target date (YYYY-MM-DD), used for safe-pace checks. */
  targetDate?: string;
  availability?: GoalPlanAvailability;
  constraints?: string[];
  /** The user's own minimum floors, e.g. { body: 'Walk 10 minutes' }. */
  minimumFloors?: Partial<Record<PlanPillar, string>>;
  body?: BodyContext;
}

export interface MvdAction {
  title: string;
  output: string;
  durationMinutes: number;
}

export interface PlanAction extends MvdAction {
  key: string;
  /** Title with a `{m}` minutes slot, re-rendered when availability caps the duration. */
  titleTemplate?: string;
  pillar: PlanPillar;
  /** Floor keys this action already satisfies (so the floor is not stacked on top). */
  satisfiesFloors: string[];
  mvd: MvdAction;
}

export type GateKey = 'foundation' | 'build' | 'establish';

export interface PlanMilestone {
  id: string;
  title: string;
  dueDay: number;
  dueDate: string;
}

export interface WeeklySlot {
  weekday: Weekday;
  actionKey: string;
}

export interface PlanGate {
  key: GateKey;
  label: 'Foundation' | 'Build' | 'Establish';
  startDay: number;
  endDay: number;
  startDate: string;
  endDate: string;
  outcome: string;
  milestones: PlanMilestone[];
  weeklyCadence: WeeklySlot[];
}

export type GateVerdictKey = 'promote' | 'maintain' | 'park';

export interface PlanDecision {
  day: 90;
  date: string;
  options: GateVerdictKey[];
  criteria: string[];
  actionKey: string;
}

export type PlanReasonCode =
  | 'body.rate_ceiling'
  | 'body.referral'
  | 'body.pace_unverified'
  | 'body.no_prescription'
  | 'wealth.no_product_advice'
  | 'wealth.buffer_gate'
  | 'home.floor_protected'
  | 'floor.needs_clarifying';

export interface PlanSafety {
  reasonCodes: PlanReasonCode[];
  notes: string[];
  doctorLine?: string;
  /** Safe weekly pace ceiling for weight-loss goals. */
  weeklyRateCeiling?: { amount: number; unit: 'lb' | 'kg' };
  /** Earliest safe date for the stated weight target. */
  safePaceDate?: string;
  /** Red flag found: body coaching suppressed until clinician clearance. */
  referral: boolean;
}

export interface GoalPlan {
  id: string;
  version: 1;
  goalText: string;
  persona: PersonaMatch;
  foreground: { pillar: PlanPillar; label: string };
  startDate: string;
  endDate: string;
  timezone?: string;
  /** Availability from the context; the supplier caps durations by weekday with it. */
  availability?: GoalPlanAvailability;
  gates: [PlanGate, PlanGate, PlanGate];
  /** Catalogue of every action the plan can supply, by key. */
  actions: Record<string, PlanAction>;
  /** One-off actions for the first days of the plan (override the weekly cadence). */
  setup: Array<{ day: number; actionKey: string }>;
  /** Daily background floors (critical pillars kept from collapsing). */
  floors: string[];
  decision: PlanDecision;
  safety: PlanSafety;
  provenance: { source: 'deterministic_template'; templateKey: string; refinedBy?: string[] };
}

export type { DayState };

export interface CompletedEvidence {
  date: string;
  actionKey?: string;
  instanceId?: string;
}

export interface DailySupplyInput {
  /** YYYY-MM-DD in the user's timezone (use calendarDateInTimezone). */
  date: string;
  state: DayState;
  mood?: number;
  completed?: CompletedEvidence[];
  /** Day-90 verdict once recorded. */
  decision?: GateVerdictKey;
}

export type SupplyReason =
  | 'pre_start'
  | 'setup'
  | 'weekly_cadence'
  | 'never_miss_twice'
  | 'no_catch_up'
  | 'low_mood_mvd'
  | 'recovery_mvd'
  | 'rest_day'
  | 'one_foreground'
  | 'floor_protected'
  | 'day_90_decision'
  | 'promoted'
  | 'maintained'
  | 'parked_background'
  | 'referral';

export interface SuppliedAction {
  instanceId: string;
  actionKey: string;
  role: 'foreground' | 'floor';
  scope: 'standard' | 'mvd';
  pillar: PlanPillar;
  title: string;
  output: string;
  durationMinutes: number;
  status: 'open' | 'done';
}

export interface DailySupply {
  planId: string;
  date: string;
  dayIndex: number;
  phase: GateKey | 'pre_start' | 'decision' | 'post_plan';
  mode: 'standard' | 'recovery';
  foreground: SuppliedAction;
  floors: SuppliedAction[];
  reasons: SupplyReason[];
  dayComplete: boolean;
}

