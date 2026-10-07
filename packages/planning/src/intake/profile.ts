import {
  AREA_PILLAR,
  PILLAR_LABELS,
  PILLAR_NAMES,
  TRACK_DISPLAY_NAMES,
  type AreaKey,
  type IntakeProfile,
  type PillarName,
  type TrackKey,
} from '@apm/domain';
import { areaLabel } from '../areas.js';
import { BED_ROUTINE_STEP, generateBedRoutine, type BedAnswer, type BedRoutine, type BodySafetyAnswer } from '../bed-routine.js';
import { addDays } from '../goal-templates.js';
import { generateGoalPlan } from '../goal-plan.js';
import type { GoalPlan } from '../goal-plan-types.js';
import { CORE_LAWS } from '../methodology.js';
import { FIRST_SEVEN_DAYS } from '../loop-extras.js';
import {
  generatePractices,
  practiceDueOn,
  selectMindPractices,
  type LearningModality,
  type LearningTopic,
  type PracticeAction,
  type PracticeCadence,
  type SpiritPracticeKey,
} from '../practices.js';
import { BANK_VERSION, FLOOR_CHIPS } from './bank.js';
import {
  boundaryLines,
  chosenGoal,
  deferredQuestionIds,
  foregroundGame,
  gameIds,
  gameLabel,
  helpers,
  nonNegotiableLines,
  optionLabel,
  pillarOn,
  visibleAnswers,
} from './engine.js';
import type { GameKey, IntakeAnswers, IntakeMode, ProposedArea, ProposedPillar } from './types.js';

/**
 * The deterministic intake → OS synthesis (docs/34 §7.1). Works with no model: persona,
 * Tracks with one-line reasons, the three pillars with their areas, floors, the morning
 * sequence (with the in-bed routine), the coaching mode, practices, the first 7 days and
 * the install payload. An approved model route may only PROPOSE edits to this, field by
 * field, and the API re-validates every one (services/api/src/intakeSynthesis.ts).
 */

const arr = (a: IntakeAnswers, id: string): string[] => (Array.isArray(a[id]) ? (a[id] as string[]) : []);
const str = (a: IntakeAnswers, id: string): string | undefined => (typeof a[id] === 'string' ? (a[id] as string) : undefined);
const num = (a: IntakeAnswers, id: string): number | undefined => (typeof a[id] === 'number' ? (a[id] as number) : undefined);
const bool = (a: IntakeAnswers, id: string): boolean | undefined => (typeof a[id] === 'boolean' ? (a[id] as boolean) : undefined);

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

export interface TrackProposal { key: TrackKey; name: string; reason: string; on: boolean }

/** Prototype v2 Track rules; Billionaire High Performance Coach only for ownership games. */
export function trackRecommendations(a: IntakeAnswers): TrackProposal[] {
  const out: Array<[TrackKey, string]> = [['operator_discipline', 'Universal default: the morning plan is executed as written.']];
  const add = (key: TrackKey, reason: string) => { if (!out.some(([k]) => k === key)) out.push([key, reason]); };
  const patterns = arr(a, 'patterns');
  if (helpers.any(a, 'founder') || (helpers.any(a, 'operator') && a.equity === true)) {
    add('billionaire_mindset', 'You play an ownership game: leverage, compounding, downside containment.');
    add('strategic_patience', 'No pivots before the 30/60/90 gates.');
    add('resilience', 'Founders burn out; recovery is part of execution.');
  }
  if (helpers.any(a, 'weight', 'athlete')) {
    add('body_foundation', 'Small body behaviours at a safe pace.');
    add('strategic_patience', 'Plateaus are data, not a reason to switch programs.');
    add('resilience', 'One slip never becomes a lost week.');
  }
  if (helpers.any(a, 'wealth')) { add('wealth_foundation', 'Buffer before bets; one debt at a time.'); add('strategic_patience', 'No panic moves.'); }
  if (helpers.any(a, 'parent') && helpers.any(a, 'founder', 'operator')) {
    add('home_front', 'You play a second game: family time is booked first.');
    add('resilience', 'Two games need recovery capacity.');
  }
  if (helpers.any(a, 'operator')) { add('strategic_patience', 'Career moves compound; no quiet pivots.'); add('resilience', 'Protects capacity in high-pressure seasons.'); }
  if (patterns.some((p) => ['burnout', 'all_or_nothing', 'crash'].includes(p)) || ['week', 'quit'].includes(str(a, 'after_miss') ?? '')) {
    add('resilience', 'You said a miss can cost you a week: APM shrinks the next day instead.');
  }
  return out.map(([key, reason]) => ({ key, name: TRACK_DISPLAY_NAMES[key], reason, on: a[`trk_${key}`] !== false }));
}

