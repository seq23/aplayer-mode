import type { PillarName } from '@apm/domain';
import { FLOOR_CHIPS, GAMES, GOAL_TEMPLATES, SECTIONS } from './bank.js';
import type {
  AnswerValue,
  GameKey,
  GateHelpers,
  GoalTemplate,
  IntakeAnswers,
  IntakeMode,
  QuestionDef,
  Screen,
} from './types.js';

/**
 * The intake engine: the question bank, the gates, the path, the cursor, prefill and
 * progress. Pure and synchronous, so every screen change runs on the device in well under
 * 100 ms (docs/34 §6.1) and the same rules are testable in Node.
 *
 * Persistence rule (docs/34 §6): an answer exists the moment it is tapped. The app stores
 * answers in the draft store (draft.ts) and the screen reads them from there; nothing here
 * keeps state.
 */

const arr = (a: IntakeAnswers, id: string): string[] => (Array.isArray(a[id]) ? (a[id] as string[]) : []);
const str = (a: IntakeAnswers, id: string): string | undefined => (typeof a[id] === 'string' ? (a[id] as string) : undefined);
const num = (a: IntakeAnswers, id: string): number | undefined => (typeof a[id] === 'number' ? (a[id] as number) : undefined);

export const gameIds = (a: IntakeAnswers): GameKey[] => arr(a, 'games') as GameKey[];

/** The foreground game: the Q2 answer, else the only game picked. */
export function foregroundGame(a: IntakeAnswers): GameKey {
  return (str(a, 'foreground') as GameKey | undefined) ?? gameIds(a)[0] ?? 'founder';
}

export function goalTemplates(a: IntakeAnswers): readonly GoalTemplate[] {
  return GOAL_TEMPLATES[foregroundGame(a)] ?? GOAL_TEMPLATES.founder;
}

export function chosenGoal(a: IntakeAnswers): GoalTemplate | undefined {
  return goalTemplates(a).find((goal) => goal.id === a.goal);
}

export function pillarOn(a: IntakeAnswers, pillar: PillarName): boolean {
  return Array.isArray(a.core_pillars) ? (a.core_pillars as string[]).includes(pillar) : true;
}

export const helpers: GateHelpers = {
  any: (a, ...games) => gameIds(a).some((game) => games.includes(game)),
  goalHasSize: (a) => Boolean(chosenGoal(a)?.size),
  bodyOn: (a) => gameIds(a).some((game) => game === 'weight' || game === 'athlete') || pillarOn(a, 'body'),
  pillarOn,
  tough: (a) => (num(a, 'load') ?? 7) >= 8 || ['recovering', 'rebuilding'].includes(str(a, 'season') ?? ''),
};

export const ALL_QUESTIONS: readonly QuestionDef[] = SECTIONS.flatMap((section) => section.questions);

export function questionById(id: string): QuestionDef | undefined {
  return ALL_QUESTIONS.find((q) => q.id === id);
}

export const gameLabel = (game: string) => GAMES.find(([key]) => key === game)?.[1] ?? game;

/** Screens after the questions (R1 to R6 are detail screens opened from the summary). */
export const REVEAL_SCREENS: ReadonlyArray<{ id: string; kind: Screen['kind']; label: string; detail?: boolean }> = [
  { id: 'building', kind: 'building', label: 'Building your OS' },
  { id: 'summary', kind: 'summary', label: 'Your operating system' },
  { id: 'r1', kind: 'detail', label: 'Your pillars', detail: true },
  { id: 'r2', kind: 'detail', label: 'Your foreground', detail: true },
  { id: 'r3', kind: 'detail', label: 'Your Tracks', detail: true },
  { id: 'r4', kind: 'detail', label: 'Your operating rules', detail: true },
  { id: 'r5', kind: 'detail', label: 'Your morning', detail: true },
  { id: 'r6', kind: 'detail', label: 'Your first 7 days', detail: true },
  // The paywall: the existing Phase D plan screen, after the summary, before Day 1.
  { id: 'plan', kind: 'plan', label: 'Choose your plan' },
];

