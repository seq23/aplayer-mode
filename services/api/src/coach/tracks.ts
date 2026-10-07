import type { ActiveTrackKey, RetiredTrackKey, Track } from '@apm/domain';
import { TRACK_DISPLAY_NAMES } from '@apm/domain';

/**
 * Track library: the four BHPC v2.1 Tracks (Appendix A) and the three app-only
 * Tracks (docs/reference/BHPC-v2.1 research, 6 Oct 2026). Tracks are permanent
 * background decision filters, never task lists. Their RULES — not only their
 * names — are what coaching receives, and `trackChallenges` enforces the
 * "must challenge" clauses deterministically so the scripted coach honours them
 * without a model.
 */
export interface TrackDefinition {
  key: ActiveTrackKey;
  name: string;
  origin: 'bhpc' | 'app';
  purpose: string;
  rules: string[];
  coachingTone: string;
  mustChallenge: string[];
  filters: string[];
  /** Deterministic triggers: when the user's words match, the Track's challenge line is applied. */
  triggers: RegExp[];
  challenge: string;
  precedence?: string;
  /**
   * A Track whose filters apply to ALL guidance (BHPC Appendix A Track 1: "Coaching
   * Filters (Applied to All Guidance)"), not only when a trigger word appears.
   */
  guidance?: string;
}

export const ACTIVE_TRACK_KEYS = [
  'billionaire_mindset',
  'operator_discipline',
  'strategic_patience',
  'resilience',
  'body_foundation',
  'wealth_foundation',
  'home_front',
] as const satisfies readonly ActiveTrackKey[];

export const RETIRED_TRACK_KEYS = ['manifestation_mastery', 'investor_ai_leverage'] as const satisfies readonly RetiredTrackKey[];

