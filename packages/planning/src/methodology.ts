import type {
  DayRecord,
  LifeGraphSnapshot,
  NextAction,
  OperatingModeKey,
  PillarName,
  TrackKey,
} from '@apm/domain';
import { TRACK_DISPLAY_NAMES } from '@apm/domain';

export const CORE_LAWS = [
  { key: 'never_miss_twice', label: 'Never Miss Twice' },
  { key: 'continuity_over_intensity', label: 'Continuity > Intensity' },
  { key: 'no_catch_up', label: 'No Catch-Up' },
  { key: 'no_midday_negotiation', label: 'No Mid-Day Negotiation' },
  { key: 'zeros_allowed', label: 'Zeros Are Allowed' },
  { key: 'minimum_viable_day', label: 'Minimum Viable Day' },
] as const;

/**
 * The installable Track library: exactly the four BHPC Tracks and the three app-only
 * Tracks (migration 0020, docs research of 6 Oct 2026). Display names come from the ONE
 * shared map in @apm/domain (TRACK_DISPLAY_NAMES) because the owner is still naming them.
 */
export const BUILTIN_TRACKS: ReadonlyArray<{
  key: TrackKey;
  name: string;
  origin: 'bhpc' | 'app';
  description: string;
}> = [
  { key: 'billionaire_mindset', name: TRACK_DISPLAY_NAMES.billionaire_mindset, origin: 'bhpc', description: 'Ownership, leverage, compounding and asymmetric upside for business and venture decisions.' },
  { key: 'operator_discipline', name: TRACK_DISPLAY_NAMES.operator_discipline, origin: 'bhpc', description: 'Follow-through: the morning plan is executed as written; changes are declared, not drifted into.' },
  { key: 'strategic_patience', name: TRACK_DISPLAY_NAMES.strategic_patience, origin: 'bhpc', description: 'No premature pivots before the evidence and the gates justify change.' },
  { key: 'resilience', name: TRACK_DISPLAY_NAMES.resilience, origin: 'bhpc', description: 'Protect recovery capacity and continuity during volatility.' },
  { key: 'body_foundation', name: TRACK_DISPLAY_NAMES.body_foundation, origin: 'app', description: 'Small tracked body behaviours at a safe pace; never diet or medical advice.' },
  { key: 'wealth_foundation', name: TRACK_DISPLAY_NAMES.wealth_foundation, origin: 'app', description: 'Save by default, one debt at a time, buffer before bets; never product advice.' },
  { key: 'home_front', name: TRACK_DISPLAY_NAMES.home_front, origin: 'app', description: 'Family time is scheduled and defended like the most important meeting of the week.' },
];

export const BUILTIN_MODES: ReadonlyArray<{
  key: OperatingModeKey;
  name: string;
  description: string;
}> = [
  { key: 'standard', name: 'Standard', description: 'Normal execution.' },
  { key: 'recovery', name: 'Recovery', description: 'Reduced scope that protects continuity.' },
  {
    key: 'high_pressure',
    name: 'High-Pressure Coaching',
    description: 'Direct coaching for avoidance, hard truths and difficult decisions.',
  },
  {
    key: 'executive_review',
    name: 'Executive Review',
    description: 'Organize what exists, clarify decisions, and avoid new-idea sprawl.',
  },
  {
    key: 'sprint',
    name: 'Sprint',
    description: 'A declared short burst of maximum-output work with one foreground only.',
  },
  {
    key: 'deep_work',
    name: 'Deep Work',
    description: 'A bounded uninterrupted focus block for one difficult task.',
  },
];

const BUSINESS_ROLE_MARKERS = ['business', 'entrepreneur', 'founder', 'career', 'leadership'];