/** High-Pressure Coaching is pre-selected (one tap to confirm) when this Track is suggested. */
export function highPressureSuggested(a: IntakeAnswers): boolean {
  return trackRecommendations(a).some((track) => track.key === 'billionaire_mindset');
}

export type CoachingTone = 'gentle' | 'direct' | 'high_pressure';

export const COACHING_TONE_LABELS: Readonly<Record<CoachingTone, string>> = {
  gentle: 'Gentle and supportive',
  direct: 'Calm and direct',
  high_pressure: 'High-Pressure Coaching',
};

export function coachingTone(a: IntakeAnswers): { tone: CoachingTone; preselected: boolean } {
  const chosen = str(a, 'tone') as CoachingTone | undefined;
  if (chosen) return { tone: chosen, preselected: a._pf_tone === true };
  if (highPressureSuggested(a)) return { tone: 'high_pressure', preselected: true };
  return { tone: helpers.tough(a) ? 'gentle' : 'direct', preselected: false };
}

// ---------------------------------------------------------------------------
// Goal text (feeds generateGoalPlan; worded so persona recognition is exact)
// ---------------------------------------------------------------------------

const GOAL_TEXT: Readonly<Record<string, (n?: number) => string>> = {
  lose_weight: (n) => `Lose ${n ?? 20} lb`,
  workout_habit: (n) => `Get in shape: ${n ?? 3} workouts a week`,
  eat_better: () => 'Get healthy: eat better most days',
  energy: () => 'Get healthy: get my energy back',
  emergency_fund: (n) => `Build an emergency fund covering ${n ?? 3} months of expenses`,
  pay_debt: (n) => `Pay off my ${n ?? 3} debts`,
  invest_monthly: () => 'Start investing every month',
  save_goal: (n) => `Build savings of $${n ?? 10},000 for a big goal`,
  launch: () => 'Launch my product',
  customers: (n) => `Get ${n ?? 10} paying customers`,
  revenue: (n) => `Hit $${n ?? 10}k in monthly revenue`,
  raise: () => 'Raise money for my startup',
  hire: () => 'Hire the next person for my business',
  promotion: () => 'Get promoted',
  visible_project: () => 'Ship a high-visibility project at work',
  lead_team: () => 'Lead my team better at work',
  new_role: () => 'Move up: land a new role or company',
  calm_mornings: () => 'Calmer school mornings with my kids',
  present_time: () => 'More present time with my kids',
  household: () => 'Get the household organised for my family',
  newborn: () => 'Stabilise a newborn routine for my baby',
  race: () => 'Train for a race or event',
  stronger: () => 'Get stronger',
  return_injury: () => 'Return from injury safely',
  qualify: () => 'Make the team or qualify',
  exam: () => 'Pass a big exam',
  grades: () => 'Raise my grades',
  thesis: () => 'Finish a thesis or project',
  admission: () => 'Get into a program',
  ship_release: () => 'Ship a release or publication',
  consistent: (n) => `Publish ${n ?? 3} posts a week`,
  draft: () => 'Finish a draft of my book',
  audience: () => 'Grow an audience',
  new_job: () => 'Land a new job',
  move: () => 'Settle into a move',
  rebuild: () => 'Rebuild after a loss or breakup',
  stabilise_money: () => 'Stabilise my savings after a change',
};

export function goalText(a: IntakeAnswers): string {
  const goal = chosenGoal(a);
  if (!goal) return 'Make one meaningful thing happen in the next 90 days';
  const size = goal.size ? num(a, 'goal_size') ?? goal.size.def : undefined;
  return (GOAL_TEXT[goal.id] ?? (() => goal.label))(size);
}

export function goalOutcome(a: IntakeAnswers): string | undefined {
  const goal = chosenGoal(a);
  if (!goal?.size) return undefined;
  return `${num(a, 'goal_size') ?? goal.size.def} ${goal.size.unit}`;
}

/** Target date from "By when?" (none → no hard date; the 90-day gates still run). */
export function targetDate(a: IntakeAnswers, startDate: string): string | undefined {
  const days = Number(str(a, 'target'));
  return Number.isFinite(days) && days > 0 ? addDays(startDate, days - 1) : undefined;
}

// ---------------------------------------------------------------------------
// Practices
// ---------------------------------------------------------------------------

