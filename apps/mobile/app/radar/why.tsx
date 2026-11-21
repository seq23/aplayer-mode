import { router, useLocalSearchParams } from 'expo-router';
import {
  Body,
  Button,
  Card,
  CardTitle,
  Flow,
  KeyValue,
  Pill,
  Screen,
  SectionTitle,
} from '../../src/components/ui';
import { isFocusBlockTitle } from '../../src/integrations/accounts';
import { CalendarFlexibility } from '../../src/components/CalendarFlexibility';
import { useSession } from '../../src/state/session';
import { radarTag } from '../../src/content/words';
import { useLifeGraph } from '../../src/state/lifeGraph';

const reasonText: Record<string, string> = {
  'goal.no_open_next_action': 'The active goal has no open or scheduled next action.',
  'goal.deadline_near': 'The goal target date is within the Radar attention window.',
  'goal.deadline_overdue': 'The goal target date has passed without the goal being closed.',
  'goal.health_at_risk': 'The goal is explicitly marked at risk.',
  'calendar.overload': 'Three or more blocks add up to at least six busy hours.',
  'calendar.busy_overlap': 'Two busy calendar blocks overlap.',
  'email.reply_owed': 'An open request was identified in the connected inbox.',
  'goal.health_stalled': 'The goal is explicitly marked stalled.',
};

export default function RadarWhyScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { graph } = useLifeGraph();
  const { accessToken } = useSession();
  const item = graph.radarItems.find((candidate) => candidate.id === id);

  if (!item) {
    return (
      <Screen title="That Radar signal is no longer active.">
        <Card tone="muted">
          <Body muted>Something changed since, so APM no longer has a reason to show it.</Body>
        </Card>
        <Button label="Back to Radar" onPress={() => router.replace('/(tabs)/radar')} />
      </Screen>
    );
  }

  const suite = ['life_os', 'autopilot'].includes(graph.entitlement?.plan ?? '')
    && ['active', 'trialing'].includes(graph.entitlement?.status ?? '');
  const conflictEventIds = item.reasonCodes.includes('calendar.busy_overlap')
    ? item.id.slice('radar:calendar_conflict:'.length).split(':')
    : item.reasonCodes.includes('calendar.overload') ? item.sourceRefs.map((source) => source.sourceRef) : [];
  const eligible = graph.calendarEvents.filter((event) => conflictEventIds.includes(event.id)
    && Boolean(event.connectionId) && event.organizer.self === true && event.attendees.length === 0
    && !event.allDay && !event.deleted && !isFocusBlockTitle(event.title)
    && Date.parse(event.startsAt) > Date.now());
  const explanations = item.reasonCodes.map((code) => reasonText[code] ?? code);

  return (
    <Screen
      title={item.headline}
      subtitle={item.reasonCodes.includes('email.reply_owed')
        ? 'AI helped identify the request in your connected inbox.'
        : 'APM worked this out from what it already knows about you, with fixed rules. No AI model was involved.'}
    >
      <Card tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'default'}>
        <Pill tone={item.severity === 'critical' || item.severity === 'high' ? 'warning' : 'neutral'}>
          {radarTag(item.type, item.severity)}
        </Pill>
        <CardTitle>{item.summary}</CardTitle>
      </Card>

      <SectionTitle>How APM got here</SectionTitle>
      <Card>
        <Flow steps={explanations} />
      </Card>

      <SectionTitle>Sources</SectionTitle>
      <Card>
        {item.sourceRefs.map((source, index) => (
          <KeyValue
            key={`${source.sourceType}-${source.sourceRef ?? index}`}
            label={source.sourceType}
            value={source.label ?? source.sourceRef ?? 'What APM already knew'}
          />
        ))}
      </Card>

      {suite && accessToken && eligible.length > 0 ? <CalendarFlexibility events={eligible} accessToken={accessToken} /> : null}

      <SectionTitle>Signal confidence</SectionTitle>
      <Card>
        <KeyValue label="Confidence" value={`${Math.round(item.confidence * 100)}%`} />
        <KeyValue label="Reason rules" value={item.reasonCodes.join(', ')} />
      </Card>

      <Button label="Back to Radar" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}
