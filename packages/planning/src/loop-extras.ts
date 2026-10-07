import type { DayRecord, DiaryEntry, PlanActionCompletion, WeeklyReview } from '@apm/domain';
import { agendaItemProblem, agendaItems, type AgendaItem, type DailyAgenda, type PlanEntry } from './daily-loop.js';
import { planDayIndex } from './goal-plan.js';
import { addDays, daysBetween } from './goal-templates.js';
import { stabilizationDay } from './methodology.js';
import type { TrackFlag } from './track-rules.js';

// ---------------------------------------------------------------------------
// REPRINT (BHPC Part VI §4, Invalid Agenda clause)
// ---------------------------------------------------------------------------

export interface ReprintResult {
  agenda: DailyAgenda;
  replaced: Array<{ from: string; to?: string }>;
  stillInvalid: string[];
}

/**
 * Reprints an invalid or user-flagged agenda WITHOUT changing its scope: each bad plan item
 * is swapped for the MVD of the same action, then for another action of the same gate whose
 * title is executable; a generic non-plan item is dropped. A reprint is not a renegotiation:
 *  - the foreground keeps its action (No Mid-Day Negotiation): it may only be rescoped to
 *    its own MVD, never swapped for another action;
 *  - a protected floor (plan or Track floor) is never dropped: it may only become its own MVD.
 * The database enforces both again (apm_service_day_reprint, 0046).
 */
export function reprintAgenda(agenda: DailyAgenda, plans: PlanEntry[], flaggedIds: string[] = []): ReprintResult {
  const flagged = new Set(flaggedIds);
  const replaced: ReprintResult['replaced'] = [];
  const used = new Set(agendaItems(agenda).map((item) => item.actionKey).filter(Boolean));
  const ownMvd = (item: AgendaItem): AgendaItem | undefined => {
    const entry = plans.find((candidate) => candidate.record.id === item.planId);
    const action = entry && item.actionKey ? entry.plan.actions[item.actionKey] : undefined;
    if (!action || item.scope === 'mvd') return undefined;
    const mvd = { ...item, title: action.mvd.title, output: action.mvd.output, durationMinutes: action.mvd.durationMinutes, scope: 'mvd' as const };
    return agendaItemProblem(mvd) ? undefined : mvd;
  };
  const repair = (item: AgendaItem, protectedItem: boolean): AgendaItem | undefined => {
    if (!flagged.has(item.id) && !agendaItemProblem(item)) return item;
    if (protectedItem) {
      // Foreground or floor: its own MVD, or unchanged. Never dropped, never swapped.
      const mvd = ownMvd(item);
      if (mvd) { replaced.push({ from: item.title, to: mvd.title }); return mvd; }
      replaced.push({ from: item.title });
      return item;
    }
    const entry = plans.find((candidate) => candidate.record.id === item.planId);
    if (!flagged.has(item.id)) {
      const mvd = ownMvd(item);
      if (mvd) { replaced.push({ from: item.title, to: mvd.title }); return mvd; }
    }
    if (entry && item.kind === 'plan_action') {
      const gate = entry.plan.gates.find((candidate) => {
        const day = planDayIndex(entry.plan, agenda.date);
        return day >= candidate.startDay && day <= candidate.endDay;
      }) ?? entry.plan.gates[0];
      for (const slot of gate.weeklyCadence) {
        const alternative = entry.plan.actions[slot.actionKey];
        if (!alternative || used.has(alternative.key) || alternative.key === item.actionKey) continue;
        const source = item.scope === 'mvd' ? alternative.mvd : alternative;
        const next: AgendaItem = { ...item, id: `plan:${entry.record.id}:${alternative.key}`, actionKey: alternative.key, title: source.title, output: source.output, durationMinutes: source.durationMinutes, pillar: alternative.pillar, reasonCodes: [...item.reasonCodes, 'reprinted'] };
        if (!agendaItemProblem(next)) { used.add(alternative.key); replaced.push({ from: item.title, to: next.title }); return next; }
      }
    }
    replaced.push({ from: item.title });
    return item.kind === 'plan_action' ? item : undefined;
  };
  const priority = agenda.firstHour.priority ? repair(agenda.firstHour.priority, true) : undefined;
  const dailyStack = agenda.dailyStack.map((item) => repair(item, item.kind === 'plan_floor' || item.kind === 'track_floor')).filter((item): item is AgendaItem => Boolean(item));
  const next: DailyAgenda = { ...agenda, firstHour: { ...agenda.firstHour, ...(priority ? { priority } : {}) }, dailyStack, reasons: [...new Set([...agenda.reasons, 'reprinted'])] };
  const stillInvalid = agendaItems(next).map(agendaItemProblem).filter((problem): problem is string => Boolean(problem));
  next.problems = stillInvalid;
  return { agenda: next, replaced, stillInvalid };
}