/** The "taken off your plate" line of every non-question screen (docs/34 §8). */
export const SCREEN_PLATES: Readonly<Record<string, string>> = {
  welcome: 'Your brain stops holding every project, role, rule and restart alone.',
  acct: 'So nothing you\'ve told APM is lost.',
  express: 'You decide how much setup today. Nothing you skip is lost; it waits on Today.',
  building: 'Taken off your plate: designing your own system.',
  summary: 'Everything above is already decided. Change anything with one tap, or just install.',
  r1: 'You maintain the background. APM makes sure nothing silently collapses.',
  r2: 'One priority gets your best energy. The rest is maintenance, already scheduled.',
  r3: 'These filters run in the background. You never have to remember them.',
  r4: 'The rules are set while your mind is clear, so you don\'t renegotiate them at 2 PM.',
  r5: 'Your agenda comes to you. You never have to ask for it.',
  r6: 'Week 1 has one job: show up. APM handles the rest.',
  plan: 'Every tier lifts load. Higher tiers lift more.',
  today: 'Do only the first item. Then stop. This is relief, not productivity.',
};

/**
 * What APM does with each thing she taps on "What are you carrying", and which plan does it.
 * The plan is the INTERNAL key; the app renders its ONE display name from @apm/policy
 * PLAN_PRICES (ADR-0006), so a plan name is never retyped here. `needs` names a connection.
 */
export type CarryPlan = 'chief_of_staff' | 'life_os';
export const CARRY_DO: Readonly<Record<string, readonly [label: string, does: string, plan: CarryPlan, needs?: string]>> = {
  deadlines: ['Deadlines', 'Radar counts down each date and warns you a week out.', 'chief_of_staff'],
  money: ['Money worries', 'One money move a week, in the right order: buffer, then debt, then investing.', 'chief_of_staff'],
  family_logistics: ['Family logistics', 'Protected family moments are booked before work.', 'chief_of_staff'],
  health: ['Health goals', 'One small body step a day at a safe pace.', 'chief_of_staff'],
  replies: ['Messages I owe', 'Radar lists who is waiting on you once you connect email (offered on Day 2). Higher plans draft the replies.', 'chief_of_staff', 'email'],
  big_decision: ['A big decision', 'Parked on Radar with a decide-by date, so it stops looping.', 'chief_of_staff'],
  too_many: ['Too many projects', 'One foreground. Everything else is parked or maintained, in writing.', 'chief_of_staff'],
  restarting: ['Restarting (again)', 'No catch-up, ever. A miss shrinks the next day instead of resetting you.', 'chief_of_staff'],
  appointments: ['Appointments and forms', 'Tracked and prepared ahead of time.', 'life_os'],
  bills: ['Bills and renewals', 'Due dates and renewals watched; price rises flagged.', 'life_os'],
};

/** The full screen registry for these answers (every screen, gated ones marked `on: false`). */
export function registry(a: IntakeAnswers, mode: IntakeMode | undefined = str(a, 'mode') as IntakeMode | undefined): Screen[] {
  const out: Screen[] = [];
  const quick = mode === 'quick';
  let past = false;
  for (const section of SECTIONS) {
    if (section.kind === 'account') { out.push({ id: 'acct', kind: 'account', group: 'Account', on: true }); continue; }
    if (section.kind === 'express') { past = true; out.push({ id: 'express', kind: 'express', group: 'Choice', on: true }); continue; }
    const sectionOn = section.gate ? section.gate(a, helpers) : true;
    for (const question of section.questions) {
      const on = sectionOn && (question.gate ? question.gate(a, helpers) : true) && (!quick || !past || question.essential === true);
      out.push({ id: question.id, kind: 'question', group: section.name, question, section, on });
    }
    // Owner ruling (7 Oct 2026): the questionnaire is questions only. Breaks that ask nothing are never
    // in the path; their content lives in the summary and its detail screens at the end.
    if (section.after) out.push({ id: section.after.id, kind: 'interstitial', group: section.name, section, interstitial: section.after, on: false });
  }
  for (const screen of REVEAL_SCREENS) out.push({ id: screen.id, kind: screen.kind, group: 'Your OS', on: !screen.detail, detail: screen.detail === true });
  return out;
}