export function spiritPractices(a: IntakeAnswers): SpiritPracticeKey[] {
  if (!pillarOn(a, 'spirit')) return [];
  const chosen = arr(a, 'spirit').filter((x) => x !== 'none') as SpiritPracticeKey[];
  const out = [...chosen];
  if (helpers.any(a, 'parent') || arr(a, 'secondary').includes('family')) out.push('family_time');
  // Spirit is on for everyone: with nothing chosen, the secular breath practice is the default.
  if (!chosen.length && !arr(a, 'spirit').includes('none')) out.unshift('meditation');
  if (arr(a, 'spirit').includes('none') && !out.length) out.push('meditation');
  return [...new Set(out)];
}

export function mindPractices(a: IntakeAnswers) {
  if (!pillarOn(a, 'mind')) return [];
  return selectMindPractices({ practices: arr(a, 'practices'), learning: str(a, 'learning'), lines: arr(a, 'lines'), patterns: arr(a, 'patterns') });
}

export function faithLanguage(a: IntakeAnswers): boolean {
  return arr(a, 'spirit').includes('faith') || arr(a, 'helps').includes('faith');
}

export function practiceInput(a: IntakeAnswers) {
  return {
    mind: mindPractices(a),
    spirit: spiritPractices(a),
    cadence: (str(a, 'practice_cadence') as PracticeCadence | undefined) ?? 'daily',
    learningTopic: (str(a, 'learning') && a.learning !== 'none' ? a.learning : undefined) as LearningTopic | undefined,
    learningModality: str(a, 'modality') as LearningModality | undefined,
    lines: arr(a, 'lines'),
    fixed: arr(a, 'fixed'),
    protectedMoments: arr(a, 'protected'),
    faithLanguage: faithLanguage(a),
  };
}

/** Today's practices for an installed profile (Today and the summary use this). */
export function practicesFromProfile(profile: IntakeProfile, date: string, startDate = date): PracticeAction[] {
  return generatePractices({
    mind: profile.mindPractices as ReturnType<typeof mindPractices>,
    spirit: profile.spiritPractices as SpiritPracticeKey[],
    cadence: profile.practiceCadence ?? 'daily',
    learningTopic: profile.learningTopic as LearningTopic | undefined,
    learningModality: profile.learningModality as LearningModality | undefined,
    lines: profile.lineIds ?? [],
    fixed: profile.fixedCommitments,
    protectedMoments: profile.family?.protected ?? [],
    faithLanguage: profile.faithLanguage,
  }, date, startDate);
}

/** The daily practice floors that join the plan (one per area; weekly ones stay on Today). */
export function dailyPracticeFloors(practices: PracticeAction[], date: string, reviewDay = 0) {
  return practices
    .filter((p) => p.cadence === 'daily' && practiceDueOn(p.cadence, date, reviewDay))
    .map((p) => ({ key: p.key, area: p.area, title: p.title, output: p.output, minutes: p.minutes, floor: p.floor, ...(p.rotation ? { rotation: p.rotation } : {}), ...(p.steps.length ? { steps: p.steps } : {}) }));
}

// ---------------------------------------------------------------------------
// Pillars and areas
// ---------------------------------------------------------------------------

const DEFAULT_AREA_FLOORS: Readonly<Partial<Record<AreaKey, string>>> = {
  work: 'Write tomorrow\'s first step',
  money: 'Move any amount to savings',
  learning: 'Read one page',
  focus: 'Put your phone in another room for 15 minutes',
  mental_health: 'Write one line in your journal',
  movement: 'Walk 10 minutes',
  food: 'Drink a glass of water with your next meal',
  sleep: 'Put your phone outside the bedroom at bedtime',
  weight: 'Log one meal',
  health_routines: 'Do your daily health routine',
  faith: '1 minute of prayer or silence',
  meditation: '3 slow breaths: in for 4, out for 6',
  gratitude: 'Write one line: one thing that went right',
  nature: 'Step outside for 1 minute and take 3 slow breaths',
  service: 'Send one kind message to someone',
  family: 'One protected family touchpoint for 10 minutes, phone away',
};

const FLOOR_AREA: ReadonlyMap<string, AreaKey> = new Map(
  (Object.values(FLOOR_CHIPS) as ReadonlyArray<ReadonlyArray<{ label: string; area: AreaKey }>>).flat().map((chip) => [chip.label, chip.area]),
);

/** The area each picked floor chip belongs to. */
export function floorArea(label: string): AreaKey | undefined {
  return FLOOR_AREA.get(label);
}

