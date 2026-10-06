import type { CalendarEvent, IntegrationProvider } from '@apm/domain';
import type { ApiEnv } from '../env';
import { supabaseRest } from '../db';
import { getValidConnectorToken } from './oauth';

export interface NormalizedCalendarEventInput {
  provider: string;
  externalEventId: string;
  calendarExternalId?: string;
  title: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  timezone?: string;
  allDay: boolean;
  availability: CalendarEvent['availability'];
  recurrence?: Record<string, unknown>;
  organizer?: Record<string, unknown>;
  attendees?: unknown[];
  sourceVersion?: string;
  deleted?: boolean;
}

function googleDate(value: { dateTime?: string; date?: string; timeZone?: string }): { at: string; allDay: boolean; timezone?: string } {
  if (value.dateTime) return { at: new Date(value.dateTime).toISOString(), allDay: false, timezone: value.timeZone };
  if (value.date) return { at: `${value.date}T00:00:00.000Z`, allDay: true, timezone: value.timeZone };
  throw new Error('google_event_missing_time');
}

async function fetchGoogleEvents(token: string, from: string, to: string): Promise<NormalizedCalendarEventInput[]> {
  let pageToken: string | undefined;
  const events: NormalizedCalendarEventInput[] = [];
  do {
    const params = new URLSearchParams({
      timeMin: from,
      timeMax: to,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      ...(pageToken ? { pageToken } : {}),
    });
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`google_calendar_sync_failed:${response.status}`);
    const data = await response.json() as {
      items?: Array<{
        id: string; status?: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string; timeZone?: string };
        end?: { dateTime?: string; date?: string; timeZone?: string }; transparency?: string; recurrence?: string[]; etag?: string;
        organizer?: Record<string, unknown>; attendees?: unknown[];
      }>;
      nextPageToken?: string;
    };
    for (const item of data.items ?? []) {
      if (!item.start || !item.end) continue;
      const start = googleDate(item.start);
      const end = googleDate(item.end);
      events.push({
        provider: 'google', externalEventId: item.id, title: item.summary ?? '', location: item.location,
        startsAt: start.at, endsAt: end.at, timezone: start.timezone ?? end.timezone, allDay: start.allDay,
        availability: item.transparency === 'transparent' ? 'free' : 'busy',
        recurrence: { rules: item.recurrence ?? [] }, organizer: item.organizer ?? {}, attendees: item.attendees ?? [],
        sourceVersion: item.etag, deleted: item.status === 'cancelled',
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return events;
}

function microsoftAvailability(showAs?: string): CalendarEvent['availability'] {
  if (showAs === 'free') return 'free';
  if (showAs === 'tentative') return 'tentative';
  if (showAs === 'oof' || showAs === 'workingElsewhere') return 'out_of_office';
  return 'busy';
}

async function fetchMicrosoftEvents(token: string, from: string, to: string): Promise<NormalizedCalendarEventInput[]> {
  let url: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=1000&$select=id,subject,location,start,end,isAllDay,showAs,recurrence,organizer,attendees,changeKey,isCancelled`;
  const events: NormalizedCalendarEventInput[] = [];
  let pages = 0;
  while (url && pages < 20) {
    pages += 1;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (!response.ok) throw new Error(`microsoft_calendar_sync_failed:${response.status}`);
    const data = await response.json() as {
      value?: Array<{
        id: string; subject?: string; location?: { displayName?: string }; start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string }; isAllDay?: boolean; showAs?: string; recurrence?: Record<string, unknown> | null;
        organizer?: Record<string, unknown>; attendees?: unknown[]; changeKey?: string; isCancelled?: boolean;
      }>;
      '@odata.nextLink'?: string;
    };
    for (const item of data.value ?? []) {
      if (!item.start?.dateTime || !item.end?.dateTime) continue;
      events.push({
        provider: 'microsoft', externalEventId: item.id, title: item.subject ?? '', location: item.location?.displayName,
        startsAt: new Date(`${item.start.dateTime}${item.start.dateTime.endsWith('Z') ? '' : 'Z'}`).toISOString(),
        endsAt: new Date(`${item.end.dateTime}${item.end.dateTime.endsWith('Z') ? '' : 'Z'}`).toISOString(),
        timezone: item.start.timeZone, allDay: item.isAllDay ?? false, availability: microsoftAvailability(item.showAs),
        recurrence: item.recurrence ?? {}, organizer: item.organizer ?? {}, attendees: item.attendees ?? [], sourceVersion: item.changeKey,
        deleted: item.isCancelled ?? false,
      });
    }
    url = data['@odata.nextLink'];
  }
  return events;
}

export async function persistCalendarSnapshot(input: {
  env: ApiEnv; accessToken: string; userId: string; connectionId?: string; provider: string;
  events: NormalizedCalendarEventInput[]; from: string; to: string;
}): Promise<number> {
  const connectionFilter = input.connectionId ? `&connection_id=eq.${encodeURIComponent(input.connectionId)}` : '';
  await supabaseRest(input.env, input.accessToken, `/rest/v1/calendar_events?user_id=eq.${encodeURIComponent(input.userId)}&provider=eq.${encodeURIComponent(input.provider)}${connectionFilter}&starts_at=gte.${encodeURIComponent(input.from)}&starts_at=lte.${encodeURIComponent(input.to)}`, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' },
  });
  if (input.events.length === 0) return 0;
  const rows = input.events.map((event) => ({
    user_id: input.userId, connection_id: input.connectionId ?? null, provider: event.provider,
    external_event_id: event.externalEventId, calendar_external_id: event.calendarExternalId ?? null,
    title: event.title, location: event.location ?? null, starts_at: event.startsAt, ends_at: event.endsAt,
    timezone: event.timezone ?? null, all_day: event.allDay, availability: event.availability,
    recurrence: event.recurrence ?? {}, organizer: event.organizer ?? {}, attendees: event.attendees ?? [],
    source_version: event.sourceVersion ?? null, deleted: event.deleted ?? false, observed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  await supabaseRest(input.env, input.accessToken, '/rest/v1/calendar_events', {
    method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  return rows.length;
}

export async function syncCloudCalendar(input: {
  env: ApiEnv; accessToken: string; userId: string; connectionId: string; from?: string; to?: string;
}): Promise<{ provider: IntegrationProvider; count: number; from: string; to: string }> {
  const from = input.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const to = input.to ?? new Date(Date.now() + 90 * 86_400_000).toISOString();
  const auth = await getValidConnectorToken(input);
  if (auth.kind !== 'calendar') throw new Error('connection_is_not_calendar');
  const events = auth.provider === 'google'
    ? await fetchGoogleEvents(auth.accessToken, from, to)
    : await fetchMicrosoftEvents(auth.accessToken, from, to);
  const count = await persistCalendarSnapshot({ ...input, provider: auth.provider, events, from, to });
  await supabaseRest(input.env, input.accessToken, `/rest/v1/integration_connections?id=eq.${encodeURIComponent(input.connectionId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_sync_at: new Date().toISOString(), last_error_code: null, status: 'connected', updated_at: new Date().toISOString() }),
  });
  return { provider: auth.provider, count, from, to };
}

export async function syncDeviceCalendar(input: {
  env: ApiEnv; accessToken: string; userId: string; events: NormalizedCalendarEventInput[]; from: string; to: string;
}): Promise<{ count: number }> {
  const count = await persistCalendarSnapshot({ ...input, provider: 'device' });
  return { count };
}
