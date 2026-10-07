import type { DailyPlan, LifeGraphSnapshot, OperatingModeKey, Track } from '@apm/domain';
import { normalizeMorningSequence } from '@apm/planning';
import { buildExecutiveReview, type ExecutiveReview } from './executiveReview';
import { MODE_LIBRARY, type ModeRequest, type ModeState } from './modes';
import {
  assessSafety,
  CRISIS_MESSAGE,
  CRISIS_RESOURCES,
  MEDICAL_MESSAGE,
  MEDICAL_RESOURCES,
  THERAPY_SCOPE_NOTE,
  type SafetyLevel,
  type SafetyResource,
} from './safety';
import { trackChallenges } from './tracks';

/**
 * The BHPC coaching state machine (Part I "like tennis", Part V Phase 2,
 * Coaching Closure & Morning Sequence, System Guardrails):
 *
 *   exploring ──(one question per turn, mode budget)──▶ synthesis + next move
 *        ▲                                                   │
 *        └──────────────── go deeper ◀── closure_offered ◀───┘
 *                                             │ close
 *                                             ▼
 *                         morning_sequence ──(chat instead)──▶ redirect
 *                                             │ done
 *                                             ▼
 *                                           closed
 *
 * Crisis or medical language in ANY phase → safety_stop (terminal for the session).
 * Every turn ends in a question, a choice or a confirmation (No Silent States).
 * The machine is fully deterministic; a privacy-approved model may only rewrite
 * the text of a `question` or `synthesis` slot, and only if that rewrite passes
 * the same validators (see coaching.ts).
 */
export type CoachPhase = 'exploring' | 'closure_offered' | 'morning_sequence' | 'closed' | 'safety_stop';

export type CoachChoice =
  | 'close_and_launch'
  | 'go_deeper'
  | 'sequence_done'
  | 'stay_in_block'
  | 'end_block_early'
  | 'im_safe'
  | 'need_help_now'
  | 'open_today'
  | 'end_session';

export const COACH_CHOICES: readonly CoachChoice[] = [
  'close_and_launch', 'go_deeper', 'sequence_done', 'stay_in_block', 'end_block_early', 'im_safe', 'need_help_now', 'open_today', 'end_session',
];

export interface CoachSessionState {
  phase: CoachPhase;
  questionsAsked: number;
  deeperRounds: number;
}

export interface CoachPrompt {
  kind: 'question' | 'choice' | 'confirm';
  text: string;
  options: Array<{ id: CoachChoice; label: string }>;
}

export type CoachStep =
  | 'opening'
  | 'ask'
  | 'synthesize'
  | 'offer_closure'
  | 'launch_sequence'
  | 'redirect_to_sequence'
  | 'sequence_complete'
  | 'executive_review'
  | 'deferred_deep_work'
  | 'deep_work_ended'
  | 'safety_stop'
  | 'safety_followup';

export interface CoachTurn {
  step: CoachStep;
  session: CoachSessionState;
  reply: string;
  prompt: CoachPrompt;
  nextMove?: string;
  morningSequence?: string[];
  review?: ExecutiveReview;
  safety?: { level: SafetyLevel; signals: string[]; resources: SafetyResource[] };
  boundaryNote?: string;
  trackChallenges: string[];
  closeSession: boolean;
  modeRequest?: ModeRequest;
  modelSlot?: 'question' | 'synthesis';
}

export interface CoachContext {
  mode: OperatingModeKey;
  modeState: ModeState;
  graph: LifeGraphSnapshot;
  plan: DailyPlan;
  now: Date;
  /** Earlier user messages in this session, oldest first (the current one is NOT included). */
  priorUserMessages: string[];
}

export interface CoachInput {
  message?: string;
  choice?: CoachChoice;
}

export const QUESTION_BUDGET: Record<OperatingModeKey, number> = {
  standard: 3,
  high_pressure: 2,
  recovery: 2,
  sprint: 1,
  executive_review: 0,
  deep_work: 0,
};
export const MAX_DEEPER_ROUNDS = 2;