export interface PillarProposal {
  pillars: ProposedPillar[];
  foregroundArea: AreaKey;
  criticalAreas: AreaKey[];
  activeAreas: AreaKey[];
  minimumFloors: Partial<Record<AreaKey, string>>;
  /** A pillar she switched off still keeps the foreground area (her #1 goal lives there). */
  keptForForeground?: PillarName;
}

/** `_suggested_areas` holds "label|area" entries written by the summary (one tap to move). */
export function suggestedAreaKeys(a: IntakeAnswers): AreaKey[] {
  return arr(a, '_suggested_areas').map((entry) => entry.split('|')[1] as AreaKey).filter((area) => Boolean(area && AREA_PILLAR[area]));
}

export function proposePillars(a: IntakeAnswers, foregroundArea: AreaKey): PillarProposal {
  const game = foregroundGame(a);
  const areas = new Map<AreaKey, true>();
  const on = (area: AreaKey) => areas.set(area, true);
  // Mind
  on('work');
  if (helpers.any(a, 'wealth') || arr(a, 'secondary').includes('money') || arr(a, 'income').some((x) => x !== 'none')) on('money');
  const mind = mindPractices(a);
  if (mind.includes('reading') || mind.includes('learning_plan') || arr(a, 'secondary').includes('learning')) on('learning');
  if (mind.includes('focus_hygiene')) on('focus');
  on('mental_health');
  // Body
  on('movement');
  if (arr(a, 'food').some((x) => x !== 'fine')) on('food');
  if (arr(a, 'lines').includes('sleep')) on('sleep');
  if (helpers.any(a, 'weight') && a.goal === 'lose_weight') on('weight');
  if (a.health_routine === true || ['yes', 'sometimes'].includes(str(a, 'bed') ?? '')) on('health_routines');
  // Spirit
  for (const practice of spiritPractices(a)) on(practice === 'family_time' ? 'family' : (practice as AreaKey));
  // Pillars she suggested (catch-all or the summary chip), already classified into an area.
  for (const area of suggestedAreaKeys(a)) on(area);
  on(foregroundArea);

  let keptForForeground: PillarName | undefined;
  const enabled = (pillar: PillarName) => pillarOn(a, pillar) || (pillar === 'body' && helpers.bodyOn(a));
  const active = [...areas.keys()].filter((area) => {
    const pillar = AREA_PILLAR[area];
    if (enabled(pillar)) return true;
    if (area === foregroundArea) { keptForForeground = pillar; return true; }
    return false;
  });

  const nn = nonNegotiableLines(a);
  const critical = new Set<AreaKey>([foregroundArea]);
  if (nn.some((x) => ['dinner', 'pickup', 'date'].includes(x))) critical.add('family');
  if (nn.includes('sleep')) critical.add('sleep');
  if (nn.includes('workout')) critical.add('movement');
  if (nn.includes('worship')) critical.add('faith');
  if (nn.includes('no_debt')) critical.add('money');

  const chips = arr(a, 'floors');
  const practices = generatePractices(practiceInput(a), '2026-01-05');
  const floorFor = (area: AreaKey): string | undefined =>
    chips.find((chip) => floorArea(chip) === area)
    ?? practices.find((p) => p.area === area)?.floor.title
    ?? DEFAULT_AREA_FLOORS[area];

  const criticalOf = (area: AreaKey) => (a[`crit_${area}`] !== undefined ? a[`crit_${area}`] === true : critical.has(area));
  const proposed: ProposedArea[] = active.map((area) => ({ area, label: areaLabel(area, game), critical: criticalOf(area), floor: floorFor(area) }));
  const pillars: ProposedPillar[] = PILLAR_NAMES.map((pillar) => ({
    pillar,
    label: PILLAR_LABELS[pillar],
    enabled: enabled(pillar) || keptForForeground === pillar,
    areas: proposed.filter((p) => AREA_PILLAR[p.area] === pillar),
  }));
  const minimumFloors: Partial<Record<AreaKey, string>> = {};
  for (const p of proposed) if (p.floor) minimumFloors[p.area] = p.floor;
  return {
    pillars,
    foregroundArea,
    criticalAreas: proposed.filter((p) => p.critical).map((p) => p.area),
    activeAreas: proposed.map((p) => p.area),
    minimumFloors,
    ...(keptForForeground ? { keptForForeground } : {}),
  };
}

// ---------------------------------------------------------------------------
// Morning
// ---------------------------------------------------------------------------

export function bedRoutineFor(a: IntakeAnswers): BedRoutine | undefined {
  return generateBedRoutine(str(a, 'bed') as BedAnswer | undefined, str(a, 'clinician_flag') as BodySafetyAnswer | undefined);
}

