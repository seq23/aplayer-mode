import { BANK_VERSION } from './bank.js';
import { migrateAnswers, resumeCursor, withAnswer } from './engine.js';
import type { AnswerValue, IntakeAnswers } from './types.js';

/**
 * The IntakeDraft (docs/34 §6): one store keyed by question id. The screen never owns an
 * answer; every tap goes through `setDraftAnswer`, which the app writes to device storage
 * synchronously and then, debounced, to the server (PUT /v1/intake/draft). Pure functions,
 * so back / forward / kill-resume / two-device merges are tested here in Node.
 */
export interface IntakeDraft {
  bankVersion: number;
  /** Increments on every change; the install idempotency key is derived from it. */
  version: number;
  answers: Record<string, AnswerValue>;
  /** Client time (ms) each answer was last written: last write wins per question. */
  answeredAt: Record<string, number>;
  /** The screen she is on (the one intake route renders from it). */
  cursor: string;
  updatedAt: number;
  /** Set once the OS is installed from this draft (the version that installed). */
  installedVersion?: number;
}

export const DRAFT_STORAGE_KEY = 'apm.intake.draft.v1';
/** Bound on what the server accepts (and what the device keeps): ids and short values only. */
export const DRAFT_MAX_BYTES = 64_000;
export const CATCH_ALL_MAX_CHARS = 4000;

export function emptyDraft(now: number): IntakeDraft {
  return { bankVersion: BANK_VERSION, version: 0, answers: {}, answeredAt: {}, cursor: 'games', updatedAt: now };
}

function clean(answers: Record<string, AnswerValue | undefined>): Record<string, AnswerValue> {
  const out: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(answers)) if (value !== undefined) out[key] = value;
  return out;
}

/** One tap. `undefined` clears the answer (e.g. "Reset order"). */
export function setDraftAnswer(draft: IntakeDraft, id: string, value: AnswerValue | undefined, now: number): IntakeDraft {
  let answer = value;
  if (id === 'catchall' && typeof answer === 'string') answer = answer.slice(0, CATCH_ALL_MAX_CHARS);
  const answers = clean(withAnswer(draft.answers, id, answer));
  return { ...draft, answers, answeredAt: { ...draft.answeredAt, [id]: now }, version: draft.version + 1, updatedAt: now };
}

/** Several writes at once (pre-fill writes the value and its marker together). */
export function patchDraft(draft: IntakeDraft, patch: Record<string, AnswerValue>, now: number): IntakeDraft {
  const answeredAt = { ...draft.answeredAt };
  for (const key of Object.keys(patch)) answeredAt[key] = now;
  return { ...draft, answers: { ...draft.answers, ...patch }, answeredAt, version: draft.version + 1, updatedAt: now };
}

export function setDraftCursor(draft: IntakeDraft, cursor: string, now: number): IntakeDraft {
  if (draft.cursor === cursor) return draft;
  return { ...draft, cursor, version: draft.version + 1, updatedAt: now };
}

/**
 * Merge two copies of the same person's draft (offline device + server, or device A and
 * device B): per question the later write wins; the cursor comes from the copy changed
 * last; nothing is duplicated and nothing older overwrites newer.
 */
export function mergeDrafts(a: IntakeDraft, b: IntakeDraft): IntakeDraft {
  const answers: Record<string, AnswerValue> = {};
  const answeredAt: Record<string, number> = {};
  const keys = new Set([...Object.keys(a.answeredAt), ...Object.keys(b.answeredAt), ...Object.keys(a.answers), ...Object.keys(b.answers)]);
  for (const key of keys) {
    const ta = a.answeredAt[key] ?? -1;
    const tb = b.answeredAt[key] ?? -1;
    const winner = tb > ta ? b : a;
    const time = Math.max(ta, tb);
    if (key in winner.answers) answers[key] = winner.answers[key]!;
    if (time >= 0) answeredAt[key] = time;
  }
  const newer = b.updatedAt > a.updatedAt ? b : a;
  return {
    bankVersion: Math.max(a.bankVersion, b.bankVersion),
    version: Math.max(a.version, b.version) + 1,
    answers,
    answeredAt,
    cursor: newer.cursor,
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    ...(a.installedVersion !== undefined || b.installedVersion !== undefined ? { installedVersion: Math.max(a.installedVersion ?? 0, b.installedVersion ?? 0) } : {}),
  };
}

/** A stored draft from an older bank: options renamed by the migration table, unknown ids kept but ignored. */
export function upgradeDraft(draft: IntakeDraft): IntakeDraft {
  if (draft.bankVersion >= BANK_VERSION) return draft;
  return { ...draft, answers: clean(migrateAnswers(draft.answers, draft.bankVersion, BANK_VERSION)), bankVersion: BANK_VERSION };
}

/** Parse what device storage or the server returned; anything malformed is a fresh draft. */
export function parseDraft(raw: unknown, now: number): IntakeDraft {
  if (!raw || typeof raw !== 'object') return emptyDraft(now);
  const value = raw as Partial<IntakeDraft>;
  if (typeof value.answers !== 'object' || value.answers === null || typeof value.version !== 'number') return emptyDraft(now);
  return upgradeDraft({
    bankVersion: typeof value.bankVersion === 'number' ? value.bankVersion : 1,
    version: value.version,
    answers: value.answers as Record<string, AnswerValue>,
    answeredAt: typeof value.answeredAt === 'object' && value.answeredAt ? (value.answeredAt as Record<string, number>) : {},
    cursor: typeof value.cursor === 'string' && value.cursor ? value.cursor : resumeCursor(value.answers as IntakeAnswers),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
    ...(typeof value.installedVersion === 'number' ? { installedVersion: value.installedVersion } : {}),
  });
}

export function answeredCount(draft: IntakeDraft): number {
  return Object.keys(draft.answers).filter((key) => !key.startsWith('_') && !key.startsWith('crit_') && !key.startsWith('trk_') && key !== 'mode' && key !== 'sysname' && key !== 'push').length;
}
