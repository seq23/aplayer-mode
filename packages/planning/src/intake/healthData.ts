// Consumer health data (Washington My Health My Data Act; owner ruling 8 Oct 2026): the Body
// pillar answers, the in-bed Pilates-style routine answer, the weight / injury goals, and the
// "How full does your head feel, 1 to 10?" mental-load score (0094).
// Nothing on these lists is collected until the person taps a separate, explicit consent,
// and collection stops when they withdraw it.
//
// ONE list. The intake engine reads it to skip and hide these questions; the API reads it to
// strip them from writes; the database trigger (migration 0093, list extended in 0094) holds the same
// ids, and services/api/test/consent-db.test.mjs pins the SQL lists to these.
import { GOAL_TEMPLATES } from './bank.js';
import type { IntakeAnswers } from './types.js';

/** Version of the Consumer Health Data Privacy Policy a consent is given against. */
export const CONSUMER_HEALTH_POLICY_VERSION = '2026-10-08';

/** Intake answers that are consumer health data (the Body section, the in-bed routine, the mental-load score). */
export const HEALTH_DATA_QUESTION_IDS = [
  'move', 'workout_days', 'food', 'weight_now', 'weigh_in', 'clinician_flag', 'clinician_sup', 'health_routine', 'bed', 'bed_move', 'load',
] as const;

/** The game whose choice is itself health information ("Losing weight / getting healthy"). */
export const HEALTH_DATA_GAME_IDS = ['weight'] as const;

/** Goals that are health information: every weight-game goal, and returning from injury. */
export const HEALTH_DATA_GOAL_IDS: readonly string[] = [...GOAL_TEMPLATES.weight.map((goal) => goal.id), 'return_injury'];

/** The intake's mirror of the server consent record: '_health' is 'yes' only after the tap. */
export const HEALTH_CONSENT_ANSWER_KEY = '_health';

export function healthConsentGiven(a: IntakeAnswers): boolean {
  return a[HEALTH_CONSENT_ANSWER_KEY] === 'yes';
}

export function isHealthQuestion(id: string): boolean {
  return (HEALTH_DATA_QUESTION_IDS as readonly string[]).includes(id);
}

/** Answers with every health item removed (what may be kept without consent). */
export function withoutHealthAnswers<T extends Record<string, unknown>>(answers: T): T {
  const out: Record<string, unknown> = { ...answers };
  for (const id of HEALTH_DATA_QUESTION_IDS) delete out[id];
  if (Array.isArray(out.games)) out.games = (out.games as unknown[]).filter((game) => !(HEALTH_DATA_GAME_IDS as readonly unknown[]).includes(game));
  if (typeof out.foreground === 'string' && (HEALTH_DATA_GAME_IDS as readonly string[]).includes(out.foreground)) delete out.foreground;
  if (typeof out.goal === 'string' && HEALTH_DATA_GOAL_IDS.includes(out.goal)) { delete out.goal; delete out.goal_size; }
  return out as T;
}
