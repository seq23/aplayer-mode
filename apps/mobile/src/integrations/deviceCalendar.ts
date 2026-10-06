import * as Calendar from 'expo-calendar';
import { syncDeviceCalendar } from '../api/apmApi';

const DAY_MS = 86_400_000;

function availability(value: string | undefined): 'free' | 'busy' | 'tentative' | 'out_of_office' {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('free')) return 'free';
  if (normalized.includes('tentative')) return 'tentative';
  if (normalized.includes('outofoffice') || normalized.includes('out_of_office')) return 'out_of_office';
  return 'busy';
}

/**
 * Reads calendars already configured on the device and sends only the canonical event
 * fields APM needs for schedule reasoning. It does not upload calendar credentials.
 */
export async function syncConfiguredDeviceCalendars(accessToken: string) {
  const permission = await Calendar.requestCalendarPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Calendar permission was not granted');

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const calendarIds = calendars.map((calendar) => calendar.id);
  if (!calendarIds.length) {
    return syncDeviceCalendar({
      from: new Date(Date.now() - 14 * DAY_MS).toISOString(),
      to: new Date(Date.now() + 90 * DAY_MS).toISOString(),
      events: [],
    }, accessToken);
  }

  const start = new Date(Date.now() - 14 * DAY_MS);
  const end = new Date(Date.now() + 90 * DAY_MS);
  const events = await Calendar.getEventsAsync(calendarIds, start, end);
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));

  return syncDeviceCalendar({
    from: start.toISOString(),
    to: end.toISOString(),
    events: events.map((event) => {
      const calendar = calendarById.get(event.calendarId);
      return {
        provider: 'device',
        externalEventId: event.id,
        calendarExternalId: event.calendarId,
        title: event.title ?? '',
        location: event.location || undefined,
        startsAt: new Date(event.startDate).toISOString(),
        endsAt: new Date(event.endDate).toISOString(),
        timezone: event.timeZone || undefined,
        allDay: Boolean(event.allDay),
        availability: availability(event.availability),
        recurrence: event.recurrenceRule ? { rule: event.recurrenceRule } : {},
        organizer: event.organizer ? { name: event.organizer.name } : {},
        attendees: [],
        sourceVersion: event.lastModifiedDate ? new Date(event.lastModifiedDate).toISOString() : undefined,
        deleted: false,
        sourceCalendar: calendar ? {
          title: calendar.title,
          source: calendar.source?.name,
          type: calendar.source?.type,
        } : undefined,
      };
    }),
  }, accessToken);
}