// ---------------------------------------------------------------------------
// Drift Check / Return-Reset
// ---------------------------------------------------------------------------

export const WELCOME_BACK = "Welcome back. Want me to print today's agenda and restart the day?";

/**
 * Two or more days with no check-in, close or completion since the plan started = drift.
 * The app does not analyse the absence; it only offers the restart.
 */
export function detectDrift(input: {
  date: string;
  dayRecords: Pick<DayRecord, 'day' | 'checkedInAt' | 'closedAt' | 'returnedAt'>[];
  completions: Pick<PlanActionCompletion, 'day'>[];
  firstActiveDay?: string;
}): { drifting: boolean; daysAway: number; acknowledged: boolean; message?: string } {
  const today = input.dayRecords.find((record) => record.day === input.date);
  const acknowledged = Boolean(today?.returnedAt || today?.checkedInAt);
  if (!input.firstActiveDay) return { drifting: false, daysAway: 0, acknowledged };
  const activity = [
    ...input.dayRecords.filter((record) => record.day < input.date && (record.checkedInAt || record.closedAt)).map((record) => record.day),
    ...input.completions.filter((completion) => completion.day < input.date).map((completion) => completion.day),
  ].sort();
  const last = activity.at(-1) ?? addDays(input.firstActiveDay, -1);
  const daysAway = Math.max(0, daysBetween(last, input.date) - 1);
  const drifting = daysAway >= 2;
  return { drifting, daysAway, acknowledged, ...(drifting && !acknowledged ? { message: WELCOME_BACK } : {}) };
}

// ---------------------------------------------------------------------------
// First 7 Days (BHPC Part XIII)
// ---------------------------------------------------------------------------

export const FIRST_SEVEN_DAYS = [
  { day: 1, objective: 'Installation Day', success: 'The OS exists', loop: 'Do only the first item on your agenda. Then stop. This is relief, not productivity.' },
  { day: 2, objective: 'First Full Day', success: 'You completed a day', loop: 'Run the whole agenda once and close the day.' },
  { day: 3, objective: 'Continuity Test', success: 'You showed up again', loop: 'Showing up is the only metric.' },
  { day: 4, objective: 'Failure Practice', success: 'You trust the system does not punish you', loop: 'If today goes badly, close it honestly. Tomorrow is a Recovery Day, not a punishment.' },
  { day: 5, objective: 'Stability Day', success: 'Lower mental load', loop: 'Let the agenda decide. Notice how little you had to think.' },
  { day: 6, objective: 'Light Reflection', success: 'Awareness without intervention', loop: 'Notice what worked. Change nothing yet.' },
  { day: 7, objective: 'First Review', success: 'You feel safer inside the structure', loop: 'Run your first weekly debrief.' },
] as const;

export const WEEK_ONE_RULES = [
  'Do NOT optimize: the system needs to stabilize before you improve it.',
  'Do NOT customize: changes before Week 1 ends break the baseline.',
  'Do NOT add projects: one foreground only — always.',
];

export function firstWeekProgramme(installedOn: string | undefined, today: string) {
  if (!installedOn) return undefined;
  const elapsed = daysBetween(installedOn.slice(0, 10), today);
  if (elapsed < 0 || elapsed > 6) return undefined;
  const day = stabilizationDay(installedOn, new Date(`${today}T12:00:00.000Z`));
  const step = FIRST_SEVEN_DAYS[day - 1]!;
  return { ...step, rules: WEEK_ONE_RULES, locked: true };
}

// ---------------------------------------------------------------------------
// Coaching safety check-in (Prompt #1A: 7 days without coaching → gentle reminder)
// ---------------------------------------------------------------------------

