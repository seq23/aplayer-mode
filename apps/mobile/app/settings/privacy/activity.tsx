import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Body,
  Card,
  CardTitle,
  ErrorState,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
  uiStyles,
} from '../../../src/components/ui';
import { fetchActivity } from '../../../src/api/apmApi';
import { useSession } from '../../../src/state/session';

interface ActivityEvent {
  id: string;
  event_type: string;
  actor_type: string;
  object_type?: string;
  object_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export default function ActivityScreen() {
  const { accessToken } = useSession();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!accessToken) return;
    let active = true;
    void fetchActivity(accessToken)
      .then((result) => { if (active) setEvents(result.events); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load APM activity.'); });
    return () => { active = false; };
  }, [accessToken]);

  return (
    <Screen
      eyebrow="APM Activity"
      title="See what APM did."
      subtitle="Consequential behavior is attributable, inspectable and auditable."
    >
      <Card tone="accent">
        <View style={uiStyles.row}><Pill tone="success">Live audit trail</Pill></View>
        <CardTitle>APM records consequential state and authority changes.</CardTitle>
        <Body muted>Private raw content is intentionally excluded from the activity timeline unless it is required for the event itself.</Body>
      </Card>

      {error ? <ErrorState message={error} /> : null}

      <SectionTitle>Activity timeline</SectionTitle>
      <View style={uiStyles.stack}>
        {events.length ? events.map((item) => (
          <Card key={item.id}>
            <KeyValue label={new Date(item.created_at).toLocaleString()} value={item.event_type} />
            <KeyValue label="Actor" value={item.actor_type} />
            {item.object_type ? <KeyValue label="Object" value={`${item.object_type}${item.object_id ? ` · ${item.object_id}` : ''}`} /> : null}
            {Object.keys(item.metadata ?? {}).length ? <Body muted>{JSON.stringify(item.metadata)}</Body> : null}
          </Card>
        )) : <Card><Body muted>No auditable activity has been recorded yet.</Body></Card>}
      </View>

      <Card>
        <CardTitle>What should appear here</CardTitle>
        <Body muted>Permission changes · integrations · mode changes · prepared/executed actions · important Life Graph changes · export/delete requests.</Body>
      </Card>
    </Screen>
  );
}
