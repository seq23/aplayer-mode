import type { LifeAdminRecurrence } from '@apm/domain';

const DAY_MS = 86_400_000;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function safeTimezone(timezone?: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC' }).format(new Date(0));
    return timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function zonedParts(value: Date, timezone?: string): LocalParts {
  const tz = safeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: value.getUTCMilliseconds(),
  };
}

function localPartsToDate(parts: LocalParts, timezone?: string): Date {
  const tz = safeTimezone(timezone);
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let candidate = desiredAsUtc;

  for (let pass = 0; pass < 4; pass += 1) {
    const observed = zonedParts(new Date(candidate), tz);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      parts.millisecond,
    );
    const delta = observedAsUtc - desiredAsUtc;
    if (delta === 0) break;
    candidate -= delta;
  }

  return new Date(candidate);
}

function localDayIndex(parts: Pick<LocalParts, 'year' | 'month' | 'day'>): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

function addLocalDays(anchor: LocalParts, days: number, timezone?: string): Date {
  const dayDate = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + days));
  return localPartsToDate({
    ...anchor,
    year: dayDate.getUTCFullYear(),
    month: dayDate.getUTCMonth() + 1,
    day: dayDate.getUTCDate(),
  }, timezone);
}

function addLocalMonthsClamped(anchor: LocalParts, months: number, timezone?: string): Date {
  const absoluteMonth = (anchor.year * 12 + (anchor.month - 1)) + months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonthIndex = ((absoluteMonth % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  return localPartsToDate({
    ...anchor,
    year: targetYear,
    month: targetMonth,
    day: Math.min(anchor.day, lastDayOfMonth(targetYear, targetMonth)),
  }, timezone);
}

function addLocalYearsClamped(anchor: LocalParts, years: number, timezone?: string): Date {
  const targetYear = anchor.year + years;
  return localPartsToDate({
    ...anchor,
    year: targetYear,
    day: Math.min(anchor.day, lastDayOfMonth(targetYear, anchor.month)),
  }, timezone);
}

function occurrenceFromAnchor(
  anchor: Date,
  occurrence: number,
  recurrence: LifeAdminRecurrence,
  timezone?: string,
): Date | undefined {
  const frequency = recurrence.frequency;
  if (!frequency || Number.isNaN(anchor.getTime())) return undefined;
  const interval = Math.max(1, Math.min(365, Math.trunc(recurrence.interval ?? 1)));
  const parts = zonedParts(anchor, timezone);

  if (frequency === 'daily') return addLocalDays(parts, occurrence * interval, timezone);
  if (frequency === 'weekly') return addLocalDays(parts, occurrence * interval * 7, timezone);
  if (frequency === 'monthly') return addLocalMonthsClamped(parts, occurrence * interval, timezone);
  if (frequency === 'yearly') return addLocalYearsClamped(parts, occurrence * interval, timezone);
  return undefined;
}

export function addRecurrence(
  base: Date,
  recurrence: LifeAdminRecurrence,
  timezone = recurrence.timezone,
): Date | undefined {
  return occurrenceFromAnchor(base, 1, recurrence, timezone);
}

export function nextRecurringOccurrence(
  scheduledAt: Date,
  completedAt: Date,
  recurrence: LifeAdminRecurrence,
  timezone = recurrence.timezone,
): Date | undefined {
  if (Number.isNaN(scheduledAt.getTime()) || Number.isNaN(completedAt.getTime())) return undefined;
  const frequency = recurrence.frequency;
  if (!frequency) return undefined;

  const tz = safeTimezone(timezone);
  const interval = Math.max(1, Math.min(365, Math.trunc(recurrence.interval ?? 1)));
  const scheduledLocal = zonedParts(scheduledAt, tz);
  const completedLocal = zonedParts(completedAt, tz);

  let occurrence = 1;

  if (frequency === 'daily' || frequency === 'weekly') {
    const stepDays = frequency === 'daily' ? interval : interval * 7;
    const deltaDays = localDayIndex(completedLocal) - localDayIndex(scheduledLocal);
    occurrence = Math.max(1, Math.floor(deltaDays / stepDays));
  } else if (frequency === 'monthly') {
    const monthDelta =
      (completedLocal.year - scheduledLocal.year) * 12
      + completedLocal.month
      - scheduledLocal.month;
    occurrence = Math.max(1, Math.floor(monthDelta / interval));
  } else {
    const yearDelta = completedLocal.year - scheduledLocal.year;
    occurrence = Math.max(1, Math.floor(yearDelta / interval));
  }

  let candidate = occurrenceFromAnchor(scheduledAt, occurrence, recurrence, tz);
  if (!candidate) return undefined;

  while (candidate.getTime() <= completedAt.getTime()) {
    occurrence += 1;
    candidate = occurrenceFromAnchor(scheduledAt, occurrence, recurrence, tz);
    if (!candidate) return undefined;
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

function laterOf(a: Date, b?: Date): Date {
  return b && b.getTime() > a.getTime() ? b : a;
}

export function nextRecurringSchedule(
  schedule: RecurringScheduleInput,
  completedAt: Date,
  recurrence: LifeAdminRecurrence,
  timezoneOverride?: string,
): RecurringScheduleResult {
  const timezone = recurrence.timezone ?? timezoneOverride ?? 'UTC';
  const dueAnchor = parseAnchor(recurrence.anchorDueAt) ?? schedule.dueAt;
  const startAnchor = parseAnchor(recurrence.anchorStartsAt) ?? schedule.startsAt;
  const hasExplicitSchedule = Boolean(dueAnchor || startAnchor);

  const nextDue = dueAnchor
    ? nextRecurringOccurrence(dueAnchor, laterOf(completedAt, schedule.dueAt), recurrence, timezone)
    : !hasExplicitSchedule
      ? nextRecurringOccurrence(completedAt, completedAt, recurrence, timezone)
      : undefined;
  const nextStart = startAnchor
    ? nextRecurringOccurrence(startAnchor, laterOf(completedAt, schedule.startsAt), recurrence, timezone)
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