/** Up to 5 physical steps; the in-bed routine is step 1 when it is on. */
export function compileMorning(a: IntakeAnswers): string[] {
  const first = `First task: ${str(a, 'first_step') ?? 'your highest-leverage step'}`;
  const bed = bedRoutineFor(a) ? [BED_ROUTINE_STEP] : [];
  const launch = str(a, 'launch') ?? 'calm';
  const presets: Record<string, string[]> = {
    quick: ['Glass of water'],
    calm: ['Feet to the floor (10 seconds)', '1 minute of breathing', 'Glass of water'],
    faith: ['1 minute of prayer', 'Glass of water'],
  };
  if (presets[launch]) return [...bed, ...presets[launch]!, first].slice(0, 5);
  const out: string[] = [...bed];
  if (!bed.length && a.bed_move && a.bed_move !== 'none') out.push(`${optionLabel('bed_move', str(a, 'bed_move')!)} in bed (30 to 60 seconds)`);
  if (a.mental) out.push(`1 minute of ${optionLabel('mental', str(a, 'mental')!).toLowerCase()}${a.where ? ` (${optionLabel('where', str(a, 'where')!).toLowerCase()})` : ''}`);
  if (a.start_action) out.push(optionLabel('start_action', str(a, 'start_action')!));
  out.push(first);
  return out.slice(0, 5);
}

