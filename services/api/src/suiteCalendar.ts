import type { CalendarEvent, LifeGraphSnapshot } from '@apm/domain';
import { calendarBusyDays } from '@apm/radar';
import { calendarDateInTimezone } from '@apm/planning';
import { z } from 'zod';
import { fetchGoogleEvents, fetchMicrosoftEvents, type NormalizedCalendarEventInput } from './connectors/calendar';
import { getValidConnectorToken, handleConnectorFailure } from './connectors/oauth';
import { serviceRpc } from './db';

type ConnectorInput = Omit<Parameters<typeof getValidConnectorToken>[0], 'connectionId'>;
type EventTime = Pick<CalendarEvent, 'startsAt' | 'endsAt'>;
type BusyEvent = NormalizedCalendarEventInput & { connectionId?: string };

export const calendarMove = z.object({
  connectionId: z.string().uuid(),
  eventId: z.string().uuid(),
  externalEventId: z.string().min(1),
  title: z.string().min(1),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  originalStartsAt: z.iso.datetime(),
  originalEndsAt: z.iso.datetime(),
  sourceVersion: z.string().min(1),
  timezone: z.string(),
  originalConflicts: z.array(z.object({ connectionId: z.string().optional(), externalEventId: z.string(), sourceVersion: z.string().optional() })).optional(),
});

const MINUTE = 60_000;
const overlaps = (a: EventTime, b: EventTime) => Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);
const iso = (ms: number) => new Date(ms).toISOString();
export const activeCalendar = (connection: LifeGraphSnapshot['connections'][number]) =>
  connection.kind === 'calendar' && connection.status === 'connected' && !connection.pausedAt;

export function canMove(event: NormalizedCalendarEventInput): boolean {
  return !event.deleted && !event.allDay && event.availability === 'busy' && Boolean(event.title && event.sourceVersion)
    && event.organizer?.self === true && event.attendees?.length === 0
    && !event.recurrence?.series && !Object.keys(event.recurrence ?? {}).some((key) => key !== 'rules')
    && Array.isArray(event.recurrence?.rules ?? []) && !(event.recurrence?.rules as unknown[] | undefined)?.length;
}

function protectedTimes(graph: LifeGraphSnapshot): EventTime[] {
  return (graph.lifeAdminItems ?? []).flatMap((item) =>
    item.startsAt && !['completed', 'cancelled', 'paused'].includes(item.status)
      ? [{ startsAt: item.startsAt, endsAt: item.endsAt ?? iso(Date.parse(item.startsAt) + 30 * MINUTE) }] : []);
}

export function suiteSlotOccupied(slot: EventTime, events: BusyEvent[], graph: LifeGraphSnapshot, except?: Pick<BusyEvent, 'connectionId' | 'externalEventId'>): boolean {
  return events.some((event) => !event.deleted && event.availability !== 'free'
    && !(except && event.connectionId === except.connectionId && event.externalEventId === except.externalEventId)
    && (event.allDay
      ? event.provider === 'device' ? overlaps(slot, event)
        : calendarDateInTimezone(slot.startsAt, graph.identity.timezone) >= event.startsAt.slice(0, 10)
          && calendarDateInTimezone(slot.startsAt, graph.identity.timezone) < event.endsAt.slice(0, 10)
      : overlaps(slot, event)))
    || protectedTimes(graph).some((block) => overlaps(slot, block));
}

export function firstClearSlot(event: CalendarEvent, after: string, graph: LifeGraphSnapshot, now: Date, spreadLoad = false) {
  // A clash moves later that day. An overload moves to a lighter day in the next week.
  const timezone = graph.identity.timezone || 'UTC';
  const day = calendarDateInTimezone(event.startsAt, timezone);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const duration = Date.parse(event.endsAt) - Date.parse(event.startsAt);
  if (!Number.isFinite(duration) || duration <= 0 || protectedTimes(graph).some((block) => overlaps(event, block))) return;
  const step = 15 * MINUTE;
  const events = graph.calendarEvents;
  const load = spreadLoad ? calendarBusyDays(graph, now) : undefined;
  const fromLoad = load?.get(day)?.busyMs ?? 0;
  const maxSearch = (spreadLoad ? 7 : 1) * 24 * 60 * MINUTE;
  const weekday = new Intl.DateTimeFormat('en', { timeZone: timezone, weekday: 'short' });
  for (let start = Math.ceil(Date.parse(after) / step) * step, until = start + maxSearch; start < until; start += step) {
    const slot = { startsAt: iso(start), endsAt: iso(start + duration) };
    const targetDay = calendarDateInTimezone(slot.startsAt, timezone);
    if (calendarDateInTimezone(slot.endsAt, timezone) !== targetDay || clock.format(start) < '08:00' || clock.format(start + duration) > '18:00') continue;
    if (spreadLoad ? targetDay <= day || ['Sat', 'Sun'].includes(weekday.format(start))
      || (load?.get(targetDay)?.busyMs ?? 0) + duration >= fromLoad - duration : targetDay !== day) continue;
    if (!suiteSlotOccupied(slot, events, graph, event)) return slot;
  }
}

export function movableEventIds(input: Pick<ConnectorInput, 'env' | 'userId'>, eligibleOnly = true) {
  return serviceRpc<string[]>(input.env, 'apm_service_suite_flexible_events', { p_user_id: input.userId, p_eligible_only: eligibleOnly });
}