export function adaptivePrimaryGoalPrompt(roles: string[]): string {
  const normalized = roles.map((role) => role.toLowerCase());
  if (normalized.some((role) => role.includes('training') || role.includes('competing'))) {
    return 'What are you training for, and by when?';
  }
  if (normalized.some((role) => role.includes('parenting') || role.includes('caregiving'))) {
    return 'What would make family life feel meaningfully better or more under control in the next 90 days?';
  }
  if (normalized.some((role) => role.includes('studying') || role.includes('learning'))) {
    return 'What academic or learning outcome matters most right now?';
  }
  if (normalized.some((role) => role.includes('creating') || role.includes('publishing'))) {
    return 'What are you trying to ship, publish, or build in the next 90 days?';
  }
  if (normalized.some((role) => role.includes('health') || role.includes('rebuilding'))) {
    return 'What does meaningful progress look like in this season?';
  }
  if (normalized.some((role) => role.includes('transition'))) {
    return 'What needs to become true for this transition to feel successful?';
  }
  if (normalized.some((role) => BUSINESS_ROLE_MARKERS.some((marker) => role.includes(marker)))) {
    return 'What business, career, or leadership outcome matters most in the next 90 days?';
  }
  return 'What are you trying to make happen in the next 90 days?';
}

const PARENT_ROLE = /(parent|caregiv|mom|dad|mother|father|family)/i;
const WORK_ROLE = /(business|entrepreneur|founder|career|leadership|professional|manager|operator|startup|work)/i;
const HEALTH_GOAL = /\b(lose|weight|lbs?|pounds|kg|fitness|fit|health(ier|y)?|body|run|gym|strength|walk)\b/i;
const WEALTH_GOAL = /\b(sav(e|ing|ings)|debt|emergency fund|net worth|invest(ing|ment)?|wealth|money|financ\w*|credit card|budget)\b/i;

/**
 * Persona → Track defaults (docs research "Persona → Track map"):
 *   weight loss → Body Foundation (+ Strategic Patience, Resilience);
 *   wealth building → Wealth Foundation + Strategic Patience; Billionaire High
 *     Performance Coach only when a business or ownership role is also present;
 *   founder → all four BHPC Tracks; operator → Operator Discipline, Strategic
 *     Patience, Resilience; parent+ (parent AND a work game) → Home Front.
 * Operator Discipline is the universal default. Every key is one of the seven Tracks.
 */
export function recommendTrackKeys(roles: string[], failurePatterns: string[] = [], goalText = ''): TrackKey[] {
  const normalized = roles.map((role) => role.toLowerCase());
  const failures = failurePatterns.join(' ').toLowerCase();
  const recommendations: TrackKey[] = ['operator_discipline'];
  // Billionaire High Performance Coach fits ownership games (founders, equity), not every career.
  const business = normalized.some((role) => /(business|entrepreneur|founder|startup|owner)/.test(role));
  const work = normalized.some((role) => WORK_ROLE.test(role));
  const parent = normalized.some((role) => PARENT_ROLE.test(role));
  const health = HEALTH_GOAL.test(goalText) || normalized.some((role) => /(health|rebuilding|fitness|weight)/.test(role));
  const wealth = WEALTH_GOAL.test(goalText);

  if (business) recommendations.push('billionaire_mindset', 'strategic_patience', 'resilience');
  if (health) recommendations.push('body_foundation', 'strategic_patience', 'resilience');
  if (wealth) recommendations.push('wealth_foundation', 'strategic_patience');
  if (parent && work) recommendations.push('home_front', 'resilience');
  if (normalized.some((role) => /(career|professional|leader|manager|operator)/.test(role))) recommendations.push('strategic_patience', 'resilience');
  if (/(burnout|all.or.nothing|recovery|crash|overwhelm)/.test(failures)) recommendations.push('resilience');
  const allowed = new Set(BUILTIN_TRACKS.map((track) => track.key));
  return [...new Set(recommendations)].filter((key) => allowed.has(key));
}


function actionPillar(graph: LifeGraphSnapshot, action: NextAction): PillarName | undefined {
  if (!action.goalId) return undefined;
  return graph.goals.find((goal) => goal.id === action.goalId)?.pillar;
}

