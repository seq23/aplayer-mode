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

  let cursor = addRecurrence(scheduledAt, recurrence);
  if (!cursor) return undefined;

  for (let i = 0; i < 500 && cursor.getTime() <= completedAt.getTime(); i += 1) {
    const next = addRecurrence(cursor, recurrence);
    if (!next) return undefined;
    cursor = next;
  }

  return cursor.getTime() > completedAt.getTime() ? cursor : undefined;
}