export const path = (a: IntakeAnswers, mode?: IntakeMode) => registry(a, mode).filter((screen) => screen.on);
export const questionPath = (a: IntakeAnswers, mode?: IntakeMode) => path(a, mode).filter((screen) => screen.kind === 'question');

export function answered(question: QuestionDef, a: IntakeAnswers): boolean {
  const value = a[question.id];
  return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
}

export function options(question: QuestionDef, a: IntakeAnswers): Array<[string, string]> {
  const source = question.options;
  if (Array.isArray(source)) return source.map(([v, l]) => [v, l]);
  if (source === 'fromGames') return gameIds(a).map((game) => [game, gameLabel(game)]);
  if (source === 'fromIncome') {
    const income = questionById('income')!.options as ReadonlyArray<readonly [string, string]>;
    return arr(a, 'income').filter((x) => x !== 'none').map((x) => [x, income.find(([v]) => v === x)?.[1] ?? x]);
  }
  if (source === 'goalTemplates') return goalTemplates(a).map((goal) => [goal.id, goal.label]);
  if (source === 'goalSteps') return [...(chosenGoal(a) ?? goalTemplates(a)[0]!).steps].map((s) => [s, s]);
  if (source === 'floorOptions') {
    const out: Array<[string, string]> = [];
    for (const key of [...gameIds(a), '_all'] as Array<GameKey | '_all'>) {
      for (const chip of FLOOR_CHIPS[key] ?? []) if (!out.some(([v]) => v === chip.label)) out.push([chip.label, chip.label]);
    }
    return out;
  }
  return [];
}

export function optionLabel(questionId: string, value: string, a: IntakeAnswers = {}): string {
  const question = questionById(questionId);
  if (!question) return value;
  return options(question, a).find(([v]) => v === value)?.[1] ?? value;
}

export interface SliderSpec { min: number; max: number; step: number; unit: string; def: number; title: string; lo?: string; hi?: string }

export function sliderSpec(question: QuestionDef, a: IntakeAnswers): SliderSpec {
  if (question.title === 'goalSize') {
    const size = chosenGoal(a)?.size ?? { min: 1, max: 10, step: 1, unit: '', def: 5, question: 'How big?' };
    return { min: size.min, max: size.max, step: size.step, unit: size.unit, def: size.def, title: size.question };
  }
  if (question.id === 'weight_now' && a.weight_unit === 'kg') return { min: 40, max: 180, step: 1, unit: 'kg', def: 80, title: question.title };
  return { min: question.min ?? 0, max: question.max ?? 10, step: question.step ?? 1, unit: question.unit ?? '', def: question.def ?? question.min ?? 0, title: question.title, lo: question.lo, hi: question.hi };
}

export function questionTitle(question: QuestionDef, a: IntakeAnswers): string {
  return question.title === 'goalSize' ? sliderSpec(question, a).title : question.title;
}

/** Continue is enabled only when this is true; `requiredReason` says why when it is not. */
export function requiredOk(question: QuestionDef, a: IntakeAnswers): boolean {
  if (question.optional) return true;
  if (question.type === 'slider' || question.type === 'time') return true;
  if (question.type === 'rank') return arr(a, question.id).length === options(question, a).length;
  if (question.type === 'multi' || question.type === 'weekdays') return arr(a, question.id).length >= (question.minPick ?? 1);
  return answered(question, a);
}

export function requiredReason(question: QuestionDef, a: IntakeAnswers): string | undefined {
  if (requiredOk(question, a)) return undefined;
  return question.type === 'rank' ? 'Tap every item to set the order.' : 'Answer this one to continue.';
}

export function recommendedValue(question: QuestionDef, a: IntakeAnswers): string | undefined {
  return question.recommended?.(a, helpers);
}

/** Multi-select toggle with the exclusive option ("None") and the pick limit. */
export function toggleOption(question: QuestionDef, a: IntakeAnswers, value: string): string[] {
  let selected = [...arr(a, question.id)];
  if (selected.includes(value)) return selected.filter((x) => x !== value);
  if (question.exclusive && value === question.exclusive) return [value];
  selected = selected.filter((x) => x !== question.exclusive);
  if (!question.maxPick || selected.length < question.maxPick) selected.push(value);
  return selected;
}

