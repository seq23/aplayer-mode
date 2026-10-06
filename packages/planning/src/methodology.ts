import type {
  LifeGraphSnapshot,
  NextAction,
  OperatingModeKey,
  PillarName,
  TrackKey,
} from '@apm/domain';

export const CORE_LAWS = [
  { key: 'never_miss_twice', label: 'Never Miss Twice' },
  { key: 'continuity_over_intensity', label: 'Continuity > Intensity' },
  { key: 'no_catch_up', label: 'No Catch-Up' },
  { key: 'no_midday_negotiation', label: 'No Mid-Day Negotiation' },
  { key: 'zeros_allowed', label: 'Zeros Are Allowed' },
  { key: 'minimum_viable_day', label: 'Minimum Viable Day' },
] as const;

export const BUILTIN_TRACKS: ReadonlyArray<{
  key: TrackKey;
  name: string;
  description: string;
}> = [
  {
    key: 'billionaire_mindset',
    name: 'Billionaire Mindset',
    description: 'Ownership, leverage, compounding and asymmetric upside.',
  },
  {
    key: 'operator_discipline',
    name: 'Operator Discipline',
    description: 'Follow-through, reduced renegotiation and execution consistency.',
  },
  {
    key: 'strategic_patience',
    name: 'Strategic Patience',
    description: 'Prevents premature pivots before evidence and gates justify change.',
  },
  {
    key: 'manifestation_mastery',
    name: 'Manifestation Mastery',
    description: 'Identity, expectancy and alignment without overriding evidence or execution.',
  },
  {
    key: 'investor_ai_leverage',
    name: 'Investor + AI Leverage',
    description: 'Opportunity recognition, capital allocation and AI as a force multiplier.',
  },
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

export function recommendTrackKeys(roles: string[]): TrackKey[] {
  const normalized = roles.map((role) => role.toLowerCase());
  const recommendations: TrackKey[] = ['operator_discipline'];
  if (normalized.some((role) => BUSINESS_ROLE_MARKERS.some((marker) => role.includes(marker)))) {
    recommendations.push('billionaire_mindset', 'strategic_patience');
  }
  return [...new Set(recommendations)];
}

export interface RuntimeModeSignals {
  requestedMode?: OperatingModeKey;
  mood?: number;
  overwhelmed?: boolean;
  missedYesterday?: boolean;
}

export function resolveRuntimeMode(signals: RuntimeModeSignals): OperatingModeKey {
  if (signals.requestedMode && signals.requestedMode !== 'standard') return signals.requestedMode;
  if (signals.missedYesterday || signals.overwhelmed || (signals.mood !== undefined && signals.mood <= 2)) {
    return 'recovery';
  }
  return signals.requestedMode ?? 'standard';
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

export function coachingOpeningQuestion(mode: OperatingModeKey): string {
  switch (mode) {
    case 'recovery':
      return 'What is the smallest useful thing you can do today without making tomorrow harder?';
    case 'high_pressure':
      return 'What decision or action are you avoiding right now?';
    case 'executive_review':
      return 'What is creating the most noise or ambiguity in your current system?';
    default:
      return 'What feels most important to get clear on before you execute?';
  }
}