/** Scripted BHPC question flow: internal state → observable behaviour → meaning (Part V Phase 2). */
export const QUESTION_BANK: Record<'standard' | 'high_pressure' | 'recovery' | 'sprint', { core: string[]; deeper: string[] }> = {
  standard: {
    core: [
      'What feels most stuck right now — time, energy, or confidence?',
      'What decision or action are you avoiding because of that?',
      'What are you telling yourself that means?',
    ],
    deeper: [
      'What would make the next step small enough to start in the next ten minutes?',
      'What is one fact — not a feeling — that would change the decision?',
    ],
  },
  high_pressure: {
    core: [
      'What decision or action are you avoiding right now?',
      'What does it cost you if that stays avoided for seven more days?',
    ],
    deeper: [
      'What assumption would have to be false for the avoided move to be the wrong one?',
      'What would you do first if you trusted your own plan completely?',
    ],
  },
  recovery: {
    core: [
      'What feels heaviest right now?',
      'What is the smallest useful thing you can do today without making tomorrow harder?',
    ],
    deeper: [
      'What could you take off today’s plate without breaking anything that matters?',
      'Who or what could make the minimum easier today?',
    ],
  },
  sprint: {
    core: ['What single sprint-critical output must exist before this window closes?'],
    deeper: ['What is blocking that output in the next hour?', 'What can wait until the sprint is over?'],
  },
};

export const CLOSURE_QUESTION = 'Would you like to close coaching and begin your Morning Sequence, or go deeper?';
export const SEQUENCE_CONFIRM = 'Tell me when you’re done.';
export const SEQUENCE_REDIRECT = 'Let’s run your Morning Sequence first. I’ll be here after you complete it.';
export const DEFAULT_MORNING_SEQUENCE = ['Drink a glass of water', 'Stand up and stretch for 60 seconds', 'Open the first item on Today'];

