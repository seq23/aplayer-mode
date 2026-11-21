import { useEffect, useState } from 'react';
import type { CalendarEvent } from '@apm/domain';
import { fetchFlexibleCalendarEvents, setAutopilotEventFlexible } from '../api/apmApi';
import { Body, Button, Card, CardTitle, ErrorState, KeyValue } from './ui';

export function CalendarFlexibility({ events, accessToken }: { events: CalendarEvent[]; accessToken: string }) {
  const [marked, setMarked] = useState<string[]>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    fetchFlexibleCalendarEvents(accessToken).then(
      ({ eventIds }) => { if (active) setMarked(eventIds); },
      () => { if (active) setError('We could not check which blocks you marked flexible.'); },
    );
    return () => { active = false; };
  }, [accessToken, reload]);

  const toggle = async (eventId: string) => {
    if (!marked || pending) return;
    setPending(eventId);
    setError(undefined);
    try {
      const { flexible } = await setAutopilotEventFlexible(eventId, !marked.includes(eventId), accessToken);
      setMarked(flexible ? [...marked, eventId] : marked.filter((id) => id !== eventId));
    } catch {
      setError('We could not save that change. Try again.');
    } finally {
      setPending(undefined);
    }
  };

  return <Card>
    <CardTitle>Which block can move?</CardTitle>
    <Body muted>Mark a block flexible so APM can propose a new time. It takes a separate approval to move it.</Body>
    {error ? <ErrorState message={error} /> : null}
    {marked === undefined && error ? <Button label="Try again" variant="secondary" onPress={() => { setError(undefined); setReload(reload + 1); }} /> : null}
    {marked === undefined && !error ? <Body muted>Checking your calendar preferences…</Body> : null}
    {marked ? events.map((event) => <Card key={event.id} tone="muted">
      <KeyValue label={event.title} value={marked?.includes(event.id) ? 'Flexible' : 'Keep its time'} />
      <Button
        label={pending === event.id ? 'Saving…' : marked?.includes(event.id) ? 'Keep its time' : 'Mark flexible'}
        variant="secondary" disabled={Boolean(pending)} onPress={() => void toggle(event.id)}
      />
    </Card>) : null}
  </Card>;
}