export const TRACK_LIBRARY: Record<ActiveTrackKey, TrackDefinition> = {
  billionaire_mindset: {
    key: 'billionaire_mindset',
    name: TRACK_DISPLAY_NAMES.billionaire_mindset,
    origin: 'bhpc',
    purpose: 'Identity alignment with ownership, leverage, compounding and asymmetric decisions.',
    rules: [
      'Favor asymmetric upside over linear effort.',
      'Prefer ownership to income.',
      'Default to long-term compounding decisions.',
      'Evaluate opportunities using expected value thinking.',
      'Focus on leverage instead of activity.',
    ],
    coachingTone: 'Direct, strategic, oriented toward long-term value creation.',
    mustChallenge: ['opportunity evaluation', 'project prioritization', 'strategic decision framing'],
    filters: [
      'Long-horizon: is this decision still correct in 10 years?',
      'Asymmetry: what is the upside vs downside ratio?',
      'Downside containment: is the worst case survivable?',
      'Leverage: does this scale without me?',
    ],
    triggers: [/\b(opportunit(y|ies)|offer|deal|equity|invest(ing|ment)?|salary|raise money|side hustle)\b/i],
    challenge: 'Billionaire Mindset filters apply: it must still be right in 10 years, the worst case must be survivable, and it should scale without you.',
    // Declarative on purpose: a coach turn carries at most one question (assertCoachTurnContract).
    guidance: 'Billionaire filter on this move: favour leverage over activity and ownership over income; it should still be right in 10 years, its worst case must be survivable, and it should scale without you.',
    precedence: 'Wealth Foundation’s buffer gate governs personal money; Billionaire Mindset governs venture and business decisions.',
  },
  operator_discipline: {
    key: 'operator_discipline',
    name: TRACK_DISPLAY_NAMES.operator_discipline,
    origin: 'bhpc',
    purpose: 'Reduce renegotiation and increase follow-through when mood drops.',
    rules: [
      'Plans set in the morning are executed as written.',
      'Commitments are logged — if stated, they are recorded.',
      'Renegotiation requires explicit declaration — no quiet abandonment.',
      'Consistency over intensity — a lighter day executed beats a heavy day abandoned.',
      'Completion is the metric — not quality of execution.',
    ],
    coachingTone: 'Challenge every plan change. Separate facts from narratives.',
    mustChallenge: ['mid-day plan changes', 'scope reductions without declaration', 'renegotiation disguised as optimization'],
    filters: ['What would it take to execute this as written?'],
    triggers: [/\b(skip|push (it|this) to tomorrow|move (it|this) to tomorrow|change the plan|reschedul\w*|drop (it|this)|not today|bail)\b/i],
    challenge: 'Operator Discipline is active: the morning plan is executed as written. A change has to be declared explicitly, not drifted into.',
  },
  strategic_patience: {
    key: 'strategic_patience',
    name: TRACK_DISPLAY_NAMES.strategic_patience,
    origin: 'bhpc',
    purpose: 'Long-game positioning; tolerance for slow compounding.',
    rules: [
      'No pivot before the evaluation gate.',
      'Volatility is data — not a signal to change direction.',
      'Impatience must be declared before it influences decisions.',
      '30/60/90 gates are enforced — no early exits.',
      'Progress is measured in compounding trajectory, not short-term results.',
    ],
    coachingTone: 'Surface impatience explicitly; separate deadline-driven urgency from emotion-driven urgency.',
    mustChallenge: ['pivot requests before gate completion', 'urgency not tied to a real deadline', 'strategy changes driven by short-term results'],
    filters: ['Is this urgency deadline-driven or emotion-driven?'],
    triggers: [/\b(pivot|switch (to|direction)|start over|give up on|quit (the|this|my)|new direction|scrap (it|this))\b/i],
    challenge: 'Strategic Patience is active: no pivot before the evaluation gate. Volatility is data, not a signal to change direction.',
  },
  resilience: {
    key: 'resilience',
    name: TRACK_DISPLAY_NAMES.resilience,
    origin: 'bhpc',
    purpose: 'Protect recovery capacity so volatility does not damage continuity.',
    rules: [
      'Recovery is execution — rest days are strategic investment, not lost time.',
      'Systems must be stress-tested, not protected from stress.',
      'Continuity over perfection — showing up matters more than showing up perfectly.',
      'MVD is always available — no situation justifies full abandonment.',
      'Hard periods are data, not identity.',
    ],
    coachingTone: 'Normalize recovery. Challenge all-or-nothing framing.',
    mustChallenge: ['guilt or shame after missed days', 'all-or-nothing thinking about execution quality', 'pressure to "make up" for low-output periods'],
    filters: ['What is the minimum viable version that keeps continuity?'],
    triggers: [/\b(guilt\w*|ashamed|shame|i failed|failure|make up for|catch up|all or nothing|ruined|wasted (the|my) (day|week))\b/i],
    challenge: 'Resilience is active: hard periods are data, not identity. There is no making up for a low day — the Minimum Viable Day is always available.',
  },
  body_foundation: {
    key: 'body_foundation',
    name: TRACK_DISPLAY_NAMES.body_foundation,
    origin: 'app',
    purpose: 'Build the identity of a person who takes care of their body through small, tracked behaviours at a safe pace.',
    rules: [
      'Identity before outcome: each day logs at least one body behaviour.',
      'Track the behaviour, glance at the number; weigh-ins are optional and user-cadenced.',
      'Safe pace is the ceiling: ≤1% of body weight per week, capped at 0.9 kg (2 lb), unless a clinician supervises.',
      'One slip is a data point: the next planned meal or session is the recovery — no compensation.',
      'Movement floor every day: the user’s MVD, never zero.',
      'The app does not prescribe diet, calories, supplements or medication.',
    ],
    coachingTone: 'Calm, factual, identity-reinforcing. Name the behaviour, never the body. No shame, no appearance comments.',
    mustChallenge: ['targets faster than the safe-pace ceiling', 'compensatory behaviour after a slip', 'days with no body behaviour', 'programme-hopping before the Strategic Patience gate'],
    filters: ['Would the person I am becoming do this today?', 'Could I still do this in 12 months?', 'Is this within the safe-pace ceiling?', 'After a slip, what is the very next planned action?'],
    triggers: [/\b(crash diet|skip(ping)? meals?|punish\w*|double session|burn it off|earn (my|the) food|lose \d+ ?(lb|lbs|pounds|kg) (in|by)|fasting)\b/i],
    challenge: 'Body Foundation is active: one slip is a data point. The next planned meal or session is the recovery — no compensation, and pace stays within the safe ceiling.',
  },
  wealth_foundation: {
    key: 'wealth_foundation',
    name: TRACK_DISPLAY_NAMES.wealth_foundation,
    origin: 'app',
    purpose: 'Build personal wealth through behaviour rather than bets.',
    rules: [
      'Pay yourself first: saving is automated and happens before spending.',
      'Raise with raises: any income increase routes a pre-committed share to savings or debt.',
      'One debt at a time, in the user’s chosen order; closing an account is a logged win.',
      'Buffer before bets: speculative moves are flagged until the buffer target is met and high-interest debt is cleared.',
      'Recurring charges are reviewed on a schedule.',
      'The app does not advise on securities, crypto, tax, insurance or allocations.',
    ],
    coachingTone: 'Steady, unglamorous, pro-compounding. Name speculation as speculation, without judging. No shame about debt.',
    mustChallenge: ['speculative moves while the buffer is unmet', 'pausing automated savings without declaration', 'switching debt-payoff order mid-plan', 'new recurring commitments without review'],
    filters: ['If this goes to zero, is my buffer intact?', 'Will this happen without my willpower?', 'Is this the next debt on my list?', 'Is this recurring cost still earning its place?'],
    triggers: [/\b(crypto|bet|options trading|day trad\w*|get rich|speculat\w*|pause (my )?savings|stop (my )?savings|all in)\b/i],
    challenge: 'Wealth Foundation is active: buffer before bets. If this went to zero, your buffer must still be intact — and this is not product or investment advice.',
    precedence: 'For personal money, Wealth Foundation’s buffer gate takes precedence over Billionaire Mindset.',
  },
  home_front: {
    key: 'home_front',
    name: TRACK_DISPLAY_NAMES.home_front,
    origin: 'app',
    purpose: 'Protect presence and family time while playing a second game.',
    rules: [
      'Family blocks are fixed commitments — never renegotiated quietly.',
      'Presence means the phone is away; work items do not surface in protected blocks.',
      'Work/family conflicts are decided ahead of time, never in the moment.',
      'Each workday has a declared hard stop; work after it is declared, not drifted into.',
      'The minimum floor at home is non-zero: one protected touchpoint every day.',
    ],
    coachingTone: 'Warm but firm. Family time is treated like the most important meeting of the week. No guilt about work.',
    mustChallenge: ['work over a protected family block', 'unresolved work/family conflicts in the lead window', 'work after the hard stop', 'days with no family touchpoint'],
    filters: ['Will I be fully there?', 'Which matters more in ten years, this hour of work or this hour at home?', 'Has this conflict been decided before the day?', 'What is today’s one protected touchpoint?'],
    triggers: [/\b(work (late|tonight|this weekend)|miss(ing)? (dinner|bedtime|pickup|the game|the recital|family)|after hours|skip (dinner|bedtime))\b/i],
    challenge: 'Home Front is active: family blocks are fixed commitments, and conflicts are decided ahead of time — not in the moment.',
  },
};