const DONE_PATTERN = /^\s*(done|i'?m done|finished|complete(d)?|did it|all done|sequence (done|complete))\b/i;
const CLOSE_PATTERN = /^\s*(yes|y|yep|close|close it|begin|start|launch|let'?s go|ok(ay)?|morning sequence)\b/i;
const DEEPER_PATTERN = /\b(go deeper|deeper|keep going|more)\b/i;

const closurePrompt = (allowDeeper: boolean): CoachPrompt => allowDeeper
  ? { kind: 'question', text: CLOSURE_QUESTION, options: [{ id: 'close_and_launch', label: 'Close and begin my Morning Sequence' }, { id: 'go_deeper', label: 'Go deeper' }] }
  : { kind: 'question', text: 'We’ve gone as deep as one session should. Close coaching and begin your Morning Sequence?', options: [{ id: 'close_and_launch', label: 'Close and begin my Morning Sequence' }] };

const sequencePrompt: CoachPrompt = { kind: 'confirm', text: SEQUENCE_CONFIRM, options: [{ id: 'sequence_done', label: 'Done' }] };
const safetyPrompt: CoachPrompt = { kind: 'question', text: 'Are you safe right now?', options: [{ id: 'im_safe', label: 'I’m safe right now' }, { id: 'need_help_now', label: 'I need help now' }] };
const afterSafePrompt: CoachPrompt = { kind: 'question', text: 'Would you like to open Today, or end here?', options: [{ id: 'open_today', label: 'Open Today' }, { id: 'end_session', label: 'End here' }] };
const openTodayPrompt: CoachPrompt = { kind: 'question', text: 'Open Today and start your next move?', options: [{ id: 'open_today', label: 'Open Today' }] };
const question = (text: string): CoachPrompt => ({ kind: 'question', text, options: [] });

const quote = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').replace(/[?]+/g, '').trim().slice(0, 120);

export function nextMoveFor(plan: DailyPlan): string {
  return plan.numberOneMove?.title ?? 'Write the one physical next action for today on Today, then start it';
}

export function morningSequenceFor(graph: LifeGraphSnapshot): string[] {
  const steps = normalizeMorningSequence(graph.personalOS?.morningSequence ?? []);
  return steps.length ? steps : DEFAULT_MORNING_SEQUENCE;
}

function bankFor(mode: OperatingModeKey) {
  if (mode === 'high_pressure' || mode === 'recovery' || mode === 'sprint') return QUESTION_BANK[mode];
  return QUESTION_BANK.standard;
}

function questionAt(mode: OperatingModeKey, index: number): string {
  const bank = bankFor(mode);
  const budget = Math.max(1, QUESTION_BUDGET[mode]);
  if (index < bank.core.length && index < budget) return bank.core[index]!;
  const deeperIndex = Math.max(0, index - budget);
  return bank.deeper[Math.min(deeperIndex, bank.deeper.length - 1)]!;
}

export function scriptedSynthesis(mode: OperatingModeKey, userMessages: string[], nextMove: string, tracks: Track[]): { text: string; challenges: string[] } {
  const [opener, a0, a1, a2] = [quote(userMessages[0]), quote(userMessages[1]), quote(userMessages[2]), quote(userMessages[3])];
  const challenges = trackChallenges(tracks, userMessages.join(' ')).map((entry) => entry.line);
  let body: string;
  switch (mode) {
    case 'high_pressure':
      body = [
        `1. Your stated problem${opener ? ` — “${opener}”` : ''} — is the symptom, not the problem.`,
        a0 ? `2. The move you’re avoiding: “${a0}”.` : '2. The move you’re avoiding is the one you keep circling.',
        a1 ? `3. The cost of waiting: “${a1}”.` : '3. Waiting has a cost, and it compounds.',
        `4. Highest-leverage move: ${nextMove}.`,
        ...challenges.map((line, index) => `${5 + index}. ${line}`),
        `Stabilizing directive: ${nextMove} — start it now.`,
      ].join('\n');
      return { text: body, challenges };
    case 'recovery':
      body = [
        'No catch-up and no evaluation today.',
        a0 ? `You named “${a0}”.` : '',
        `The smallest move that keeps continuity: ${nextMove}. Doing that one thing counts as a win.`,
        ...challenges,
      ].filter(Boolean).join(' ');
      return { text: body, challenges };
    case 'sprint':
      body = [
        'Sprint rule: one foreground output only.',
        a0 ? `The sprint-critical output: “${a0}”.` : '',
        `Next move: ${nextMove}. No new scope until the sprint closes.`,
        ...challenges,
      ].filter(Boolean).join(' ');
      return { text: body, challenges };
    default: {
      const lines = ['Here’s what you surfaced:'];
      if (a0) lines.push(`• Where it’s stuck: “${a0}”`);
      if (a1) lines.push(`• What it’s showing up as: “${a1}”`);
      if (a2) lines.push(`• What you’re making it mean: “${a2}”`);
      if (lines.length === 1 && opener) lines.push(`• What you brought: “${opener}”`);
      lines.push(...challenges);
      lines.push(`That’s friction, not a verdict on you. Here’s the move: ${nextMove}.`);
      return { text: lines.join('\n'), challenges };
    }
  }
}

function formatTime(isoValue: string | undefined, timezone?: string): string {
  if (!isoValue) return 'the end of the block';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(isoValue));
  } catch {
    return isoValue;
  }
}

function base(session: CoachSessionState, overrides: Partial<CoachTurn> & Pick<CoachTurn, 'step' | 'reply' | 'prompt'>): CoachTurn {
  return { session, trackChallenges: [], closeSession: false, ...overrides };
}