export function selectMinimumViableAction(graph: LifeGraphSnapshot): NextAction | undefined {
  const open = graph.nextActions.filter((action) => action.status === 'open');
  if (open.length === 0) return undefined;

  const critical = new Set(
    graph.pillarSettings.filter((pillar) => pillar.active && pillar.critical).map((pillar) => pillar.name),
  );
  const criticalAction = open.find((action) => {
    const pillar = actionPillar(graph, action);
    return pillar ? critical.has(pillar) : false;
  });
  return criticalAction ?? open[0];
}

const VAGUE_ACTION_PATTERNS = [
  /^work on\b/i,
  /^review\b/i,
  /^think about\b/i,
  /^make progress\b/i,
  /^handle\b/i,
  /^deal with\b/i,
  /^focus on\b/i,
];

export function isExecutableActionTitle(title: string): boolean {
  const normalized = title.trim();
  if (normalized.length < 5) return false;
  return !VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function executableActionProblem(title: string): string | null {
  if (isExecutableActionTitle(title)) return null;
  return 'Ambiguity stop: define the physical action and observable output before execution.';
}

export interface ArbitrationCandidate {
  id: string;
  leverage: number;
  urgency: number;
  energyMatch: number;
  compounding: number;
  downside: number;
}

export interface ArbitrationResult {
  winnerId?: string;
  ranked: Array<{ id: string; score: number }>;
}

const clamp = (value: number) => Math.max(0, Math.min(10, value));

export function arbitrateForeground(candidates: ArbitrationCandidate[]): ArbitrationResult {
  const ranked = candidates
    .map((candidate) => ({
      id: candidate.id,
      score:
        clamp(candidate.leverage) * 0.25 +
        clamp(candidate.urgency) * 0.25 +
        clamp(candidate.energyMatch) * 0.15 +
        clamp(candidate.compounding) * 0.2 +
        clamp(candidate.downside) * 0.15,
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { winnerId: ranked[0]?.id, ranked };
}

export type GateVerdict = 'promote' | 'maintain' | 'park';

export function reviewGateVerdict(input: {
  progressScore: number;
  evidenceCount: number;
  stillAligned: boolean;
}): GateVerdict {
  if (!input.stillAligned) return 'park';
  if (input.progressScore >= 7 && input.evidenceCount > 0) return 'promote';
  if (input.progressScore >= 3 || input.evidenceCount > 0) return 'maintain';
  return 'park';
}

export function stabilizationDay(installedOn: string, today = new Date()): number {
  const start = new Date(`${installedOn.slice(0, 10)}T00:00:00.000Z`).getTime();
  const end = new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.min(7, Math.floor((end - start) / 86_400_000) + 1));
}


export function scoreDay(input: {
  completedCritical: number;
  requiredCritical: number;
  recoveryMode: boolean;
  mvdActionCompleted: boolean;
}): 'full_day' | 'mvd' | 'miss' {
  if (input.recoveryMode && input.mvdActionCompleted) return 'mvd';
  if (input.requiredCritical === 0) return input.mvdActionCompleted ? 'full_day' : 'miss';
  return input.completedCritical >= input.requiredCritical ? 'full_day' : 'miss';
}

export function coachingOpeningQuestion(mode: OperatingModeKey): string {
  switch (mode) {
    case 'recovery':
      return 'What is the smallest useful thing you can do today without making tomorrow harder?';
    case 'high_pressure':
      return 'What decision or action are you avoiding right now?';
    case 'executive_review':
      return "Here's what you already know that still makes you better:";
    case 'sprint':
      return 'What single sprint-critical output must exist before this window closes?';
    case 'deep_work':
      return 'What is the one task this uninterrupted block exists to finish?';
    default:
      return 'What feels most important to get clear on before you execute?';
  }
}

export function canMiddayReplan(reason: 'external_change' | 'safety' | 'permission' | 'mood' | 'discomfort'): boolean {
  return reason === 'external_change' || reason === 'safety' || reason === 'permission';
}

export function normalizeMorningSequence(sequence: string[]): string[] {
  return sequence.map((step) => step.trim()).filter(Boolean).slice(0, 5);
}
