import type { LifeAdminRecurrence } from '@apm/domain';

function lastDayOfUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(base: Date, months: number): Date {
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const absoluteMonth = month + months;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const targetDay = Math.min(day, lastDayOfUtcMonth(targetYear, targetMonth));

  const next = new Date(base.getTime());
  next.setUTCFullYear(targetYear, targetMonth, targetDay);
  return next;
}

function addYearsClamped(base: Date, years: number): Date {
  const targetYear = base.getUTCFullYear() + years;
  const month = base.getUTCMonth();
  const day = Math.min(base.getUTCDate(), lastDayOfUtcMonth(targetYear, month));
  const next = new Date(base.getTime());
  next.setUTCFullYear(targetYear, month, day);
  return next;
}

export function addRecurrence(base: Date, recurrence: LifeAdminRecurrence): Date | undefined {
  const frequency = recurrence.frequency;
  if (!frequency || Number.isNaN(base.getTime())) return undefined;
  const interval = Math.max(1, Math.min(365, Math.trunc(recurrence.interval ?? 1)));

  if (frequency === 'daily') {
    const next = new Date(base.getTime());
    next.setUTCDate(next.getUTCDate() + interval);
    return next;
  }
  if (frequency === 'weekly') {
    const next = new Date(base.getTime());
    next.setUTCDate(next.getUTCDate() + 7 * interval);
    return next;
  }
  if (frequency === 'monthly') return addMonthsClamped(base, interval);
  if (frequency === 'yearly') return addYearsClamped(base, interval);
  return undefined;
}

export function nextRecurringOccurrence(
  scheduledAt: Date,
  completedAt: Date,
  recurrence: LifeAdminRecurrence,
): Date | undefined {
  if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(completedAt.getTime())) return undefined;

  const frequency = recurrence.frequency;
  if (!frequency) return undefined;
  const interval = Math.max(1, Math.min(365, Math.trunc(recurrence.interval ?? 1)));
  const first = addRecurrence(scheduledAt, { frequency, interval });
  if (!first || first.getTime() > completedAt.getTime()) return first;

  if (frequency === 'daily' || frequency === 'weekly') {
    const stepDays = frequency === 'daily' ? interval : interval * 7;
    const stepMs = stepDays * 86_400_000;
    const jumps = Math.floor((completedAt.getTime() - first.getTime()) / stepMs) + 1;
    return new Date(first.getTime() + jumps * stepMs);
  }

  if (frequency === 'monthly') {
    const monthDelta =
      (completedAt.getUTCFullYear() - scheduledAt.getUTCFullYear()) * 12
      + completedAt.getUTCMonth()
      - scheduledAt.getUTCMonth();
    let occurrence = Math.max(1, Math.floor(monthDelta / interval));
    let candidate = addMonthsClamped(scheduledAt, occurrence * interval);
    while (candidate.getTime() <= completedAt.getTime()) {
      occurrence += 1;
      candidate = addMonthsClamped(scheduledAt, occurrence * interval);
    }
    return candidate;
  }

  const yearDelta = completedAt.getUTCFullYear() - scheduledAt.getUTCFullYear();
  let occurrence = Math.max(1, Math.floor(yearDelta / interval));
  let candidate = addYearsClamped(scheduledAt, occurrence * interval);
  while (candidate.getTime() <= completedAt.getTime()) {
    occurrence += 1;
    candidate = addYearsClamped(scheduledAt, occurrence * interval);
  }
  return candidate;
}

export interface RecurringScheduleInput {
  dueAt?: Date;
  startsAt?: Date;
  endsAt?: Date;
}

export interface RecurringScheduleResult {
  dueAt?: Date;
  startsAt?: Date;
  endsAt?: Date;
}

function parseAnchor(value?: string): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function nextRecurringSchedule(
  schedule: RecurringScheduleInput,
  completedAt: Date,
  recurrence: LifeAdminRecurrence,
): RecurringScheduleResult {
  const dueAnchor = parseAnchor(recurrence.anchorDueAt) ?? schedule.dueAt;
  const startAnchor = parseAnchor(recurrence.anchorStartsAt) ?? schedule.startsAt;
  const hasExplicitSchedule = Boolean(dueAnchor || startAnchor);

  const nextDue = dueAnchor
    ? nextRecurringOccurrence(dueAnchor, completedAt, recurrence)
    : !hasExplicitSchedule
      ? nextRecurringOccurrence(completedAt, completedAt, recurrence)
      : undefined;
  const nextStart = startAnchor
    ? nextRecurringOccurrence(startAnchor, completedAt, recurrence)
    : undefined;

  let nextEnd: Date | undefined;
  if (nextStart && schedule.startsAt && schedule.endsAt) {
    const duration = schedule.endsAt.getTime() - schedule.startsAt.getTime();
    if (Number.isFinite(duration) && duration >= 0) {
      nextEnd = new Date(nextStart.getTime() + duration);
    }
  }

  return { dueAt: nextDue, startsAt: nextStart, endsAt: nextEnd };
}

