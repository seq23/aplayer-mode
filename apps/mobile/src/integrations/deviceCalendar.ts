import * as Calendar from 'expo-calendar';
import { clearDeviceCalendarEvents, syncDeviceCalendar } from '../api/apmApi';
import { readSync, removeSync, writeSync } from '../intake/storage';
import { PREVIEW } from '../preview/flag';

const DAY_MS = 86_400_000;
const CHOICE_KEY = 'apm.deviceCalendar.chosenIds.v1';

/** One calendar on this phone, as the picker shows it: its name and the account it belongs to. */
export type PhoneCalendar = { id: string; title: string; account: string };

// Free web preview: a browser has no phone calendars, so the picker shows these.
const PREVIEW_CALENDARS: PhoneCalendar[] = [
  { id: 'sample-home', title: 'Home (sample)', account: 'iCloud' },
  { id: 'sample-work', title: 'Work (sample)', account: 'Outlook / Exchange' },
  { id: 'sample-kids', title: 'Kids’ school (sample)', account: 'Google' },
  { id: 'sample-holidays', title: 'US Holidays (sample)', account: 'Subscribed calendar' },
];

function availability(value: string | undefined): 'free' | 'busy' | 'tentative' | 'out_of_office' {
  const normalized = (value ?? '').toLowerCase();
  if (normalized.includes('free')) return 'free';
  if (normalized.includes('tentative')) return 'tentative';
  if (normalized.includes('outofoffice') || normalized.includes('out_of_office')) return 'out_of_office';
  return 'busy';
}

/**
 * The calendars the person ticked, saved on this phone only (their names never leave it).
 * `null` = never chosen: nothing syncs until they pick, and nothing is ever pre-ticked.
 */
export function chosenCalendars(): PhoneCalendar[] | null {
  const raw = readSync(CHOICE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as unknown;
    return Array.isArray(saved)
      ? saved.filter((item): item is PhoneCalendar => typeof item?.id === 'string' && typeof item?.title === 'string' && typeof item?.account === 'string')
      : null;
  } catch { return null; }
}

/** Asks for calendar access (iOS grants all calendars at once) and lists them for the picker. */
export async function listPhoneCalendars(): Promise<PhoneCalendar[]> {
  if (PREVIEW) return PREVIEW_CALENDARS;
  const permission = await Calendar.requestCalendarPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Calendar access is off for A Player Mode. Turn it on in your phone’s Settings, then try again.');
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return calendars
    .map((calendar) => ({ id: calendar.id, title: calendar.title || 'Untitled calendar', account: calendar.source?.name || '' }))
    .sort((a, b) => a.account.localeCompare(b.account) || a.title.localeCompare(b.title));
}

/**
 * Saves the choice, removes from our server every stored phone event that is not from a chosen
 * calendar, then syncs only the chosen calendars.
 */
export async function chooseCalendars(calendars: PhoneCalendar[], accessToken: string) {
  writeSync(CHOICE_KEY, JSON.stringify(calendars));
  await clearDeviceCalendarEvents(accessToken, calendars.map((calendar) => calendar.id));
  return syncChosenDeviceCalendars(accessToken);
}

/** "Remove phone calendar events": every stored phone event leaves our server; the choice is forgotten. */
export async function removePhoneCalendarEvents(accessToken: string) {
  await clearDeviceCalendarEvents(accessToken);
  removeSync(CHOICE_KEY);
}

/**
 * Reads ONLY the calendars the person picked and sends the event fields APM needs for schedule
 * reasoning. Calendar names and accounts never leave the phone; no credentials are uploaded.
 */
export async function syncChosenDeviceCalendars(accessToken: string) {
  const chosen = (chosenCalendars() ?? []).map((calendar) => calendar.id);
  const start = new Date(Date.now() - 14 * DAY_MS);
  const end = new Date(Date.now() + 90 * DAY_MS);
  if (PREVIEW) {
    const at = (hour: number) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
    return syncDeviceCalendar({
      from: start.toISOString(), to: end.toISOString(),
      events: chosen.map((id, index) => ({
        provider: 'device', externalEventId: `${id}:1`, calendarExternalId: id,
        title: `${PREVIEW_CALENDARS.find((calendar) => calendar.id === id)?.title ?? 'Phone event (sample)'}`,
        startsAt: at(18 + index), endsAt: at(19 + index), allDay: false, availability: 'busy', recurrence: {}, organizer: {}, attendees: [], deleted: false,
      })),
    }, accessToken);
  }
  const permission = await Calendar.getCalendarPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Calendar access is off for A Player Mode. Turn it on in your phone’s Settings, then try again.');

  // Only calendars that are both chosen and still on the phone.
  const onPhone = new Set((await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)).map((calendar) => calendar.id));
  const chosenIds = chosen.filter((id) => onPhone.has(id));
  const events = chosenIds.length ? await Calendar.getEventsAsync(chosenIds, start, end) : [];

  return syncDeviceCalendar({
    from: start.toISOString(),
    to: end.toISOString(),
    events: events.map((event) => ({
      provider: 'device',
      // EventKit gives every occurrence of a recurring event the same id: key the occurrence.
      externalEventId: `${event.id}:${new Date(event.startDate).toISOString()}`,
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
    })),
  }, accessToken);
}