export function isActiveTrackKey(value: string): value is ActiveTrackKey {
  return (ACTIVE_TRACK_KEYS as readonly string[]).includes(value);
}

export function activeTrackDefinitions(tracks: Track[]): TrackDefinition[] {
  return tracks
    .filter((track) => track.active && isActiveTrackKey(track.key))
    .map((track) => TRACK_LIBRARY[track.key]);
}

/** Minimum-necessary Track context for a coaching model: rules, filters, tone and precedence — no user data. */
export function trackRulesForCoaching(tracks: Track[]) {
  return activeTrackDefinitions(tracks).map((track) => ({
    name: track.name,
    rules: track.rules,
    coachingTone: track.coachingTone,
    mustChallenge: track.mustChallenge,
    filters: track.filters,
    ...(track.precedence ? { precedence: track.precedence } : {}),
  }));
}

/**
 * Filters that apply to all guidance (Track 1), for every active Track that declares
 * them and whose challenge did not already fire in this answer.
 */
export function trackGuidance(tracks: Track[], alreadyChallenged: ActiveTrackKey[]): string[] {
  return activeTrackDefinitions(tracks)
    .filter((track) => track.guidance && !alreadyChallenged.includes(track.key))
    .map((track) => track.guidance!);
}

/** Deterministic "must challenge" enforcement: at most two Track challenges, in library order. */
export function trackChallenges(tracks: Track[], text: string): Array<{ key: ActiveTrackKey; line: string }> {
  return activeTrackDefinitions(tracks)
    .filter((track) => track.triggers.some((pattern) => pattern.test(text)))
    .slice(0, 2)
    .map((track) => ({ key: track.key, line: track.challenge }));
}