export function decideTurn(current: CoachSessionState, input: CoachInput, context: CoachContext): CoachTurn {
  const { mode, graph, plan } = context;
  const text = (input.message ?? '').trim();
  const choice = input.choice;
  const nextMove = nextMoveFor(plan);
  const session: CoachSessionState = current.phase === 'closed' ? { phase: 'exploring', questionsAsked: 0, deeperRounds: 0 } : { ...current };

  // 1. A safety-stopped session never resumes coaching.
  if (session.phase === 'safety_stop') {
    if (choice === 'im_safe') {
      return base(session, { step: 'safety_followup', reply: 'Thank you for telling me. Coaching stays paused for this session. Reaching someone you trust or a licensed professional is still a good move today. A fresh session is there whenever you choose.', prompt: afterSafePrompt, closeSession: true });
    }
    if (choice === 'open_today' || choice === 'end_session') {
      return base(session, { step: 'safety_followup', reply: 'This session is closed. The resources stay one tap away on this screen.', prompt: afterSafePrompt, closeSession: true });
    }
    return base(session, {
      step: 'safety_followup',
      reply: choice === 'need_help_now'
        ? 'Please call or text 988 now (US), or your local emergency number if you are in immediate danger. If you are outside the US, findahelpline.com lists a free line near you.'
        : CRISIS_MESSAGE,
      prompt: safetyPrompt,
      safety: { level: 'crisis', signals: [], resources: CRISIS_RESOURCES },
      closeSession: true,
    });
  }

  // 2. Not-therapy boundary, checked on every message before anything else.
  const safety = assessSafety(text);
  if (safety.level === 'crisis' || safety.level === 'medical') {
    const crisis = safety.level === 'crisis';
    return base({ ...session, phase: 'safety_stop' }, {
      step: 'safety_stop',
      reply: crisis ? CRISIS_MESSAGE : MEDICAL_MESSAGE,
      prompt: safetyPrompt,
      safety: { level: safety.level, signals: safety.signals, resources: crisis ? CRISIS_RESOURCES : MEDICAL_RESOURCES },
      closeSession: true,
    });
  }
  const boundaryNote = safety.level === 'therapy_scope' ? THERAPY_SCOPE_NOTE : undefined;

  // 3. Deep Work: no coaching, check-ins or interruptions during the block.
  if (mode === 'deep_work') {
    if (choice === 'end_block_early') {
      const resumeMode = context.modeState.resume?.mode ?? 'standard';
      return base({ phase: 'exploring', questionsAsked: 0, deeperRounds: 0 }, {
        step: 'deep_work_ended',
        reply: `Deep Work block ended early. You’re back in ${MODE_LIBRARY[resumeMode].name}.`,
        prompt: question(questionAt(resumeMode, 0)),
        modeRequest: { action: 'exit' },
      });
    }
    return base(session, {
      step: 'deferred_deep_work',
      reply: `Deep Work block in progress until ${formatTime(context.modeState.endsAt, graph.identity.timezone)}: “${context.modeState.focus ?? 'your one task'}”. No coaching or check-ins during the block — the work is the point.`,
      prompt: { kind: 'question', text: 'Stay in the block, or end it early?', options: [{ id: 'stay_in_block', label: 'Stay in the block' }, { id: 'end_block_early', label: 'End the block early' }] },
    });
  }

  // 4. Morning Sequence launched: hold the user to it.
  const sequence = morningSequenceFor(graph);
  if (session.phase === 'morning_sequence') {
    if (choice === 'sequence_done' || DONE_PATTERN.test(text)) {
      return base({ ...session, phase: 'closed' }, {
        step: 'sequence_complete',
        reply: `Morning Sequence complete. Coaching is closed and the day has started. Your next move: ${nextMove}.`,
        prompt: openTodayPrompt,
        nextMove,
        closeSession: true,
        modeRequest: mode === 'executive_review' ? { action: 'exit' } : undefined,
      });
    }
    return base(session, {
      step: 'redirect_to_sequence',
      reply: [SEQUENCE_REDIRECT, ...sequence.map((step, index) => `${index + 1}. ${step}`)].join('\n'),
      prompt: sequencePrompt,
      morningSequence: sequence,
      nextMove,
    });
  }

  // 5. Closure offered: close into the Morning Sequence, or go deeper.
  if (session.phase === 'closure_offered') {
    const allowDeeper = session.deeperRounds < MAX_DEEPER_ROUNDS;
    if (choice === 'close_and_launch' || (!choice && CLOSE_PATTERN.test(text))) {
      return base({ ...session, phase: 'morning_sequence' }, {
        step: 'launch_sequence',
        reply: ['Coaching closed. Your Morning Sequence:', ...sequence.map((step, index) => `${index + 1}. ${step}`)].join('\n'),
        prompt: sequencePrompt,
        morningSequence: sequence,
        nextMove,
      });
    }
    if ((choice === 'go_deeper' || (!choice && DEEPER_PATTERN.test(text))) && allowDeeper) {
      if (mode === 'executive_review') {
        const resumeMode = context.modeState.resume?.mode ?? 'standard';
        return base({ phase: 'exploring', questionsAsked: 1, deeperRounds: session.deeperRounds + 1 }, {
          step: 'ask',
          reply: `Executive Review closed. Going deeper in ${MODE_LIBRARY[resumeMode].name} coaching.`,
          prompt: question(questionAt(resumeMode, 0)),
          modeRequest: { action: 'exit' },
          modelSlot: 'question',
        });
      }
      const asked = session.questionsAsked;
      return base({ phase: 'exploring', questionsAsked: asked + 1, deeperRounds: session.deeperRounds + 1 }, {
        step: 'ask', reply: boundaryNote ?? '', boundaryNote, prompt: question(questionAt(mode, asked)), modelSlot: 'question',
      });
    }
    return base(session, { step: 'offer_closure', reply: boundaryNote ?? 'Let’s close the loop first.', boundaryNote, prompt: closurePrompt(allowDeeper), nextMove });
  }

  // 6. Exploring.
  if (mode === 'executive_review') {
    const review = buildExecutiveReview(graph, plan, context.now);
    return base({ ...session, phase: 'closure_offered' }, {
      step: 'executive_review', reply: review.text, review, prompt: closurePrompt(session.deeperRounds < MAX_DEEPER_ROUNDS), nextMove,
    });
  }
  if (!text && session.questionsAsked === 0) {
    return base(session, { step: 'opening', reply: '', prompt: question(questionAt(mode, 0)) });
  }
  if (!text) {
    return base(session, { step: 'ask', reply: '', prompt: question(questionAt(mode, Math.max(0, session.questionsAsked - 1))) });
  }

  const budget = QUESTION_BUDGET[mode] + session.deeperRounds;
  if (session.questionsAsked < budget) {
    return base({ ...session, questionsAsked: session.questionsAsked + 1 }, {
      step: 'ask', reply: boundaryNote ?? '', boundaryNote, prompt: question(questionAt(mode, session.questionsAsked)), modelSlot: 'question',
    });
  }

  const synthesis = scriptedSynthesis(mode, [...context.priorUserMessages, text], nextMove, graph.tracks);
  return base({ ...session, phase: 'closure_offered' }, {
    step: 'synthesize',
    reply: boundaryNote ? `${boundaryNote}\n${synthesis.text}` : synthesis.text,
    boundaryNote,
    trackChallenges: synthesis.challenges,
    prompt: closurePrompt(session.deeperRounds < MAX_DEEPER_ROUNDS),
    nextMove,
    modelSlot: 'synthesis',
  });
}