/** Rank: tap order. */
export function rankTap(question: QuestionDef, a: IntakeAnswers, value: string): string[] {
  const selected = [...arr(a, question.id)];
  return selected.includes(value) ? selected : [...selected, value];
}

const NN_KEYS = ['dinner', 'sleep', 'sabbath', 'pickup', 'no_debt', 'workout', 'worship', 'date'];
export const nonNegotiableLines = (a: IntakeAnswers) => arr(a, 'lines').filter((x) => NN_KEYS.includes(x));
export const boundaryLines = (a: IntakeAnswers) => arr(a, 'lines').filter((x) => !NN_KEYS.includes(x));

/**
 * Pre-fill from earlier answers, never asked twice (docs/34 §4.1). Returns the answers to
 * write (value + a `_pf_<id>` marker so the screen can say "Pre-filled"), or nothing.
 * `highPressureSuggested` comes from the Track proposal (profile.ts).
 */
export function prefillFor(question: QuestionDef, a: IntakeAnswers, highPressureSuggested: boolean): Record<string, AnswerValue> | undefined {
  if (!question.prefill || a[question.id] !== undefined) return undefined;
  const mark = (value: AnswerValue) => ({ [question.id]: value, [`_pf_${question.id}`]: true });
  if (question.prefill === 'core') return mark(['mind', 'body', 'spirit']);
  if (question.prefill === 'tone') return highPressureSuggested ? mark('high_pressure') : undefined;
  if (question.prefill === 'floors') {
    const first = (FLOOR_CHIPS[foregroundGame(a)] ?? FLOOR_CHIPS._all)[0];
    return first ? mark([first.label]) : undefined;
  }
  if (question.prefill === 'spirit') {
    const out: string[] = [];
    const practices = arr(a, 'practices');
    if (practices.includes('prayer') || arr(a, 'fixed').includes('worship')) out.push('faith');
    if (practices.includes('meditation')) out.push('meditation');
    if (practices.includes('gratitude')) out.push('gratitude');
    return out.length ? mark(out) : undefined;
  }
  if (question.prefill === 'lines') {
    const out: string[] = [];
    const protectedMoments = arr(a, 'protected');
    const fixed = arr(a, 'fixed');
    if (protectedMoments.includes('dinner')) out.push('dinner');
    if (protectedMoments.includes('date')) out.push('date');
    if (protectedMoments.includes('school_run') || fixed.includes('school_run')) out.push('pickup');
    if (fixed.includes('worship')) out.push('worship');
    if (protectedMoments.includes('weekend_am')) out.push('weekends_family');
    return out.length ? mark(out) : undefined;
  }
  return undefined;
}

/** Writing an answer clears its pre-fill marker. */
export function withAnswer(a: IntakeAnswers, id: string, value: AnswerValue | undefined): Record<string, AnswerValue | undefined> {
  const next: Record<string, AnswerValue | undefined> = { ...a, [id]: value };
  delete next[`_pf_${id}`];
  return next;
}

/** Back / Continue on the one intake route. Detail screens always return to the summary. */
export function stepScreen(a: IntakeAnswers, current: string, direction: 1 | -1, mode?: IntakeMode): string {
  if (/^r[1-6]$/.test(current)) return 'summary';
  const onPath = path(a, mode);
  const index = onPath.findIndex((screen) => screen.id === current);
  if (index < 0) {
    // The current screen was gated out (an earlier answer changed): nearest on-path screen.
    const all = registry(a, mode);
    const at = all.findIndex((screen) => screen.id === current);
    const candidate = direction > 0 ? all.slice(at + 1).find((screen) => screen.on) : all.slice(0, Math.max(at, 0)).reverse().find((screen) => screen.on);
    return (candidate ?? onPath[0]!).id;
  }
  return (onPath[index + direction] ?? onPath[index]!).id;
}

/** Where a resumed intake opens: the first unanswered question on her path (else the summary). */
export function resumeCursor(a: IntakeAnswers, mode?: IntakeMode): string {
  const firstOpen = questionPath(a, mode).find((screen) => screen.question && !answered(screen.question, a) && !screen.question.optional);
  return firstOpen?.id ?? 'summary';
}