/** "Agenda arrives at" minutes after midnight. */
export function agendaArrivalMinutes(a: IntakeAnswers): number {
  const offset = { wake: 0, wake15: 15, wake30: 30 }[str(a, 'trigger') ?? 'wake15'] ?? 15;
  return ((num(a, 'wake') ?? 390) + offset) % 1440;
}

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function clockLabel(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ---------------------------------------------------------------------------
// The whole synthesis
// ---------------------------------------------------------------------------


export function systemNameOptions(a: IntakeAnswers): string[] {
  const names = ['My A Player Mode', 'My Roundtable', 'My Chief of Staff'];
  // "Billionaire Executive Roundtable" only for founders and equity holders.
  if (helpers.any(a, 'founder') || a.equity === true) names.push('Billionaire Executive Roundtable');
  return names;
}

export interface IntakeSynthesis {
  goalText: string;
  plan: GoalPlan;
  tracks: TrackProposal[];
  pillars: PillarProposal;
  coaching: { tone: CoachingTone; label: string; preselected: boolean };
  morning: string[];
  agendaAt: string;
  bedRoutine?: BedRoutine;
  practices: PracticeAction[];
  firstSevenDays: typeof FIRST_SEVEN_DAYS;
  laws: string[];
  systemName: string;
  systemNames: string[];
  holding: number;
  /** Coaching-mode chips Today shows (Sprint and Deep Work only when they apply). */
  modeChips: Array<{ mode: 'high_pressure' | 'executive_review' | 'recovery' | 'sprint' | 'deep_work'; label: string; when: string }>;
}

export function coachingModeChips(a: IntakeAnswers | { deadlines: string[]; games: string[] }): IntakeSynthesis['modeChips'] {
  const deadlines = Array.isArray((a as IntakeAnswers).deadlines) ? ((a as IntakeAnswers).deadlines as string[]) : [];
  const games = Array.isArray((a as IntakeAnswers).games) ? ((a as IntakeAnswers).games as string[]) : [];
  const chips: IntakeSynthesis['modeChips'] = [
    { mode: 'high_pressure', label: 'High-Pressure', when: 'when stuck or avoiding' },
    { mode: 'executive_review', label: 'Executive Review', when: 'head full: no new ideas, organise 3 to 7 items' },
    { mode: 'recovery', label: 'Recovery', when: 'bad day: minimum day, no catch-up' },
  ];
  if (deadlines.some((d) => d !== 'none')) chips.push({ mode: 'sprint', label: 'Sprint', when: 'a deadline is close' });
  if (games.some((g) => ['founder', 'operator', 'creator', 'student'].includes(g))) chips.push({ mode: 'deep_work', label: 'Deep Work', when: 'protect one focus block' });
  return chips;
}

export function synthesizeProfile(a: IntakeAnswers, context: { startDate: string; timezone?: string }): IntakeSynthesis {
  const text = goalText(a);
  const roles = gameIds(a).map(gameLabel);
  const practices = generatePractices(practiceInput(a), context.startDate, context.startDate);
  // A provisional plan names the foreground area; the final plan uses the proposed floors.
  const draftPlan = generateGoalPlan(text, { roles: roles.length ? roles : ['Something else'], startDate: context.startDate, ...(context.timezone ? { timezone: context.timezone } : {}) });
  const pillars = proposePillars(a, draftPlan.foreground.pillar);
  const minutes = num(a, 'minutes');
  const plan = generateGoalPlan(text, {
    roles: roles.length ? roles : ['Something else'],
    startDate: context.startDate,
    ...(context.timezone ? { timezone: context.timezone } : {}),
    ...(targetDate(a, context.startDate) ? { targetDate: targetDate(a, context.startDate) } : {}),
    ...(minutes ? { availability: { defaultMinutes: minutes } } : {}),
    minimumFloors: pillars.minimumFloors,
    practices: dailyPracticeFloors(practices.filter((p) => pillars.activeAreas.includes(p.area)), context.startDate),
    body: {
      ...(num(a, 'weight_now') ? { currentWeight: num(a, 'weight_now'), unit: (str(a, 'weight_unit') as 'lb' | 'kg' | undefined) ?? 'lb' } : {}),
      ...(a.clinician_sup === true ? { clinicianSupervised: true } : {}),
      ...(['yes', 'skip'].includes(str(a, 'clinician_flag') ?? '') ? { referralActive: true } : {}),
    },
  });
  const tone = coachingTone(a);
  const names = systemNameOptions(a);
  const chosenName = str(a, 'sysname');
  return {
    goalText: text,
    plan,
    tracks: trackRecommendations(a),
    pillars,
    coaching: { ...tone, label: COACHING_TONE_LABELS[tone.tone] },
    morning: compileMorning(a),
    agendaAt: clockLabel(agendaArrivalMinutes(a)),
    ...(bedRoutineFor(a) ? { bedRoutine: bedRoutineFor(a) } : {}),
    practices: practices.filter((p) => pillars.activeAreas.includes(p.area)),
    firstSevenDays: FIRST_SEVEN_DAYS,
    laws: CORE_LAWS.map((law) => law.label),
    systemName: chosenName && names.includes(chosenName) ? chosenName : names[0]!,
    systemNames: names,
    holding: 0,
    modeChips: coachingModeChips(a),
  };
}

// ---------------------------------------------------------------------------
// Install payload (PUT /v1/methodology/intake)
// ---------------------------------------------------------------------------

export interface IntakeInstallPayload {
  displayName: string;
  roles: string[];
  primaryGoal: string;
  currentSeason?: string;
  pillar?: AreaKey;
  timezone?: string;
  goalOutcome?: string;
  goalTargetDate?: string;
  firstNextAction?: string;
  northStar?: string;
  values: string[];
  nonNegotiables: string[];
  failurePatterns: string[];
  bodyContext?: string;
  workMoneyContext?: string;
  mindSpiritLearningContext?: string;
  weeklyCadence: { heavyDays: string[]; lightDays: string[]; reviewDay?: string; recoveryDay?: string };
  coachingStyle: { firmness: CoachingTone; helpfulLanguage?: string; avoidLanguage?: string };
  accountability: { dayStart: 'guided' | 'hard'; coachingReminderAfterDays?: number };
  criticalPillars: AreaKey[];
  activeAreas: AreaKey[];
  pillarsEnabled: PillarName[];
  minimumFloors: Partial<Record<AreaKey, string>>;
  trackKeys: TrackKey[];
  activeMode: 'standard';
  morningSequence: string[];
  schedulingPreference: 'strict_blocks' | 'loose_dayparts' | 'ordered_stack';
  hardBoundaries: string[];
  scoringConfig: { enabled: boolean; showSevenDaySnapshot: boolean };
  foregroundProjectName: string;
  foregroundProjectObjective: string;
  reviewGateDays: 30;
  intakeProfile: IntakeProfile;
  /** Install idempotency: the draft version (docs/34 §6 rule 7). */
  idempotencyKey: string;
}

const labels = (qid: string, values: string[], a: IntakeAnswers) => values.filter((v) => v !== 'none').map((v) => optionLabel(qid, v, a));
const sentence = (parts: Array<string | undefined | false>) => parts.filter(Boolean).join(' ').trim() || undefined;

export function buildIntakeProfile(a: IntakeAnswers, mode: IntakeMode, synthesis: IntakeSynthesis): IntakeProfile {
  const family = helpers.any(a, 'parent') ? { dependents: arr(a, 'dependents'), protected: arr(a, 'protected'), ...(str(a, 'shared') ? { shared: str(a, 'shared') } : {}) } : undefined;
  const learning = str(a, 'learning');
  const bodySafety = str(a, 'clinician_flag') as IntakeProfile['bodySafety'] | undefined;
  return {
    bankVersion: BANK_VERSION,
    games: gameIds(a),
    ...(gameIds(a).length ? { foregroundGame: foregroundGame(a) } : {}),
    ...(num(a, 'load') !== undefined ? { loadBaseline: num(a, 'load') } : {}),
    mentalLoadItems: arr(a, 'carry'),
    ...(num(a, 'wake') !== undefined ? { wakeTime: hhmm(num(a, 'wake')!) } : {}),
    ...(num(a, 'sleep') !== undefined ? { sleepTime: hhmm(num(a, 'sleep')!) } : {}),
    fixedCommitments: arr(a, 'fixed').filter((x) => x !== 'none'),
    lineIds: arr(a, 'lines'),
    ...(str(a, 'travel') ? { travelPattern: str(a, 'travel') } : {}),
    ...(num(a, 'minutes') !== undefined ? { defaultMinutes: num(a, 'minutes') } : {}),
    ...(str(a, 'after_miss') ? { missPattern: str(a, 'after_miss') } : {}),
    ...(str(a, 'energy') ? { energyDip: str(a, 'energy') } : {}),
    deadlines: arr(a, 'deadlines').filter((x) => x !== 'none'),
    ...(str(a, 'deadline_when') ? { deadlineWindow: str(a, 'deadline_when') } : {}),
    realWork: arr(a, 'real_work'),
    fakeWork: arr(a, 'fake_work'),
    wealthContext: arr(a, 'money_state'),
    ...(bool(a, 'equity') !== undefined ? { ownership: bool(a, 'equity') } : {}),
    careerLevers: arr(a, 'career_lever'),
    ...(family ? { family } : {}),
    mindPractices: mindPractices(a),
    ...(learning && learning !== 'none' ? { learningTopic: learning } : {}),
    ...(str(a, 'modality') ? { learningModality: str(a, 'modality') } : {}),
    spiritPractices: spiritPractices(a),
    faithLanguage: faithLanguage(a),
    ...(str(a, 'practice_cadence') ? { practiceCadence: str(a, 'practice_cadence') as PracticeCadence } : {}),
    ...(synthesis.bedRoutine ? { bedRoutine: { gentle: synthesis.bedRoutine.gentle } } : {}),
    ...(bodySafety ? { bodySafety: (bodySafety as string) === 'no' ? 'none' : bodySafety } : {}),
    coachingHelps: arr(a, 'helps'),
    coachingAvoid: arr(a, 'triggers'),
    ...(str(a, 'trigger') ? { morningTrigger: str(a, 'trigger') as IntakeProfile['morningTrigger'] } : {}),
    systemName: synthesis.systemName,
    quickStart: mode === 'quick',
    deferredQuestionIds: mode === 'quick' ? deferredQuestionIds(a) : [],
    suggestedAreas: Array.isArray(a._suggested_areas) ? (a._suggested_areas as string[]).map((entry) => { const [label, area] = entry.split('|'); return { label: label ?? '', area: area as AreaKey }; }).filter((x) => x.label && AREA_PILLAR[x.area]) : [],
  };
}

/** The one install call. Hidden answers (a game she unticked) are never sent. */
export function toInstallPayload(
  allAnswers: IntakeAnswers,
  context: { startDate: string; timezone?: string; displayName?: string; draftVersion: number },
): IntakeInstallPayload {
  const a = visibleAnswers(allAnswers);
  const mode: IntakeMode = a.mode === 'quick' ? 'quick' : 'full';
  const synthesis = synthesizeProfile(a, context);
  const roles = gameIds(a).map(gameLabel);
  const tracks = synthesis.tracks.filter((track) => track.on).map((track) => track.key);
  const body = sentence([
    arr(a, 'move').length ? `Movement she will do: ${labels('move', arr(a, 'move'), a).join(', ')}.` : undefined,
    num(a, 'workout_days') !== undefined ? `${num(a, 'workout_days')} days a week.` : undefined,
    arr(a, 'food').length ? `Food habits to work on: ${labels('food', arr(a, 'food'), a).join(', ')}.` : undefined,
    str(a, 'weigh_in') ? `Weigh-in: ${optionLabel('weigh_in', str(a, 'weigh_in')!)}.` : undefined,
    a.health_routine === true ? 'Has a daily health routine to be reminded of.' : undefined,
  ]);
  const work = sentence([
    arr(a, 'income').length ? `Income: ${labels('income', arr(a, 'income'), a).join(', ')}.` : undefined,
    arr(a, 'income_rank').length ? `Priority: ${labels('income', arr(a, 'income_rank'), a).join(' > ')}.` : undefined,
    arr(a, 'real_work').length ? `Real work: ${labels('real_work', arr(a, 'real_work'), a).join(', ')}.` : undefined,
    arr(a, 'fake_work').length ? `Fake work: ${labels('fake_work', arr(a, 'fake_work'), a).join(', ')}.` : undefined,
    arr(a, 'money_state').length ? `Money today: ${labels('money_state', arr(a, 'money_state'), a).join(', ')}.` : undefined,
  ]);
  const mindSpirit = sentence([
    arr(a, 'practices').length ? `Practices: ${labels('practices', arr(a, 'practices'), a).join(', ')}.` : undefined,
    arr(a, 'spirit').length ? `Feeds her spirit: ${labels('spirit', arr(a, 'spirit'), a).join(', ')}.` : undefined,
    str(a, 'learning') && a.learning !== 'none' ? `Learning: ${optionLabel('learning', str(a, 'learning')!)} by ${optionLabel('modality', str(a, 'modality') ?? 'read').toLowerCase()}.` : undefined,
  ]);
  const separation = str(a, 'separation');
  const boundaries = [...labels('lines', boundaryLines(a), a), ...(separation && separation !== 'none' ? [optionLabel('separation', separation)] : [])];
  return {
    displayName: context.displayName ?? '',
    roles: roles.length ? roles : ['Something else'],
    primaryGoal: synthesis.goalText,
    ...(str(a, 'season') ? { currentSeason: optionLabel('season', str(a, 'season')!) } : {}),
    pillar: synthesis.pillars.foregroundArea,
    ...(context.timezone ? { timezone: context.timezone } : {}),
    ...(goalOutcome(a) ? { goalOutcome: goalOutcome(a) } : {}),
    ...(targetDate(a, context.startDate) ? { goalTargetDate: targetDate(a, context.startDate) } : {}),
    ...(str(a, 'first_step') ? { firstNextAction: str(a, 'first_step') } : {}),
    ...(str(a, 'northstar') ? { northStar: `${optionLabel('northstar', str(a, 'northstar')!)}${str(a, 'horizon') ? ` (${str(a, 'horizon')} years)` : ''}` } : {}),
    values: labels('values', arr(a, 'values'), a),
    nonNegotiables: labels('lines', nonNegotiableLines(a), a),
    failurePatterns: labels('patterns', arr(a, 'patterns'), a),
    ...(body ? { bodyContext: body } : {}),
    ...(work ? { workMoneyContext: work } : {}),
    ...(mindSpirit ? { mindSpiritLearningContext: mindSpirit } : {}),
    weeklyCadence: {
      heavyDays: arr(a, 'heavy'),
      lightDays: arr(a, 'light'),
      reviewDay: str(a, 'review') ?? 'Sun',
      ...(str(a, 'recovery') && a.recovery !== 'none' ? { recoveryDay: str(a, 'recovery') } : {}),
    },
    coachingStyle: {
      firmness: synthesis.coaching.tone,
      ...(arr(a, 'helps').length ? { helpfulLanguage: labels('helps', arr(a, 'helps'), a).join(', ') } : {}),
      ...(arr(a, 'triggers').length ? { avoidLanguage: labels('triggers', arr(a, 'triggers'), a).join(', ') } : {}),
    },
    accountability: { dayStart: (str(a, 'start') as 'guided' | 'hard' | undefined) ?? 'guided', ...(a.reminder === false ? {} : { coachingReminderAfterDays: 7 }) },
    criticalPillars: synthesis.pillars.criticalAreas,
    activeAreas: synthesis.pillars.activeAreas,
    pillarsEnabled: synthesis.pillars.pillars.filter((p) => p.enabled).map((p) => p.pillar),
    minimumFloors: synthesis.pillars.minimumFloors,
    trackKeys: tracks,
    activeMode: 'standard',
    morningSequence: synthesis.morning,
    schedulingPreference: (str(a, 'sched') as IntakeInstallPayload['schedulingPreference'] | undefined) ?? 'loose_dayparts',
    hardBoundaries: boundaries,
    scoringConfig: { enabled: a.scoring !== 'off', showSevenDaySnapshot: true },
    foregroundProjectName: synthesis.goalText,
    foregroundProjectObjective: goalOutcome(a) ? `${synthesis.goalText}: ${goalOutcome(a)}` : synthesis.goalText,
    reviewGateDays: 30,
    intakeProfile: buildIntakeProfile(a, mode, synthesis),
    idempotencyKey: `intake-v${context.draftVersion}`,
  };
}