// ---------- validators (also applied to model rewrites) ----------

const questionMarks = (value: string) => (value.match(/\?/g) ?? []).length;

/** No Silent States + one question at a time, for every turn the coach emits. */
export function assertCoachTurnContract(turn: Pick<CoachTurn, 'reply' | 'prompt'>): void {
  const prompt = turn.prompt;
  if (!prompt || !prompt.text.trim()) throw new Error('silent_state: every coaching turn must end in a question, choice or confirmation');
  if (prompt.kind === 'question' && !prompt.text.trim().endsWith('?')) throw new Error('silent_state: question prompt must end with "?"');
  if (prompt.kind !== 'question' && prompt.options.length === 0) throw new Error('silent_state: choice/confirm prompt needs at least one option');
  const total = questionMarks(turn.reply) + questionMarks(prompt.text);
  if (total > 1) throw new Error('one_question: a coaching turn may ask at most one question');
  if (prompt.kind === 'question' && questionMarks(turn.reply) !== 0) throw new Error('one_question: the only question must be the closing prompt');
}

export function isValidModelQuestion(text: string): boolean {
  const value = text.trim();
  return value.length >= 8 && value.length <= 300 && questionMarks(value) === 1 && value.endsWith('?') && !/morning sequence/i.test(value);
}

export function isValidModelSynthesis(text: string, mode: OperatingModeKey): boolean {
  const value = text.trim();
  if (value.length < 20 || value.length > 1200 || questionMarks(value) !== 0) return false;
  if (mode === 'high_pressure' && !/^\s*1\./m.test(value)) return false;
  return true;
}