/** A deep link to a question hidden on her path goes to the cursor instead. */
export function resolveDeepLink(a: IntakeAnswers, target: string | undefined, cursor: string, mode?: IntakeMode): string {
  if (!target) return cursor;
  return path(a, mode).some((screen) => screen.id === target) ? target : cursor;
}

export interface Progress { answered: number; total: number; index: number }

export function progress(a: IntakeAnswers, current: string, mode?: IntakeMode): Progress {
  const questions = questionPath(a, mode);
  return {
    answered: questions.filter((screen) => answered(screen.question!, a)).length,
    total: questions.length,
    index: questions.findIndex((screen) => screen.id === current),
  };
}

/** "14 things APM is now holding for you". Never goes down while she moves forward. */
export function holdingCount(a: IntakeAnswers): number {
  const count = (id: string, except?: string) => arr(a, id).filter((x) => x !== except).length;
  return count('carry') + count('fixed', 'none') + count('deadlines', 'none') + count('lines') + count('floors') + (a.first_step ? 1 : 0) + (a.goal ? 1 : 0);
}

/** Counts shown on the quick-start choice: questions left on the quick and the full path. */
export function quickStartCounts(a: IntakeAnswers): { quickLeft: number; fullLeft: number } {
  const left = (mode: IntakeMode) => questionPath(a, mode).filter((screen) => !answered(screen.question!, a)).length;
  return { quickLeft: left('quick'), fullLeft: left('full') };
}

/** Quick start is recommended when the load is 8+ or the season is recovering / rebuilding. */
export const quickStartRecommended = (a: IntakeAnswers) => helpers.tough(a);

/** Questions on the full path she has not answered: they wait on Today, 2 a day from Day 2. */
export function deferredQuestionIds(a: IntakeAnswers): string[] {
  const quickIds = new Set(questionPath(a, 'quick').map((screen) => screen.id));
  return questionPath(a, 'full')
    .filter((screen) => !quickIds.has(screen.id) && !answered(screen.question!, a) && screen.question!.type !== 'text')
    .map((screen) => screen.id);
}

/**
 * Today's "2 quick taps to sharpen your plan": never on Day 1, never on a light day, never
 * more than 2 a day (`askedToday` = how many she already answered today).
 */
export function deferredForToday(a: IntakeAnswers, input: { dayNumber: number; lightDay: boolean; askedToday: number }): string[] {
  if (input.dayNumber < 2 || input.lightDay) return [];
  const room = Math.max(0, 2 - input.askedToday);
  return deferredQuestionIds(a).slice(0, room);
}

/** Old option ids → current ids, per question (bank versions). Unknown question ids are ignored. */
export const OPTION_MIGRATIONS: Readonly<Record<number, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
  // v1 = prototype v1: no renames; v2 added `spirit` and split Mind & learning.
  1: {},
};

export function migrateAnswers(a: IntakeAnswers, fromVersion: number, toVersion: number): Record<string, AnswerValue | undefined> {
  const out: Record<string, AnswerValue | undefined> = { ...a };
  for (let v = fromVersion; v < toVersion; v += 1) {
    for (const [qid, renames] of Object.entries(OPTION_MIGRATIONS[v] ?? {})) {
      const value = out[qid];
      if (typeof value === 'string' && renames[value]) out[qid] = renames[value];
      if (Array.isArray(value)) out[qid] = value.map((x) => renames[x] ?? x);
    }
  }
  return out;
}

/** Answers on her current path only: hidden answers are kept in the draft but never installed. */
export function visibleAnswers(a: IntakeAnswers, mode?: IntakeMode): Record<string, AnswerValue> {
  // Gates decide what is hidden; the quick start only defers questions, it never hides answers.
  void mode;
  const visible = new Set(questionPath(a, 'full').map((screen) => screen.id));
  const out: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(a)) {
    if (value === undefined) continue;
    const question = questionById(key);
    if (!question || visible.has(key)) out[key] = value;
  }
  return out;
}