export function coachingCheckIn(input: { lastCoachingAt?: string; installedAt?: string; today: string; afterDays?: number }) {
  const afterDays = input.afterDays ?? 7;
  const since = (input.lastCoachingAt ?? input.installedAt)?.slice(0, 10);
  if (!since) return { due: false, afterDays, daysSince: 0 };
  const daysSince = daysBetween(since, input.today);
  return {
    due: daysSince >= afterDays,
    afterDays,
    daysSince,
    // Never blocks execution.
    ...(daysSince >= afterDays ? { message: `It has been ${daysSince} days since your last coaching session. A short check-in is here whenever you want it — it never blocks your day.` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Weekly debrief / Executive Review (Prompt #7)
// ---------------------------------------------------------------------------

const WEEKDAY: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WEEKDAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekStartFor(today: string): string {
  // The debrief covers the seven days ending today.
  return addDays(today, -6);
}

export function weeklyReviewDue(input: { today: string; reviewDay?: string; reviews: Pick<WeeklyReview, 'weekStart'>[] }) {
  const reviewDay = WEEKDAY[(input.reviewDay ?? 'Sunday').toLowerCase()] ?? 0;
  const weekday = new Date(`${input.today}T00:00:00.000Z`).getUTCDay();
  const weekStart = weekStartFor(input.today);
  const done = input.reviews.some((review) => review.weekStart >= weekStart);
  return { due: weekday === reviewDay && !done, weekStart, reviewDay: WEEKDAY_NAME[reviewDay]! };
}

export interface WeeklyDebrief {
  weekStart: string;
  weekEnd: string;
  executionScore: { counted: number; fullDays: number; mvdDays: number; misses: number; unclosed: number; of: 7; percent: number };
  foregroundFocus: { label?: string; daysWithForegroundDone: number; of: 7 };
  friction: string[];
  trackSignals: Array<Pick<TrackFlag, 'code' | 'message'>>;
  diary: Array<Pick<DiaryEntry, 'kind' | 'body' | 'localDay'>>;
  diaryQuestion: string;
  executiveReview: { open: string; close: string };
  adjustmentPrompt: string;
}

/** Execution Score, Foreground Focus review, Friction Analysis and One Adjustment for next week. */
export function weeklyDebrief(input: {
  today: string;
  dayRecords: Pick<DayRecord, 'day' | 'verdict' | 'replans' | 'agenda'>[];
  completions: Pick<PlanActionCompletion, 'day' | 'planId' | 'role'>[];
  foreground?: { planId: string; label: string };
  diary: Pick<DiaryEntry, 'kind' | 'body' | 'localDay'>[];
  trackFlags?: TrackFlag[];
}): WeeklyDebrief {
  const weekStart = weekStartFor(input.today);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const record = (day: string) => input.dayRecords.find((candidate) => candidate.day === day);
  const fullDays = days.filter((day) => record(day)?.verdict === 'full_day').length;
  const mvdDays = days.filter((day) => record(day)?.verdict === 'mvd').length;
  const misses = days.filter((day) => record(day)?.verdict === 'miss').length;
  const unclosed = days.filter((day) => !record(day)?.verdict).length;
  const counted = fullDays + mvdDays;
  const foregroundDays = input.foreground
    ? new Set(input.completions.filter((completion) => completion.planId === input.foreground!.planId && completion.role === 'foreground' && days.includes(completion.day)).map((completion) => completion.day)).size
    : 0;

  const friction: string[] = [];
  const missedWeekdays = days.filter((day) => record(day)?.verdict === 'miss' || !record(day)?.verdict).map((day) => WEEKDAY_NAME[new Date(`${day}T00:00:00Z`).getUTCDay()]!);
  if (missedWeekdays.length) friction.push(`Days that did not count: ${[...new Set(missedWeekdays)].join(', ')}.`);
  const replans = days.reduce((sum, day) => sum + (record(day)?.replans?.length ?? 0), 0);
  if (replans) friction.push(`${replans} declared mid-day replan${replans === 1 ? '' : 's'}.`);
  if (input.foreground && foregroundDays < 4) friction.push(`The foreground moved on ${foregroundDays} of 7 days.`);
  if (!friction.length) friction.push('No friction pattern this week. Keep it boring.');

  return {
    weekStart,
    weekEnd: input.today,
    executionScore: { counted, fullDays, mvdDays, misses, unclosed, of: 7, percent: Math.round((counted / 7) * 100) },
    foregroundFocus: { ...(input.foreground ? { label: input.foreground.label } : {}), daysWithForegroundDone: foregroundDays, of: 7 },
    friction,
    trackSignals: (input.trackFlags ?? []).filter((flag) => flag.code !== 'operator.plan_stands').map(({ code, message }) => ({ code, message })),
    diary: input.diary.filter((entry) => entry.localDay >= weekStart && entry.localDay <= input.today),
    diaryQuestion: 'Did you log any major breakthroughs in your Diary to review now?',
    executiveReview: { open: "Here's what you already know that still makes you better:", close: 'None of this is new — you’re just being reminded.' },
    adjustmentPrompt: 'One adjustment for next week (it goes to the Drafting Room; nothing changes until you apply it).',
  };
}