export async function executeSuiteCalendarMove(action: unknown, graph: LifeGraphSnapshot, input: ConnectorInput, now = new Date(), undo = false): Promise<string> {
  const move = calendarMove.parse(action);
  const event = graph.calendarEvents.find((item) => item.id === move.eventId && item.connectionId === move.connectionId
    && item.externalEventId === move.externalEventId && item.sourceVersion === move.sourceVersion);
  if (!undo && (!event || !canMove(event) || Date.parse(move.originalStartsAt) <= now.getTime()
    || graph.personalOS?.activeMode === 'deep_work' || protectedTimes(graph).some((block) => overlaps(event, block))
    || !(await movableEventIds(input)).includes(move.eventId))) throw new Error('action_proposal_stale');

  const calendars = graph.connections.filter(activeCalendar);
  if (!calendars.some((connection) => connection.id === move.connectionId && connection.scopes.some((scope) =>
    ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar', 'calendars.readwrite'].includes(scope.toLowerCase())))) throw new Error('action_proposal_stale');
  const destination = undo ? { startsAt: move.originalStartsAt, endsAt: move.originalEndsAt } : move;
  const current = undo ? move : { startsAt: move.originalStartsAt, endsAt: move.originalEndsAt };
  if (Date.parse(destination.startsAt) <= now.getTime() || Date.parse(current.startsAt) <= now.getTime()) throw new Error('action_proposal_stale');
  const from = move.originalStartsAt;
  const to = move.endsAt;
  const snapshots = await suiteCalendarSnapshots(calendars, input, from, to);
  const target = snapshots.find((snapshot) => snapshot.connectionId === move.connectionId)!;
  const live = target.events.find((item) => item.externalEventId === move.externalEventId);
  const busy = [...snapshots.flatMap((snapshot) => snapshot.events), ...graph.calendarEvents.filter((item) => item.provider === 'device')]
    .filter((item) => !undo || !move.originalConflicts?.some((conflict) => conflict.connectionId === item.connectionId
      && conflict.externalEventId === item.externalEventId && conflict.sourceVersion === item.sourceVersion));
  if (!live || !canMove(live) || (!undo && live.sourceVersion !== move.sourceVersion)
    || Date.parse(live.startsAt) !== Date.parse(current.startsAt) || Date.parse(live.endsAt) !== Date.parse(current.endsAt)
    || suiteSlotOccupied(destination, busy, graph, live)) throw new Error('action_proposal_stale');

  const id = encodeURIComponent(move.externalEventId);
  // Only the two timestamps are patched. An ETag catches concurrent edits to this event.
  const google = target.auth.provider === 'google';
  const response = await fetch(google
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=none`
    : `https://graph.microsoft.com/v1.0/me/events/${id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${target.auth.accessToken}`, 'content-type': 'application/json', 'if-match': live.sourceVersion!,
      ...(google ? {} : { Prefer: 'outlook.timezone="UTC"' }) },
    body: JSON.stringify(google
      ? { start: { dateTime: destination.startsAt }, end: { dateTime: destination.endsAt } }
      : { start: { dateTime: destination.startsAt.slice(0, -1), timeZone: 'UTC' }, end: { dateTime: destination.endsAt.slice(0, -1), timeZone: 'UTC' } }),
  });
  if (response.status === 412) throw new Error('action_proposal_stale');
  if (!response.ok) await handleConnectorFailure({ ...input, connectionId: move.connectionId }, target.auth.provider, new Error(`calendar_move_failed:${response.status}`));
  const updated = await response.json() as { id?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
  const utc = (time: string | undefined) => time ? Date.parse(!google && !time.endsWith('Z') ? `${time}Z` : time) : NaN;
  if (updated.id !== move.externalEventId || utc(updated.start?.dateTime) !== Date.parse(destination.startsAt)
    || utc(updated.end?.dateTime) !== Date.parse(destination.endsAt)) throw new Error('calendar_move_receipt_mismatch');
  return updated.id;
}

export function suiteCalendarSnapshots(calendars: LifeGraphSnapshot['connections'], input: ConnectorInput, from: string, to: string) {
  return Promise.all(calendars.map(async (connection) => {
    const auth = await getValidConnectorToken({ ...input, connectionId: connection.id });
    if (auth.kind !== 'calendar' || auth.provider !== connection.provider) throw new Error('action_proposal_stale');
    const events = await (auth.provider === 'google' ? fetchGoogleEvents : fetchMicrosoftEvents)(auth.accessToken, from, to)
      .catch((error: unknown) => handleConnectorFailure({ ...input, connectionId: connection.id }, auth.provider, error));
    return { auth, connectionId: connection.id, events: events.map((item) => ({ ...item, connectionId: connection.id })) };
  }));
}

export function clearSuiteSlot(graph: LifeGraphSnapshot, after: number, duration: number, earliest: string, latest: string, reserved: EventTime[] = [], weekdaysOnly = false) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 10 * 60 * MINUTE) return;
  const timezone = graph.identity.timezone || 'UTC';
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const step = 15 * MINUTE;
  for (let start = Math.ceil(after / step) * step; start < Date.parse(latest) + 2 * 86_400_000; start += step) {
    const slot = { startsAt: iso(start), endsAt: iso(start + duration) };
    const day = calendarDateInTimezone(slot.startsAt, timezone);
    if (day > latest) break;
    if (day < earliest || calendarDateInTimezone(slot.endsAt, timezone) !== day) continue;
    const [weekday, hour] = clock.format(start).split(' ');
    if (weekdaysOnly && ['Sat', 'Sun'].includes(weekday!)) continue;
    if (hour! < '08:00' || clock.format(start + duration).split(' ')[1]! > '18:00') continue;
    if (!reserved.some((block) => overlaps(slot, block)) && !suiteSlotOccupied(slot, graph.calendarEvents, graph)) return slot;
  }
}
