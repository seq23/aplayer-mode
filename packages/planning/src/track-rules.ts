import type { TrackKey, TrackSettings } from '@apm/domain';
import type { AgendaItem, DailyAgenda } from './daily-loop.js';

/**
 * Track RULES shaping Today (docs research "deterministic enforcement in app"). Tracks are
 * background decision filters, never task lists: they only insert a floor the user's own
 * Track requires, hold what the Track forbids, and flag what the Track must challenge.
 */

export interface TrackRuleContext {
  active: TrackKey[];
  roles: string[];
  settings: TrackSettings;
  /** Body red-flag pause is active (until clinician clearance). */
  referral: boolean;
  timezone?: string;
  /** Today's timed calendar events (non-family). */
  calendar: Array<{ title: string; startsAt: string; endsAt: string }>;
  /** Today's protected family blocks (family_obligation items with a time). */
  familyBlocks: Array<{ title: string; startsAt: string; endsAt: string }>;
  /** Verdicts of the most recent closed days, newest first. */
  recentVerdicts: Array<'full_day' | 'mvd' | 'miss'>;
}

export interface TrackFlag {
  code: string;
  track: TrackKey;
  message: string;
}

export const BODY_FLOOR_ACTION_KEY = 'track:body_floor';
export const HOME_TOUCHPOINT_ACTION_KEY = 'track:home_touchpoint';
export const DEFAULT_MOVEMENT_FLOOR = 'Walk 10 minutes (movement floor)';
export const DEFAULT_HOME_TOUCHPOINT = 'Protected family touchpoint for 20 minutes: dinner, bedtime or the school run, phone in another room';
export const SPECULATIVE_PATTERN = /\b(crypto|bitcoin|ethereum|options? trad\w*|day[- ]?trad\w*|meme stocks?|forex|leveraged? (trade|bet|position)|bet on|gambl\w*)\b/i;
const PARENT_ROLE = /(parent|caregiv|family)/i;

function localMinutes(iso: string, timezone?: string): number {
  const date = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  } catch { /* fall back to UTC */ }
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) =>
  Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);

export function bufferMet(settings: TrackSettings): boolean {
  return settings.bufferMonths !== undefined && settings.bufferTarget !== undefined
    && settings.bufferMonths >= settings.bufferTarget && settings.highInterestDebt !== true;
}

function trackFloor(planId: string | undefined, goalId: string | undefined, key: string, title: string, pillar: AgendaItem['pillar'], code: string): AgendaItem {
  return {
    id: key,
    kind: 'track_floor',
    title,
    output: 'Floor done and logged',
    durationMinutes: 10,
    pillar,
    ...(planId ? { planId, goalId } : {}),
    actionKey: key,
    scope: 'mvd',
    status: 'open',
    reasonCodes: [code],
  };
}

/**
 * Applies the active Tracks to a composed agenda. On a Minimum Viable Day nothing is added
 * (MVD is one action); the floor that is missing is flagged instead.
 */
export function applyTrackRules(agenda: DailyAgenda, context: TrackRuleContext, lowDay: boolean): { agenda: DailyAgenda; flags: TrackFlag[] } {
  const active = new Set(context.active);
  const flags: TrackFlag[] = [];
  const items = [...(agenda.firstHour.priority ? [agenda.firstHour.priority] : []), ...agenda.dailyStack];
  let dailyStack = [...agenda.dailyStack];
  const planId = agenda.foregroundPriority?.planId;
  const goalId = agenda.foregroundPriority?.goalId;

  if (active.has('body_foundation')) {
    if (context.referral) {
      flags.push({ code: 'body.referral', track: 'body_foundation', message: 'Body coaching is paused until you record clinician clearance.' });
    } else if (!items.some((item) => item.pillar === 'body')) {
      if (lowDay || !planId) flags.push({ code: 'body.floor_missing', track: 'body_foundation', message: 'No body behaviour today. The movement floor is never zero — take it if you can.' });
      else {
        dailyStack.push(trackFloor(planId, goalId, BODY_FLOOR_ACTION_KEY, context.settings.movementFloor ?? DEFAULT_MOVEMENT_FLOOR, 'body', 'body.floor_missing'));
        flags.push({ code: 'body.floor_missing', track: 'body_foundation', message: 'Body Foundation added your movement floor: a day is never zero for the body.' });
      }
    }
  }

  if (active.has('home_front')) {
    const parent = context.roles.some((role) => PARENT_ROLE.test(role));
    if (parent && !items.some((item) => item.pillar === 'family')) {
      if (lowDay || !planId) flags.push({ code: 'home.floor_missing', track: 'home_front', message: 'No family touchpoint on today’s agenda. The home floor is never zero.' });
      else {
        dailyStack.push(trackFloor(planId, goalId, HOME_TOUCHPOINT_ACTION_KEY, context.settings.homeTouchpoint ?? DEFAULT_HOME_TOUCHPOINT, 'family', 'home.floor_missing'));
        flags.push({ code: 'home.floor_missing', track: 'home_front', message: 'Home Front added your protected family touchpoint for today.' });
      }
    }
    for (const event of context.calendar) {
      const block = context.familyBlocks.find((family) => overlaps(event, family));
      if (block) flags.push({ code: 'home.block_collision', track: 'home_front', message: `“${event.title || 'Busy'}” overlaps the protected block “${block.title}”. Move it or declare an exception.` });
    }
    const hardStop = context.settings.hardStop?.match(/^(\d{2}):(\d{2})$/);
    if (hardStop) {
      const stop = Number(hardStop[1]) * 60 + Number(hardStop[2]);
      for (const event of context.calendar) {
        if (localMinutes(event.startsAt, context.timezone) >= stop) {
          flags.push({ code: 'home.after_hours', track: 'home_front', message: `“${event.title || 'Busy'}” starts after your ${context.settings.hardStop} hard stop. Work after it is declared, not drifted into.` });
        }
      }
    }
  }

  if (active.has('wealth_foundation') && !bufferMet(context.settings)) {
    const held = dailyStack.filter((item) => SPECULATIVE_PATTERN.test(item.title));
    if (held.length) {
      dailyStack = dailyStack.filter((item) => !held.includes(item));
      for (const item of held) flags.push({ code: 'wealth.buffer_gate', track: 'wealth_foundation', message: `“${item.title}” is speculative and your buffer is not met yet. Held until you declare an exception.` });
    }
  }

  if (active.has('resilience')) {
    const [last, previous] = context.recentVerdicts;
    if (last && previous && last !== 'full_day' && previous !== 'full_day') {
      flags.push({ code: 'resilience.capacity', track: 'resilience', message: 'Two lighter days in a row. Protect recovery capacity: Recovery Mode is one tap away, and it counts.' });
    }
  }

  if (active.has('operator_discipline')) {
    flags.push({ code: 'operator.plan_stands', track: 'operator_discipline', message: 'The plan is executed as written. A change is declared with a reason, never drifted into.' });
  }

  return { agenda: { ...agenda, dailyStack }, flags };
}
